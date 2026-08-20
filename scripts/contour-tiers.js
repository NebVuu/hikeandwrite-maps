#!/usr/bin/env node
'use strict';

// Tags each contour line with a tippecanoe per-feature minzoom, read
// directly from a GeoJSON Feature's own `tippecanoe` property (a
// documented tippecanoe input convention — no extra flag needed to make
// it take effect). Without this, every line rendered at every zoom, which
// is most of why the first real BA build came out at 285MB — comparable to
// the whole basemap — for a single-attribute line layer (see TASKS.md,
// "Hillshade + konture").
//
// 20.08.2026: four tiers instead of two, after the interval went 20m ->
// 10m (see build-contours.sh). Each zoom step roughly doubles the line
// density, so the map gains detail as you zoom in rather than dumping
// every 10m line at once:
//   every 100m -> z11   (major structure, readable across a whole range)
//   every  50m -> z12
//   every  20m -> z13   (the old default interval)
//   every  10m -> z14   (deepest zoom the basemap itself supports)
// This tiering — not tippecanoe's drop-densest valve — is the intended
// size lever, since it thins by elevation significance rather than by
// whichever tile happens to be busiest (which meant steep terrain, i.e.
// exactly where contours matter, lost lines first).
//
// Usage: node contour-tiers.js input.geojson > output.geojson

const fs = require('fs');

const path = process.argv[2];
if (!path) {
  console.error('Usage: node contour-tiers.js <contours.geojson>');
  process.exit(1);
}

// A tolerant "is this elevation a multiple of `step`" test — gdal_contour
// emits floating-point elevations, so an exact `% step === 0` would miss
// lines to representation error (e.g. 1699.9999999998 for 1700).
function isMultipleOf(elevation, step) {
  return Math.abs(elevation % step) < 0.001 ||
    Math.abs((elevation % step) - step) < 0.001;
}

const geojson = JSON.parse(fs.readFileSync(path, 'utf8'));
for (const feature of geojson.features) {
  const elevation = feature.properties.elev;
  let minzoom = 14;
  if (isMultipleOf(elevation, 100)) {
    minzoom = 11;
  } else if (isMultipleOf(elevation, 50)) {
    minzoom = 12;
  } else if (isMultipleOf(elevation, 20)) {
    minzoom = 13;
  }
  feature.tippecanoe = { minzoom };
}

process.stdout.write(JSON.stringify(geojson));
