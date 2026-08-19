#!/usr/bin/env bash
# Builds one country's contour-line vector tiles (20m interval, matching
# TASKS.md's hiking-app research recommendation) from Copernicus GLO-30 DEM
# data — the same free source Mapterhorn's hillshade already uses outside
# Switzerland. Contour LINES were untried until now; the hypothesis (see
# TASKS.md, "Hillshade + konture") is that they read crisply even from
# this 30m source, unlike raster hillshade shading, which looked blurry on
# Bosnia's steep, forested terrain regardless of style tuning.
#
# UNTESTED as of writing — this machine has no GDAL/tippecanoe (see
# TASKS.md), so this has only been checked piece by piece: the DEM tile
# URLs (scripts/dem-tiles.js) were verified against the real bucket, but
# the gdalwarp/gdal_contour/tippecanoe chain itself has not actually run
# end-to-end anywhere yet. First real run should be in CI
# (.github/workflows/build-maps.yml) or on a machine with these tools
# installed — watch it closely the first time.
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

# minzoom 11: contour lines are visual noise zoomed further out than that;
# maxzoom 15 matches the basemap's own maxzoom (see recorded_track_map.dart,
# _offlineMapMaxZoom) so neither layer overzooms before the other.
tippecanoe \
  --output="$dist_dir/${iso}_contours.pmtiles" \
  --layer=contours \
  --minimum-zoom=11 \
  --maximum-zoom=15 \
  --drop-densest-as-needed \
  --force \
  "$contours_geojson"

echo "${iso}_contours.pmtiles: $(stat -c%s "$dist_dir/${iso}_contours.pmtiles" 2>/dev/null || stat -f%z "$dist_dir/${iso}_contours.pmtiles") bytes"
