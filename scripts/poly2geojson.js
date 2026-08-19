#!/usr/bin/env node
'use strict';

// Converts an Osmosis/Geofabrik ".poly" boundary file to a GeoJSON
// Polygon/MultiPolygon geometry, for pmtiles extract's --region flag.
// No external dependencies — parses the format directly (see
// https://wiki.openstreetmap.org/wiki/Osmosis/Polygon_Filter_File_Format).
//
// Usage: node poly2geojson.js input.poly > output.geojson

const fs = require('fs');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node poly2geojson.js <input.poly>');
  process.exit(1);
}

const lines = fs
  .readFileSync(inputPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

let i = 1; // line 0 is the polygon name/comment, skip it
const exteriorRings = []; // each: { ring: [[lon, lat], ...], holes: [[...], ...] }

while (i < lines.length && lines[i] !== 'END') {
  const header = lines[i];
  i += 1;
  const isHole = header.startsWith('!');
  const ring = [];
  while (lines[i] !== 'END') {
    const [lon, lat] = lines[i].split(/\s+/).map(Number);
    ring.push([lon, lat]);
    i += 1;
  }
  i += 1; // consume this ring's own END

  // Close the ring if the source didn't already repeat the first point —
  // GeoJSON linear rings must be closed, .poly rings aren't guaranteed to be.
  const [firstLon, firstLat] = ring[0];
  const [lastLon, lastLat] = ring[ring.length - 1];
  if (firstLon !== lastLon || firstLat !== lastLat) {
    ring.push([firstLon, firstLat]);
  }

  if (isHole) {
    if (exteriorRings.length === 0) {
      throw new Error(`Hole ring before any exterior ring in ${inputPath}`);
    }
    exteriorRings[exteriorRings.length - 1].holes.push(ring);
  } else {
    exteriorRings.push({ ring, holes: [] });
  }
}

const geometry =
  exteriorRings.length === 1
    ? {
        type: 'Polygon',
        coordinates: [exteriorRings[0].ring, ...exteriorRings[0].holes],
      }
    : {
        type: 'MultiPolygon',
        coordinates: exteriorRings.map((p) => [p.ring, ...p.holes]),
      };

process.stdout.write(JSON.stringify(geometry));
