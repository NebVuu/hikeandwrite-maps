#!/usr/bin/env bash
# Builds ONE shared hillshade extract covering every supported region,
# replacing the old per-country `<ISO>_hillshade.pmtiles` (see git history
# for that version) — the same Copernicus GLO-30 DEM underlies every
# country's terrain regardless of border, so duplicating a ~300MB raster
# file per country bought nothing but disk space. The app downloads this
# once, ever, the first time any country is added (see HikeAndWrite's
# `offline-maps-rearchitecture` decision, 21.08.2026).
#
# maxzoom 10, not the original per-country 12 (or the 21.08.2026 first
# regional pass at 11): the whole-region archive at z11 measured 850MB —
# confirmed too slow/heavy on a real device (multi-minute download,
# FileSystemException from an interrupted stream) — and go-pmtiles'
# --dry-run against Mapterhorn's own source measured the actual tradeoff
# directly rather than guessing: z12=2.1GB, z11=850MB, z10=308MB, z9=107MB.
# z10 trades real visible softness at close hiking zoom (12-16, where this
# overzooms more than z11 did) for a ~2.75x smaller one-time download —
# accepted since contours (10m interval) carry the primary terrain-reading
# detail in the app's style; hillshade is explicitly a soft base under them,
# not the main event. Those numbers predate the mask below, which cuts the
# extracted footprint to 60% — so re-measure with `--dry-run` before deciding
# whether z11 has become affordable again.
#
# Requires build-region.sh to have already produced EVERY region's boundary
# GeoJSON (build/boundaries/<ISO>.geojson) — region-mask.js unions all of them
# into one tile-aligned mask. This used to be a single rectangular bbox on the
# grounds that a raster relief layer doesn't need the real border shape; true,
# but it isn't about precision — the rectangle simply cost twice as much as
# the shape it was approximating (see the numbers at the extract below).
#
# Usage: scripts/build-hillshade-regional.sh regions/*.yml
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_dir="$repo_root/build"
dist_dir="$repo_root/dist"
hillshade_maxzoom=10
# One tile wider than the per-region masks (build-region.sh uses the default
# 3): relief only has to reach at least as far as the basemap does, so that
# no shaded edge appears inside ground the user can actually see. 4 z13 tiles
# is ~13.8 km against the basemap's ~10.4 km. This replaces the old
# `border_pad_deg=0.3` bbox pad, which was solving the same problem far more
# expensively.
mask_dilate=4
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
# A single bbox over five countries was half wasted: measured, the union bbox
# covered 547,607 km² against 275,707 km² of actual boundary area, so about
# half of every byte downloaded was Adriatic and foreign territory. The
# tile-aligned union mask covers 328,425 km² — 60% of that bbox — for the same
# real coverage. (`scripts/union-bbox.js` is now unused; region-mask.js unions
# its inputs itself.)
mask_path="$build_dir/masks/hillshade.geojson"
mkdir -p "$build_dir/masks"
node "$repo_root/scripts/region-mask.js" --dilate="$mask_dilate" \
  "${geojson_paths[@]}" > "$mask_path"

pmtiles extract "$mapterhorn_url" "$dist_dir/hillshade.pmtiles" \
  --region="$mask_path" \
  --maxzoom="$hillshade_maxzoom"

echo "hillshade.pmtiles: $(stat -c%s "$dist_dir/hillshade.pmtiles" 2>/dev/null || stat -f%z "$dist_dir/hillshade.pmtiles") bytes"
