#!/usr/bin/env bash
# INVESTIGATION ONLY — not part of the normal build, never runs on `main`.
#
# Runs tile-join twice against the exact same basemap+contours pair, once
# with `--no-tile-size-limit` and once without, so the two outputs differ
# by exactly one flag and nothing else — same region, same inputs, same CI
# job. This exists because the first real test of that flag (22.08.2026,
# ME region) showed the merged file still losing ~95% of its contour
# features WITH the flag applied, matching the ~95% loss measured on a
# DIFFERENT region (HR) WITHOUT it — too close a match to trust as a real
# improvement without a same-region comparison, and a full CI round trip
# per comparison is ~10 minutes even scoped to one region.
#
# Usage: scripts/ab-test-tile-join.sh <basemap.pmtiles> <contours.pmtiles> <output-dir>
set -euo pipefail

basemap_path=$1
contours_path=$2
output_dir=$3
mkdir -p "$output_dir"

# Mirrors merge-basemap-contours.sh's keep_layers/drop_attributes exactly —
# duplicated here deliberately rather than sourced, since this script is
# throwaway (investigation branch only, never reaches main) and sourcing
# would risk silently changing behaviour if that script's arrays are ever
# edited independently.
keep_layers=(
  land ocean
  water_polygons water_polygons_labels water_lines water_lines_labels
  streets street_labels aerialways
  boundaries boundary_labels place_labels
  contours
)
drop_attributes=(
  name_de name_en housename housenumber ref_rows ref_cols iata oneway_reverse
)

join_args=()
for layer in "${keep_layers[@]}"; do join_args+=(-l "$layer"); done
for attribute in "${drop_attributes[@]}"; do join_args+=(-x "$attribute"); done

echo "== A/B: without --no-tile-size-limit =="
tile-join -f -o "$output_dir/without-fix.pmtiles" "${join_args[@]}" \
  "$basemap_path" "$contours_path"

echo "== A/B: with --no-tile-size-limit =="
tile-join -f -o "$output_dir/with-fix.pmtiles" "${join_args[@]}" \
  --no-tile-size-limit \
  "$basemap_path" "$contours_path"

# `--no-feature-limit`'s tile-join support is unconfirmed (tippecanoe's own
# README summary contradicted itself on this — said tile-join accepts no
# dropping-related flags at all in one place, then documented `-pk` for it
# in another). Non-fatal: an unrecognized flag must not take down the two
# invocations above with it under `set -e`.
echo "== A/B: with --no-tile-size-limit --no-feature-limit =="
tile-join -f -o "$output_dir/with-fix-both.pmtiles" "${join_args[@]}" \
  --no-tile-size-limit --no-feature-limit \
  "$basemap_path" "$contours_path" \
  || echo "  (failed, exit $? — --no-feature-limit may not be a real tile-join flag)"

# 22.08.2026: the first two variants above came back IDENTICAL (same
# feature count, byte size within 2 bytes) — `--no-tile-size-limit` changes
# nothing. So the ~95% contour loss during merge isn't the byte-size-limit
# mechanism at all. Next question: is it the `-l`/`-x` layer/attribute
# filtering we pass, or something inherent to tile-join's merge regardless
# of flags? A bare merge with no filtering at all answers that in one
# step — if this ALSO collapses to the same reduced count, the loss is
# structural to tile-join's merge itself, not caused by anything this
# pipeline is asking it to do.
echo "== A/B: bare merge, no -l/-x filtering at all =="
tile-join -f -o "$output_dir/bare-merge.pmtiles" \
  "$basemap_path" "$contours_path"
