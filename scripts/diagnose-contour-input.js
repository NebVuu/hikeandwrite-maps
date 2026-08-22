#!/usr/bin/env node
'use strict';

// Verifies the actual GeoJSONSeq passed to tippecanoe instead of inferring
// its per-feature minzoom tags from contour-tiers.js's source code.
const fs = require('fs');
const readline = require('readline');

const path = process.argv[2];
if (!path || !fs.existsSync(path)) {
  console.error('Usage: node diagnose-contour-input.js <contours_tiered.geojsonl>');
  process.exit(1);
}

const tiers = new Map();
let records = 0;
let malformed = 0;
let missingMinzoom = 0;
let invalidMinzoom = 0;
const input = readline.createInterface({
  input: fs.createReadStream(path, 'utf8'),
  crlfDelay: Infinity,
});

input.on('line', (raw) => {
  const line = raw.replace(/^\x1e/, '').trim();
  if (!line) return;
  records += 1;
  let feature;
  try {
    feature = JSON.parse(line);
  } catch (_) {
    malformed += 1;
    return;
  }
  const minzoom = feature && feature.tippecanoe && feature.tippecanoe.minzoom;
  if (minzoom === undefined) {
    missingMinzoom += 1;
  } else if (!Number.isInteger(minzoom) || minzoom < 0 || minzoom > 24) {
    invalidMinzoom += 1;
  } else {
    tiers.set(minzoom, (tiers.get(minzoom) || 0) + 1);
  }
});

input.on('close', () => {
  const tierSummary = [...tiers.entries()]
    .sort(([a], [b]) => a - b)
    .map(([zoom, count]) => `z${zoom}=${count}`)
    .join(' ');
  console.log(`## contour input: ${path}`);
  console.log(
    `records=${records} malformed=${malformed} missing_minzoom=${missingMinzoom} ` +
      `invalid_minzoom=${invalidMinzoom} tiers: ${tierSummary || '(none)'}`,
  );
  if (records === 0 || malformed || missingMinzoom || invalidMinzoom) {
    process.exitCode = 1;
  }
});
