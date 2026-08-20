#!/usr/bin/env bash
# Builds one country's offline basemap by extracting it directly from
# VersaTiles' public planet-wide Shortbread build — see HikeAndWrite's
# TASKS.md ("Offline mape") for the 19.08.2026 schema pivot: Shortbread
# replaces Protomaps' basemap schema for a minimal outdoor look (forest/
# meadow/water/discreet roads instead of a generic city map). Same
# "extract from an uncut planet-wide source" principle as the Protomaps-era
# pipeline this replaces — no per-country OSM cut to begin with, so it
# can't reproduce the border multipolygon bug (#29) that motivated that
# principle in the first place. `versatiles convert` reads its remote input
# over HTTP byte-range requests the same way `pmtiles extract` did
# (confirmed in versatiles-rs' own `DataReaderHttp`/`convert.rs` source,
# not just docs) — this still never downloads VersaTiles' ~60GB+ planet
# file, only the tiles inside the requested bbox.
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
# ~8-11km at these latitudes — matched by build-contours.sh so a country's
# basemap and contour extracts cover the same ground near its border.
# Kept as a plain bbox pad (not `versatiles convert`'s own `--bbox-border`
# tile-count option) specifically so this stays the exact same,
# already-verified-against-Maglić padding the Protomaps-era pipeline used —
# switching to a tile-count border would mean re-deriving and re-verifying
# an equivalent margin instead of reusing a proven one.
border_pad_deg=0.1

mkdir -p "$build_dir/boundaries" "$dist_dir"

echo "== $name ($iso) =="

poly_path="$build_dir/boundaries/$iso.poly"
geojson_path="$build_dir/boundaries/$iso.geojson"
curl -sf "$poly_url" -o "$poly_path"
node "$repo_root/scripts/poly2geojson.js" "$poly_path" > "$geojson_path"

# Unlike Protomaps' build.protomaps.com (dated files only, no stable
# alias, forcing the old version of this script to probe backward through
# the past week), VersaTiles publishes a standing `osm.versatiles` alias
# that always resolves to its current planet-wide Shortbread build
# (confirmed 19.08.2026 at download.versatiles.org — size matches the
# latest dated `osm.<YYYYMMDD>.versatiles` file). A dated file remains the
# fallback if this alias is ever retired.
planet_url="https://download.versatiles.org/osm.versatiles"
if ! curl -sfI "$planet_url" >/dev/null; then
  echo "VersaTiles planet build not reachable at $planet_url" >&2
  exit 1
fi

# A strict polygon cutline drops every tile past the administrative
# border, even one step past it — confirmed 19.08.2026 (Protomaps-era
# pipeline) by diffing an extract's tiles against the raw planet build
# around Maglić (whose summit sits ON the BA/Montenegro line): a whole
# diagonal block of tiles just past the border was simply missing,
# matching that border's real angle. Padding the bbox outward keeps
# neighboring-country tiles along the border available, so a border-ridge
# trail's far side isn't a hole in the map. `versatiles convert` outputs
# `.pmtiles` directly when the output filename ends in `.pmtiles` (no
# separate `pmtiles convert` step needed) — same drop-in format the app's
# `CountryMapDownloader` already expects.
bbox=$(node "$repo_root/scripts/region-bbox.js" "$geojson_path" "$border_pad_deg")
versatiles convert "$planet_url" "$dist_dir/$iso.pmtiles" \
  --bbox="$bbox" \
  --max-zoom="$maxzoom"

echo "$iso.pmtiles: $(stat -c%s "$dist_dir/$iso.pmtiles" 2>/dev/null || stat -f%z "$dist_dir/$iso.pmtiles") bytes"
