#!/usr/bin/env bash
# Builds one country's offline basemap by extracting it directly from
# Protomaps' public, weekly-updated planet-wide PMTiles build — see
# HikeAndWrite's TASKS.md ("Offline mape") for why this replaced an earlier
# osmconvert-merge+Planetiler pipeline: extracting from a planet-wide
# source has no per-country OSM cut to begin with, so it can't reproduce
# the border multipolygon bug (#29) that pipeline existed to work around.
#
# Usage: scripts/build-region.sh regions/ba.yml
set -euo pipefail

region_file=$1
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_dir="$repo_root/build"
dist_dir="$repo_root/dist"

iso=$(yq '.iso' "$region_file")
name=$(yq '.name' "$region_file")
poly_url=$(yq '.geofabrik_poly_url' "$region_file")
maxzoom=$(yq '.maxzoom' "$region_file")

mkdir -p "$build_dir/boundaries" "$dist_dir"

echo "== $name ($iso) =="

poly_path="$build_dir/boundaries/$iso.poly"
geojson_path="$build_dir/boundaries/$iso.geojson"
curl -sf "$poly_url" -o "$poly_path"
node "$repo_root/scripts/poly2geojson.js" "$poly_path" > "$geojson_path"

# The planet build is dated (e.g. build.protomaps.com/20260818.pmtiles) and
# has no stable "latest" alias — retention is roughly the past week, so try
# today first and step backward a few days until one actually exists
# (verified 19.08.2026: today's and yesterday's date both resolved, three
# days back already 404'd).
planet_url=""
for days_back in 0 1 2 3 4 5 6; do
  candidate_date=$(date -u -d "-$days_back day" +%Y%m%d 2>/dev/null || date -u -v-"${days_back}"d +%Y%m%d)
  candidate_url="https://build.protomaps.com/$candidate_date.pmtiles"
  if curl -sfI "$candidate_url" >/dev/null; then
    planet_url=$candidate_url
    echo "Using planet build: $candidate_date"
    break
  fi
done
if [ -z "$planet_url" ]; then
  echo "No planet build found in the last 7 days at build.protomaps.com" >&2
  exit 1
fi

pmtiles extract "$planet_url" "$dist_dir/$iso.pmtiles" \
  --region="$geojson_path" \
  --maxzoom="$maxzoom"

echo "$iso.pmtiles: $(stat -c%s "$dist_dir/$iso.pmtiles" 2>/dev/null || stat -f%z "$dist_dir/$iso.pmtiles") bytes"
