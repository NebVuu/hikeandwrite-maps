#!/usr/bin/env node
'use strict';

// Prints a single padded bounding box that covers every boundary GeoJSON
// passed in — used by build-hillshade-regional.sh to build one shared
// hillshade extract instead of a separate one per country. Same "pad past
// the exact border" reasoning as region-bbox.js (see its own comment,
// Maglić/BA-Montenegro border case), applied once to the union of every
// region rather than per-country. A rectangular superset is precise
// enough here — unlike the basemap's coverage-mask, a raster relief layer
// doesn't need the real border shape.
//
// Usage: node union-bbox.js <padDegrees> <boundary1.geojson> [boundary2.geojson ...]
// Prints: minlon,minlat,maxlon,maxlat

const fs = require('fs');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node union-bbox.js <padDegrees> <boundary.geojson>...');
  process.exit(1);
}

const pad = Number(args[0]);
const paths = args.slice(1);

let minLon = Infinity;
let minLat = Infinity;
let maxLon = -Infinity;
let maxLat = -Infinity;

function visitRing(ring) {
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
}

for (const boundaryPath of paths) {
  const geometry = JSON.parse(fs.readFileSync(boundaryPath, 'utf8'));
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polygons) {
    for (const ring of rings) visitRing(ring);
  }
}

process.stdout.write(
  `${minLon - pad},${minLat - pad},${maxLon + pad},${maxLat + pad}`,
);
