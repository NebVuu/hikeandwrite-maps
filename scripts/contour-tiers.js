#!/usr/bin/env node
'use strict';

// Tags each contour line with a tippecanoe per-feature minzoom, read
// directly from a GeoJSON Feature's own `tippecanoe` property (a
// documented tippecanoe input convention — no extra flag needed to make
// it take effect): "index" lines (elevation a multiple of 100m) get
// minzoom 11, same as before; "minor" lines (every 20m interval in
// between) only appear from minzoom 13 on. Without this, every 20m line
// rendered at every zoom 11-15, which is most of why the first real BA
// build came out at 285MB — comparable to the whole basemap — for a
// single-attribute line layer (see TASKS.md, "Hillshade + konture").
//
// Usage: node contour-tiers.js input.geojson > output.geojson

const fs = require('fs');

const path = process.argv[2];
if (!path) {
  console.error('Usage: node contour-tiers.js <contours.geojson>');
  process.exit(1);
}

const geojson = JSON.parse(fs.readFileSync(path, 'utf8'));
for (const feature of geojson.features) {
  const elevation = feature.properties.elev;
  const isIndexContour = Math.abs(elevation % 100) < 0.001;
  feature.tippecanoe = { minzoom: isIndexContour ? 11 : 13 };
}

process.stdout.write(JSON.stringify(geojson));
