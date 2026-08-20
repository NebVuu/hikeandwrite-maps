#!/usr/bin/env bash
# Builds one country's hillshade extract — a raster-dem, Terrarium-encoded
# `.pmtiles` source, same format `hiking_map_style.dart`'s `hillshade-dem`
# source already expects. Mapterhorn publishes its whole Copernicus GLO-30
# terrain dataset as one static planet-wide PMTiles archive
# (download.mapterhorn.com/planet.pmtiles, confirmed via Protomaps' own
# Mapterhorn writeup and Mapterhorn's own `pmtiles extract --bbox=...`
# usage example) — so this is the exact same "extract a bbox over HTTP
# range requests" pattern as build-region.sh's basemap step, just pointed
# at Mapterhorn's endpoint instead of VersaTiles'. No DEM download, no
# `gdaldem`/GDAL MBTiles bake, no separate `pmtiles convert` step: the
# extract IS the finished, already-Terrarium-encoded output.
#
# (An earlier, since-abandoned version of this script self-baked a plain
# grayscale relief PNG from raw Copernicus DEM tiles via `gdaldem hillshade`
# — dropped because it bakes exaggeration/illumination-direction at build
# time, losing the on-device tunability `HillshadeDebugVariant` in
# `hiking_map_style.dart` already relies on, and can't reproduce that
# style's per-theme shadow/highlight *colors* the way a plain grayscale
# raster's brightness/contrast paint properties can.)
#
# Mapterhorn's real data only goes to z12 outside Switzerland (higher zooms
# 404) — confirmed during the earlier on-device hillshade investigation
# (TASKS.md, "Hillshade (teren)"), so z12 is this extract's ceiling, well
# below the basemap's own maxzoom.
#
# Requires build-region.sh to have already produced this region's boundary
# GeoJSON (build/boundaries/<ISO>.geojson).
#
# Usage: scripts/build-hillshade.sh regions/ba.yml
set -euo pipefail

region_file=$1
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_dir="$repo_root/build"
dist_dir="$repo_root/dist"
hillshade_maxzoom=12
# Matches build-region.sh's/build-contours.sh's border_pad_deg — hillshade
# should cover the same ground as the basemap/contours near a border.
border_pad_deg=0.1
mapterhorn_url="https://download.mapterhorn.com/planet.pmtiles"

iso=$(yq '.iso' "$region_file")
name=$(yq '.name' "$region_file")

echo "== Hillshade: $name ($iso) =="

geojson_path="$build_dir/boundaries/$iso.geojson"
if [ ! -f "$geojson_path" ]; then
  echo "Missing $geojson_path — run scripts/build-region.sh $region_file first" >&2
  exit 1
fi

mkdir -p "$dist_dir"

bbox=$(node "$repo_root/scripts/region-bbox.js" "$geojson_path" "$border_pad_deg")
pmtiles extract "$mapterhorn_url" "$dist_dir/${iso}_hillshade.pmtiles" \
  --bbox="$bbox" \
  --maxzoom="$hillshade_maxzoom"

echo "${iso}_hillshade.pmtiles: $(stat -c%s "$dist_dir/${iso}_hillshade.pmtiles" 2>/dev/null || stat -f%z "$dist_dir/${iso}_hillshade.pmtiles") bytes"
