#!/usr/bin/env bash
# Merges a region's standalone contour-line tileset into its basemap
# .pmtiles via tile-join, so the app downloads one vector file per country
# instead of two — see HikeAndWrite's `offline-maps-rearchitecture`
# decision (21.08.2026). Shortbread's basemap layers (`land`,
# `water_polygons`, `streets`, `boundaries`, `buildings`, ...) and the
# contours pipeline's own `contours` layer (`gdal_contour -a elev`) don't
# share a name, so tile-join just adds the second layer into whichever
# z/x/y tiles already exist on either side — no feature/geometry conflict.
#
# The merged output keeps the basemap's own filename (`<ISO>.pmtiles`) —
# deliberately not a new name, so the app's existing per-country download
# path needs no new file to know about, just a fatter one.
#
# Requires build-region.sh and build-contours.sh to have already produced
# this region's dist/<ISO>.pmtiles and dist/<ISO>_contours.pmtiles.
#
# Usage: scripts/merge-basemap-contours.sh regions/ba.yml
set -euo pipefail

region_file=$1
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dist_dir="$repo_root/dist"

iso=$(yq '.iso' "$region_file")
name=$(yq '.name' "$region_file")

basemap_path="$dist_dir/$iso.pmtiles"
contours_path="$dist_dir/${iso}_contours.pmtiles"
merged_path="$dist_dir/${iso}_merged.pmtiles"

if [ ! -f "$basemap_path" ]; then
  echo "Missing $basemap_path — run scripts/build-region.sh $region_file first" >&2
  exit 1
fi
if [ ! -f "$contours_path" ]; then
  echo "Missing $contours_path — run scripts/build-contours.sh $region_file first" >&2
  exit 1
fi

echo "== Merging basemap + contours: $name ($iso) =="
tile-join -f -o "$merged_path" "$basemap_path" "$contours_path"
mv "$merged_path" "$basemap_path"
# Not a separate release asset any more once merged — leaving it in dist/
# would get it picked up (and published) by the workflow's `dist/*.pmtiles`
# upload glob.
rm -f "$contours_path"

echo "$iso.pmtiles (merged): $(stat -c%s "$basemap_path" 2>/dev/null || stat -f%z "$basemap_path") bytes"
