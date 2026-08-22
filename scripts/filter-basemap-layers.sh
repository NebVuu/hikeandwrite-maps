#!/usr/bin/env bash
# Drops the Shortbread layers/attributes the app never draws from a
# region's basemap, via `tile-join` on that single file — no contours
# merge here any more (see the 22.08.2026 note below).
#
# `versatiles convert` copies whole tiles and has no layer filter, so
# every Shortbread source-layer ends up in every download whether the
# app can draw it or not — including `addresses` (every house number
# in the country, z14), `buildings` (every footprint, z14) and `pois`.
#
# An allowlist, not a denylist: if VersaTiles ever adds a layer to its
# planet build, a denylist would silently ship it. The list below is
# exactly what `hiking_map_style.dart` renders or queries, plus the
# label layers it will render once a bundled glyph set lands. Adding a
# layer to the style means adding it here too — and
# `test/recorded_track_map_test.dart` pins the style's source-layer set,
# so the two can't drift unnoticed.
#
# Deliberately absent: `addresses`, `buildings`, `pois`, `sites`,
# `public_transport`, `street_polygons`, `streets_polygons_labels`,
# `bridges`, `ferries`, `dam_lines`, `dam_polygons`, `pier_lines`,
# `pier_polygons`, and `street_labels_points` (point geometry carrying
# only `kind=motorway_junction` — motorway exit refs, meaningless on a
# hiking map).
#
# 22.08.2026: this used to ALSO merge the region's contours tileset in
# via the same tile-join call (this script was named
# merge-basemap-contours.sh). That merge turned out to silently discard
# ~95% of the contour features on every real build tested — confirmed
# with a same-region, same-input A/B across four tile-join flag
# combinations (none of which changed the result), and consistent with
# an open, unresolved upstream bug in this exact tippecanoe fork merging
# PMTiles archives (felt/tippecanoe#278: crashes/corrupted-geometry
# errors on the same operation). Every mainstream hiking/outdoor map
# checked (Mapbox Outdoors, OpenAndroMaps) ships contours as their own
# tileset/source rather than merged into the basemap file, so this
# reverts to that same, better-supported shape — contours ship as their
# own `<ISO>_contours.pmtiles` (see build-contours.sh), downloaded
# alongside the basemap under the same single download action (see the
# app-side `offline-maps-rearchitecture` notes), not merged into it.
#
# Usage: scripts/filter-basemap-layers.sh regions/ba.yml
set -euo pipefail

region_file=$1
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dist_dir="$repo_root/dist"

iso=$(yq '.iso' "$region_file")
name=$(yq '.name' "$region_file")

basemap_path="$dist_dir/$iso.pmtiles"
filtered_path="$dist_dir/${iso}_filtered.pmtiles"

if [ ! -f "$basemap_path" ]; then
  echo "Missing $basemap_path — run scripts/build-region.sh $region_file first" >&2
  exit 1
fi

keep_layers=(
  land ocean
  water_polygons water_polygons_labels water_lines water_lines_labels
  streets street_labels aerialways
  boundaries boundary_labels place_labels
)
# `name_de`/`name_en` sit on every label layer: local `name` is what a
# hiker reads, and the map has no language switch.
drop_attributes=(
  name_de name_en housename housenumber ref_rows ref_cols iata oneway_reverse
)

join_args=()
for layer in "${keep_layers[@]}"; do join_args+=(-l "$layer"); done
for attribute in "${drop_attributes[@]}"; do join_args+=(-x "$attribute"); done

basemap_bytes=$(stat -c%s "$basemap_path" 2>/dev/null || stat -f%z "$basemap_path")

echo "== Filtering basemap layers: $name ($iso) =="
tile-join -f -o "$filtered_path" "${join_args[@]}" "$basemap_path"
mv "$filtered_path" "$basemap_path"

filtered_bytes=$(stat -c%s "$basemap_path" 2>/dev/null || stat -f%z "$basemap_path")
echo "$iso.pmtiles (filtered): $filtered_bytes bytes (was $basemap_bytes bytes)"
