#!/usr/bin/env bash
# Merges a region's standalone contour-line tileset into its basemap
# .pmtiles via tile-join, and drops the Shortbread layers/attributes the app
# never draws, so the app downloads one lean vector file per country instead
# of two fat ones — see HikeAndWrite's `offline-maps-rearchitecture`
# decision (21.08.2026) for the merge, and the allowlist below for the
# filtering. Shortbread's basemap layers (`land`, `water_polygons`,
# `streets`, `boundaries`, ...) and the contours pipeline's own `contours`
# layer (`gdal_contour -a elev`) don't share a name, so tile-join just adds
# the second layer into whichever z/x/y tiles already exist on either side —
# no feature/geometry conflict.
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

# `versatiles convert` copies whole tiles and has no layer filter, so every
# Shortbread source-layer ends up in every download whether the app can draw
# it or not — including `addresses` (every house number in the country, z14),
# `buildings` (every footprint, z14) and `pois`. This tile-join pass was
# already running, so filtering here costs no extra step.
#
# An allowlist, not a denylist: if VersaTiles ever adds a layer to its planet
# build, a denylist would silently ship it. The list below is exactly what
# `hiking_map_style.dart` renders or queries, plus the label layers it will
# render once a bundled glyph set lands. Adding a layer to the style means
# adding it here too — and `test/recorded_track_map_test.dart` pins the
# style's source-layer set, so the two can't drift unnoticed.
#
# Deliberately absent: `addresses`, `buildings`, `pois`, `sites`,
# `public_transport`, `street_polygons`, `streets_polygons_labels`, `bridges`,
# `ferries`, `dam_lines`, `dam_polygons`, `pier_lines`, `pier_polygons`, and
# `street_labels_points` (point geometry carrying only
# `kind=motorway_junction` — motorway exit refs, meaningless on a hiking map).
keep_layers=(
  land ocean
  water_polygons water_polygons_labels water_lines water_lines_labels
  streets street_labels aerialways
  boundaries boundary_labels place_labels
  contours
)
# Attributes no layer we keep is ever styled or queried by. `name_de`/`name_en`
# sit on every label layer: local `name` is what a hiker reads, and the map has
# no language switch.
drop_attributes=(
  name_de name_en housename housenumber ref_rows ref_cols iata oneway_reverse
)

join_args=()
for layer in "${keep_layers[@]}"; do join_args+=(-l "$layer"); done
for attribute in "${drop_attributes[@]}"; do join_args+=(-x "$attribute"); done

# `tile-join` "doesn't have any of tippecanoe's recourses if the new tiles
# are bigger than the 500K tile limit" (its own README) — it just leaves an
# oversized tile out of the output entirely, whole tile, not a per-feature
# thinning. This step never passed `-pk`/`--no-tile-size-limit`, only the
# tippecanoe call that builds the contours-only file did (as
# `--no-tile-size-limit`/`--no-feature-limit`, which don't apply here at
# all — tile-join has its own separate flag parser).
#
# 22.08.2026: confirmed this is where the contour drop actually happens, by
# diagnosing both sides of this exact step on a real build. The
# contours-only tippecanoe output for one region held 824,949 kept features
# (dense, healthy); the merged output right after this tile-join call held
# 38,501 — a 95% loss introduced by this step alone, with the merged file's
# own `strategies` metadata an unchanged copy of the pre-merge file's (proof
# tile-join doesn't even recompute that accounting; it was never describing
# what tile-join itself does, only reporting what already happened before
# it ran).
join_args+=(--no-tile-size-limit)

basemap_bytes=$(stat -c%s "$basemap_path" 2>/dev/null || stat -f%z "$basemap_path")
contours_bytes=$(stat -c%s "$contours_path" 2>/dev/null || stat -f%z "$contours_path")

echo "== Merging basemap + contours: $name ($iso) =="
tile-join -f -o "$merged_path" "${join_args[@]}" "$basemap_path" "$contours_path"
mv "$merged_path" "$basemap_path"
# Not a separate release asset any more once merged — leaving it in dist/
# would get it picked up (and published) by the workflow's `dist/*.pmtiles`
# upload glob.
rm -f "$contours_path"

merged_bytes=$(stat -c%s "$basemap_path" 2>/dev/null || stat -f%z "$basemap_path")
echo "$iso.pmtiles (merged, filtered): $merged_bytes bytes" \
  "(basemap $basemap_bytes + contours $contours_bytes before filtering)"
