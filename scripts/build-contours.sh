#!/usr/bin/env bash
# Builds one country's contour-line vector tiles (20m interval, matching
# TASKS.md's hiking-app research recommendation) from Copernicus GLO-30 DEM
# data — the same free source Mapterhorn's hillshade already uses outside
# Switzerland. Contour LINES were untried until now; the hypothesis (see
# TASKS.md, "Hillshade + konture") is that they read crisply even from
# this 30m source, unlike raster hillshade shading, which looked blurry on
# Bosnia's steep, forested terrain regardless of style tuning.
#
# First real CI run (19.08.2026) worked end-to-end and produced a valid
# BA_contours.pmtiles (confirmed via pmtiles show against the published
# release — correct bounds, real tile entries) but at 285MB, roughly the
# whole basemap's size for a single-attribute line layer. The simplify +
# per-feature-minzoom tiering + lower maxzoom below are the fix for that;
# not yet re-verified in CI (this machine still has no GDAL/tippecanoe to
# test locally) — watch the next run's output size closely.
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
done < <(node "$repo_root/scripts/dem-tiles.js" "$geojson_path")

if [ ${#tile_files[@]} -eq 0 ]; then
  echo "No DEM tiles found for $iso" >&2
  exit 1
fi
echo "Downloaded ${#tile_files[@]} DEM tiles"

vrt_path="$dem_dir/merged.vrt"
gdalbuildvrt -overwrite "$vrt_path" "${tile_files[@]}"

# Clip to the country's exact boundary before contouring, same idea as the
# basemap's own --region clip — otherwise contours would extend into
# neighboring countries out to the tiles' rectangular edges.
clipped_path="$dem_dir/clipped.tif"
gdalwarp -overwrite -cutline "$geojson_path" -crop_to_cutline -dstnodata -9999 \
  "$vrt_path" "$clipped_path"

contours_geojson="$dem_dir/contours.geojson"
gdal_contour -a elev -i "$contour_interval_m" -f GeoJSON "$clipped_path" "$contours_geojson"

# Raw gdal_contour output carries a vertex roughly every ~30m (the DEM's
# own grid spacing) along the entire length of every line — meaningless
# detail below what a 30m DEM can even represent, but it's still real
# bytes. ~0.0002 degrees (~20m at this latitude) removes that noise
# without visibly changing the line at any zoom this pmtiles is actually
# served at. Confirmed present in this GDAL build (3.8.4 on Ubuntu
# noble; -simplify landed in GDAL 3.4).
simplified_geojson="$dem_dir/contours_simplified.geojson"
ogr2ogr -f GeoJSON -simplify 0.0002 "$simplified_geojson" "$contours_geojson"

# Per-feature minzoom (see contour-tiers.js) — this is the bigger size
# lever: without it, every 20m line rendered at every zoom, which is most
# of why the first real build (BA) came out at 285MB, comparable to the
# whole basemap, for a single-attribute line layer.
tiered_geojson="$dem_dir/contours_tiered.geojson"
node "$repo_root/scripts/contour-tiers.js" "$simplified_geojson" > "$tiered_geojson"

# maxzoom 13, not the basemap's 15 (_offlineMapMaxZoom in
# recorded_track_map.dart) — a 20m interval already exceeds what's useful
# at basemap-level street zoom, and z13 is still finer than the 30m DEM's
# real resolution.
tippecanoe \
  --output="$dist_dir/${iso}_contours.pmtiles" \
  --layer=contours \
  --minimum-zoom=11 \
  --maximum-zoom=13 \
  --simplification=10 \
  --drop-densest-as-needed \
  --force \
  "$tiered_geojson"

echo "${iso}_contours.pmtiles: $(stat -c%s "$dist_dir/${iso}_contours.pmtiles" 2>/dev/null || stat -f%z "$dist_dir/${iso}_contours.pmtiles") bytes"
