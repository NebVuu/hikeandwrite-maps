#!/usr/bin/env node
'use strict';

// Prints a padded bounding box for a country boundary GeoJSON, for
// `pmtiles extract --bbox=...`. A plain administrative-border cutline (no
// margin) drops every tile on the far side of the border, even one step
// past it — a real problem for border-ridge peaks (e.g. Maglić, whose
// summit sits ON the BA/Montenegro line): the trail's far side, and
// anything the hiker can see from it, simply isn't in the download.
// Padding the extract bbox outward keeps that same-tile neighboring
// territory available without needing a true polygon buffer (which would
// need a geometry library neither this repo nor its build step otherwise
// depends on).
//
// Usage: node region-bbox.js boundary.geojson [padDegrees=0.1]
// Prints: minlon,minlat,maxlon,maxlat

const fs = require('fs');

const path = process.argv[2];
const pad = process.argv[3] ? Number(process.argv[3]) : 0.1;
if (!path) {
  console.error('Usage: node region-bbox.js <boundary.geojson> [padDegrees]');
  process.exit(1);
}

const geometry = JSON.parse(fs.readFileSync(path, 'utf8'));

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

const polygons =
  geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
for (const rings of polygons) {
  for (const ring of rings) visitRing(ring);
}

process.stdout.write(
  `${minLon - pad},${minLat - pad},${maxLon + pad},${maxLat + pad}`,
);
