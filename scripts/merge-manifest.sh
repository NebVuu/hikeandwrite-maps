#!/usr/bin/env bash
# Builds dist/maps.json from every region's built .pmtiles file plus its
# regions/*.yml metadata — run after all scripts/build-region.sh calls.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
node "$repo_root/scripts/merge-manifest.js"
