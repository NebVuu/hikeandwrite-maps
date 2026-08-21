#!/usr/bin/env node
'use strict';

// Reads the max_zoom byte straight from a PMTiles v3 header — same
// offsets HikeAndWrite's own `CountryMapDownloader.readBounds` already
// relies on for bounds (confirmed there by hex-dumping a real published
// header, not guessed from the spec alone): 7-byte "PMTiles" magic,
// 1-byte version at offset 7, min_zoom at offset 100, max_zoom at offset
// 101. Used by validate-maxzoom.sh to catch a build silently capped below
// what regions/<iso>.yml asked for — see that script's own header comment
// for the 21.08.2026 incident this exists to catch automatically instead
// of via a manual header inspection after publish.
//
// Usage: node read-pmtiles-maxzoom.js <path.pmtiles>

const fs = require('fs');

const path = process.argv[2];
if (!path) {
  console.error('Usage: node read-pmtiles-maxzoom.js <path.pmtiles>');
  process.exit(1);
}

const fd = fs.openSync(path, 'r');
const header = Buffer.alloc(127);
fs.readSync(fd, header, 0, 127, 0);
fs.closeSync(fd);

if (header.toString('ascii', 0, 7) !== 'PMTiles' || header[7] !== 3) {
  console.error(`${path}: not a PMTiles v3 archive`);
  process.exit(1);
}

console.log(header[101]);
