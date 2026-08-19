#!/usr/bin/env node
'use strict';

// Prints one Copernicus GLO-30 DEM tile download URL per line for every
// 1°x1° cell overlapping the given GeoJSON boundary's bounding box.
// Public AWS Open Data bucket, no credentials needed — verified
// 19.08.2026 by fetching real tiles (e.g. N43_00_E018 covers Sarajevo).
// The keys use "COG_10" in their name despite this being the 30m/GLO-30
// product — a known quirk of the original Copernicus DEM release naming,
// confirmed by listing the actual bucket contents rather than guessing.
//
// N/E cell naming (this repo's regions so far) is verified against real
// tiles. S/W naming below is the same floor-based scheme extrapolated,
// NOT verified against a real southern/western tile — check before
// trusting it for a region south of the equator or west of Greenwich.
//
// Usage: node dem-tiles.js <boundary.geojson>

const fs = require('fs');

const path = process.argv[2];
if (!path) {
  console.error('Usage: node dem-tiles.js <boundary.geojson>');
  process.exit(1);
}

const geometry = JSON.parse(fs.readFileSync(path, 'utf8'));
const rings =
  geometry.type === 'Polygon'
    ? [geometry.coordinates[0]]
    : geometry.coordinates.map((polygon) => polygon[0]);
const points = rings.flat();
const lons = points.map((point) => point[0]);
const lats = points.map((point) => point[1]);
const minLon = Math.floor(Math.min(...lons));
const maxLon = Math.floor(Math.max(...lons));
const minLat = Math.floor(Math.min(...lats));
const maxLat = Math.floor(Math.max(...lats));

function cellName(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const latAbs = String(Math.abs(lat)).padStart(2, '0');
  const lonAbs = String(Math.abs(lon)).padStart(3, '0');
  return `${ns}${latAbs}_00_${ew}${lonAbs}_00`;
}

for (let lat = minLat; lat <= maxLat; lat++) {
  for (let lon = minLon; lon <= maxLon; lon++) {
    const cell = cellName(lat, lon);
    console.log(
      `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_${cell}_DEM/Copernicus_DSM_COG_10_${cell}_DEM.tif`,
    );
  }
}
