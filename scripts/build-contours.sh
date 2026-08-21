#!/usr/bin/env bash
# Builds one country's contour-line vector tiles from Copernicus GLO-30 DEM
# data — the same free source Mapterhorn's hillshade already uses outside
# Switzerland. Contours carry most of the terrain-reading job in the app's
# style, since raster hillshade looked blurry on Bosnia's steep, forested
# terrain regardless of style tuning (see TASKS.md, "Hillshade + konture").
#
# First real CI run (19.08.2026) worked end-to-end and produced a valid
# BA_contours.pmtiles (confirmed via pmtiles show against the published
# release — correct bounds, real tile entries) but at 285MB, roughly the
# whole basemap's size for a single-attribute line layer. The simplify +
# per-feature-minzoom tiering below cut that to 2.6MB.
#
# 20.08.2026: interval 20m -> 10m and maxzoom 13 -> 14, after on-device
# testing showed contours reading as too sparse.
#
# 21.08.2026: back to 20m, because that sparseness was never the interval.
# Tippecanoe's default drop rate was discarding 97.8% of the lines at every
# zoom (see the tippecanoe call below for the measured numbers), so halving
# the interval only doubled the input to a mechanism that threw away the
# same fraction. With the drop rate off, 20m ships every line it generates
# and is far denser than 10m ever was in practice.
#
# 20m is also the honest limit of the source: a 10m interval on a
# 30m-resolution DEM is finer than the elevation samples can justify, so
# those extra lines carry interpolation wobble rather than real terrain, and
# it matches what OpenAndroMaps and its users settled on for hiking maps
# (see TASKS.md, "Istraženo — šta koriste popularne hiking app-e").
#
# Requires build-region.sh to have already produced this region's
# boundary GeoJSON (build/boundaries/<ISO>.geojson).
#
# Usage: scripts/build-contours.sh regions/ba.yml
set -euo pipefail

region_file=$1
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_dir="$repo_root/build"
dist_dir="$repo_root/dist"
contour_interval_m=20
# Matches build-region.sh's border_pad_deg — same reasoning, applied here so
# contour lines and the basemap agree on how far past the border to cover.
border_pad_deg=0.1

iso=$(yq '.iso' "$region_file")
name=$(yq '.name' "$region_file")

echo "== Contours: $name ($iso), ${contour_interval_m}m interval =="

geojson_path="$build_dir/boundaries/$iso.geojson"
if [ ! -f "$geojson_path" ]; then
  echo "Missing $geojson_path — run scripts/build-region.sh $region_file first" >&2
  exit 1
fi

dem_dir="$build_dir/dem/$iso"
mkdir -p "$dem_dir" "$dist_dir"

echo "Downloading Copernicus GLO-30 DEM tiles..."
tile_files=()
while IFS= read -r url; do
  tif="$dem_dir/$(basename "$(dirname "$url")").tif"
  if [ ! -f "$tif" ]; then
    if ! curl -sf "$url" -o "$tif"; then
      echo "  (no DEM tile at $url, skipping — likely all-sea or off the real coverage edge)"
      rm -f "$tif"
      continue
    fi
  fi
  tile_files+=("$tif")
done < <(node "$repo_root/scripts/dem-tiles.js" "$geojson_path" "$border_pad_deg")

if [ ${#tile_files[@]} -eq 0 ]; then
  echo "No DEM tiles found for $iso" >&2
  exit 1
fi
echo "Downloaded ${#tile_files[@]} DEM tiles"

vrt_path="$dem_dir/merged.vrt"
gdalbuildvrt -overwrite "$vrt_path" "${tile_files[@]}"

# Crop to a padded bbox around the country, not its exact boundary — same
# fix as build-region.sh's basemap extract (19.08.2026: a strict cutline
# right at the administrative border drops everything past it, even one
# step past, which hollows out any border-ridge peak or trail — e.g.
# Maglić, whose summit sits ON the BA/Montenegro line). `-te` here uses the
# same padded bbox so contour lines don't stop at the border while the
# basemap keeps going past it.
clipped_path="$dem_dir/clipped.tif"
bbox=$(node "$repo_root/scripts/region-bbox.js" "$geojson_path" "$border_pad_deg")
IFS=',' read -r bbox_minlon bbox_minlat bbox_maxlon bbox_maxlat <<< "$bbox"
# `-cutline` against the same tile-aligned mask the basemap extract uses
# (build-region.sh, scripts/region-mask.js) on top of the padded `-te` extent.
# The 19.08.2026 objection to a cutline was about cutting on the
# administrative border itself; this mask is already padded ~10.4 km past it,
# so it keeps the Maglić fix while dropping the 35-50% of the rectangle that
# isn't this country. That matters here more than anywhere: "Build contours"
# is the pipeline's slowest step by far (64 min for five regions), and every
# hectare cut here is contour lines never generated, simplified, tiered or
# tiled. If `-cutline` ever silently no-ops, the failure mode is simply
# today's behaviour plus the tile-level clip below.
mask_path="$build_dir/masks/$iso.geojson"
if [ ! -f "$mask_path" ]; then
  echo "Missing $mask_path — run scripts/build-region.sh $region_file first" >&2
  exit 1
fi
gdalwarp -overwrite -te "$bbox_minlon" "$bbox_minlat" "$bbox_maxlon" "$bbox_maxlat" \
  -cutline "$mask_path" \
  -dstnodata -9999 "$vrt_path" "$clipped_path"

contours_geojson="$dem_dir/contours.geojson"
gdal_contour -a elev -i "$contour_interval_m" -f GeoJSON "$clipped_path" "$contours_geojson"

# Raw gdal_contour output carries a vertex roughly every ~30m (the DEM's
# own grid spacing) along the entire length of every line — meaningless
# detail below what a 30m DEM can even represent, but it's still real
# bytes. ~0.0002 degrees (~20m at this latitude) removes that noise
# without visibly changing the line at any zoom this pmtiles is actually
# served at. Confirmed present in this GDAL build (3.8.4 on Ubuntu
# noble; -simplify landed in GDAL 3.4).
#
# Output is GeoJSONSeq (one feature per line), not a single
# FeatureCollection, so the tiering step below can stream it. See
# contour-tiers.js: reading a whole FeatureCollection is what broke CI run
# #8 once the interval halved (ERR_STRING_TOO_LONG — V8 caps strings at
# ~512MB, so that approach had a hard ceiling no amount of RAM could lift).
simplified_geojson="$dem_dir/contours_simplified.geojsonl"
ogr2ogr -f GeoJSONSeq -simplify 0.0002 "$simplified_geojson" "$contours_geojson"
echo "simplified contours: $(du -h "$simplified_geojson" | cut -f1)"
# The raw pre-simplify file is the largest thing this script produces and
# nothing downstream reads it again. A GitHub runner only has ~14GB free
# and dist/ already holds every region's basemap by the time this runs, so
# dropping it here is what keeps a fine interval from turning into a
# disk-space failure instead of a memory one.
rm -f "$contours_geojson"

# Per-feature minzoom (see contour-tiers.js) — this is the bigger size
# lever: without it, every line renders at every zoom, which is most of why
# the first real build (BA) came out at 285MB, comparable to the whole
# basemap, for a single-attribute line layer.
tiered_geojson="$dem_dir/contours_tiered.geojsonl"
node "$repo_root/scripts/contour-tiers.js" "$simplified_geojson" > "$tiered_geojson"
echo "tiered contours: $(du -h "$tiered_geojson" | cut -f1)"

# maxzoom 14 matches the basemap's own ceiling (_offlineMapMaxZoom in
# recorded_track_map.dart), so the deepest zoom a user can reach still has
# real contour tiles rather than an overzoomed z13 stretch.
#
# `--drop-rate=1` is the load-bearing flag here, and its absence is why
# contours have never actually been visible on-device.
#
# `-pf`/`-pk` (--no-feature-limit / --no-tile-size-limit) were added
# 20.08.2026 in place of `--drop-densest-as-needed`, on the understanding
# that they stopped tippecanoe thinning the output. They don't: they lift the
# per-tile feature-count and byte-size *limits*, while tippecanoe's drop rate
# is a separate mechanism that is on by default and applies regardless.
#
# The published archive's own metadata records what it cost (21.08.2026,
# read back out of BA.pmtiles' tilestats `strategies`): 86,596 features
# dropped at z11, 161,236 at z12, 553,073 at z13 and 1,359,343 at z14 —
# against 30,520 kept. Roughly 1.39M contour lines generated, 2.2% shipped,
# about 1.8 lines per z14 tile. That is why they read as "too sparse" on
# 20.08 and as absent on 21.08, and why halving the interval from 20m to 10m
# didn't help: more input, same fraction discarded. It is also what the
# 285MB → 2.6MB "size win" of 19.08 actually was.
#
# The per-feature minzoom tiering above (contour-tiers.js) is the intended
# size lever, because it thins by elevation significance rather than by
# whichever tile happens to be busiest — steep terrain, i.e. exactly where a
# hiker needs lines, is the densest and so the first to be thinned by any
# rate-based drop. Watch the output size below: nothing is silently
# discarding features any more, so if a region comes out unreasonably large,
# tighten the tiering or widen `contour_interval_m` rather than restoring a
# drop.
#
# `-x ID` drops gdal_contour's sequential feature id, which is carried on
# every line and read by nothing (the style only uses `elev`).
tippecanoe \
  --output="$dist_dir/${iso}_contours.pmtiles" \
  --layer=contours \
  --minimum-zoom=11 \
  --maximum-zoom=14 \
  --simplification=10 \
  --drop-rate=1 \
  --no-feature-limit \
  --no-tile-size-limit \
  --exclude=ID \
  --force \
  "$tiered_geojson"

# The cutline above already keeps contour *lines* inside the mask, but
# tippecanoe still writes whichever tiles those lines touch, so the tileset's
# own bounds can reach a little past it. Clipping the tiles too keeps this
# tileset's footprint identical to the basemap's, which matters because
# tile-join unions its inputs' bounds and the app reads the merged archive's
# header to place `cameraTargetBounds` and the `coverage-mask` layer.
contours_clipped="$dist_dir/${iso}_contours_clipped.pmtiles"
if ! pmtiles extract "$dist_dir/${iso}_contours.pmtiles" "$contours_clipped" \
  --region="$mask_path"; then
  echo "  extract failed — clustering the archive and retrying"
  pmtiles cluster "$dist_dir/${iso}_contours.pmtiles"
  pmtiles extract "$dist_dir/${iso}_contours.pmtiles" "$contours_clipped" \
    --region="$mask_path"
fi
mv "$contours_clipped" "$dist_dir/${iso}_contours.pmtiles"

echo "${iso}_contours.pmtiles: $(stat -c%s "$dist_dir/${iso}_contours.pmtiles" 2>/dev/null || stat -f%z "$dist_dir/${iso}_contours.pmtiles") bytes"
