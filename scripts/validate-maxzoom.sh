#!/usr/bin/env bash
# Fails the build if a region's published basemap doesn't actually have
# data at the max_zoom its regions/<iso>.yml asked for.
#
# 21.08.2026 incident this exists to catch: regions/*.yml requested
# maxzoom 16 for every country, and versatiles convert (build-region.sh)
# happily accepted that flag and produced valid-looking .pmtiles files —
# but VersaTiles' own `osm.versatiles` planet build turned out to only be
# built to z14 itself, so `--max-zoom=16` was a silent no-op ceiling, not
# a guarantee of real tiles. This was only caught by manually reading
# each published file's PMTiles header over an HTTP range request after
# the fact (see TASKS.md, "Offline mape", 21.08.2026 entry). Reading the
# same header field here, right after the build, turns that into an
# immediate CI failure instead.
#
# Requires build-region.sh and scripts/filter-basemap-layers.sh to have
# already produced dist/<ISO>.pmtiles for every region checked — run this
# after both, before Build manifest/Publish release.
#
# Usage: scripts/validate-maxzoom.sh regions/*.yml
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dist_dir="$repo_root/dist"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 regions/*.yml" >&2
  exit 1
fi

failed=0
for region_file in "$@"; do
  iso=$(yq '.iso' "$region_file")
  name=$(yq '.name' "$region_file")
  expected=$(yq '.maxzoom' "$region_file")
  pmtiles_path="$dist_dir/$iso.pmtiles"

  if [ ! -f "$pmtiles_path" ]; then
    echo "Missing $pmtiles_path — run build-region.sh and filter-basemap-layers.sh for $region_file first" >&2
    exit 1
  fi

  actual=$(node "$repo_root/scripts/read-pmtiles-maxzoom.js" "$pmtiles_path")
  if [ "$actual" != "$expected" ]; then
    echo "MAXZOOM MISMATCH: $name ($iso) — regions/$iso.yml asks for maxzoom=$expected but $pmtiles_path's own header says max_zoom=$actual" >&2
    failed=1
  else
    echo "$name ($iso): max_zoom $actual matches regions/$iso.yml"
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "" >&2
  echo "One or more regions built with a max_zoom below what regions/*.yml asked for." >&2
  echo "This usually means the upstream source (VersaTiles planet build) doesn't" >&2
  echo "actually have data at the requested zoom yet — lower the affected" >&2
  echo "regions/<iso>.yml's maxzoom to match reality rather than re-running the build." >&2
  exit 1
fi
