#!/usr/bin/env bash
# Builds ONE shared hillshade extract covering every supported region,
# replacing the old per-country `<ISO>_hillshade.pmtiles` (see git history
# for that version) — the same Copernicus GLO-30 DEM underlies every
# country's terrain regardless of border, so duplicating a ~300MB raster
# file per country bought nothing but disk space. The app downloads this
# once, ever, the first time any country is added (see HikeAndWrite's
# `offline-maps-rearchitecture` decision, 21.08.2026).
#
# maxzoom 11, not the old per-country 12: Mapterhorn's real Copernicus
# GLO-30 data is ~30m resolution outside Switzerland, which z12 already
# exceeds (confirmed during the earlier on-device hillshade investigation —
# `hiking_map_style.dart` used to fade its exaggeration to near-zero above
# z12 specifically because overzoomed z12 tiles read as a blurry, colorless
# blob). Capping one zoom level lower loses no real detail while cutting
# tile count roughly 4x at the deepest, dominant zoom level of the pyramid.
#
# Requires build-region.sh to have already produced EVERY region's boundary
# GeoJSON (build/boundaries/<ISO>.geojson) — this unions all of them into
# one bbox via union-bbox.js rather than a real polygon union, since a
# rectangular superset is precise enough for a raster relief layer (unlike
# the basemap's coverage-mask, which does need the real border shape).
#
# Usage: scripts/build-hillshade-regional.sh regions/*.yml
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_dir="$repo_root/build"
dist_dir="$repo_root/dist"
hillshade_maxzoom=11
# Wider than the per-region 0.1 (build-region.sh/build-contours.sh) since
# this only needs to avoid a visible edge at the outermost supported
# countries' own borders, not agree tile-for-tile with any one country's
# basemap extract the way the old per-country hillshade did.
border_pad_deg=0.3
mapterhorn_url="https://download.mapterhorn.com/planet.pmtiles"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 regions/*.yml" >&2
  exit 1
fi

geojson_paths=()
for region_file in "$@"; do
  iso=$(yq '.iso' "$region_file")
  geojson_path="$build_dir/boundaries/$iso.geojson"
  if [ ! -f "$geojson_path" ]; then
    echo "Missing $geojson_path — run scripts/build-region.sh $region_file first" >&2
    exit 1
  fi
  geojson_paths+=("$geojson_path")
done

mkdir -p "$dist_dir"

echo "== Regional hillshade (${#geojson_paths[@]} regions) =="
bbox=$(node "$repo_root/scripts/union-bbox.js" "$border_pad_deg" "${geojson_paths[@]}")
pmtiles extract "$mapterhorn_url" "$dist_dir/hillshade.pmtiles" \
  --bbox="$bbox" \
  --maxzoom="$hillshade_maxzoom"

echo "hillshade.pmtiles: $(stat -c%s "$dist_dir/hillshade.pmtiles" 2>/dev/null || stat -f%z "$dist_dir/hillshade.pmtiles") bytes"
