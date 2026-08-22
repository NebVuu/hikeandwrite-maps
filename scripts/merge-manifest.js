#!/usr/bin/env node
'use strict';

// Builds dist/maps.json — one entry per region in regions/*.yml, with the
// actual file size of its built dist/<ISO>.pmtiles and
// dist/<ISO>_contours.pmtiles, plus a single top-level `hillshade` entry
// for the shared regional extract (see build-hillshade-regional.sh and
// HikeAndWrite's `offline-maps-rearchitecture` decision, 21.08.2026 —
// hillshade stopped being a per-country file).
//
// 22.08.2026: contours go back to being their own per-country asset,
// downloaded alongside the basemap rather than merged into it — see
// scripts/filter-basemap-layers.sh's header comment for why (tile-join
// silently discarding ~95% of the merged contour features, consistent
// with an open upstream bug merging PMTiles archives). Every mainstream
// hiking/outdoor map style ships contours this way too, as their own
// tileset rather than folded into the basemap file.
//
// Every asset also carries a `sha256`. The app needs it because these are
// large files over a mobile connection: a real device already failed
// mid-stream on the 850MB hillshade, and resuming a partial download via an
// HTTP Range request is only safe if the finished file can be verified. A
// corrupt archive is worse than a missing one — the app would read a valid
// header, render nothing, and look broken rather than incomplete.
//
// No YAML dependency: regions/*.yml files are flat `key: value` pairs
// (see regions/ba.yml), so a line-based parse is enough — pulling in a
// real YAML parser for four scalar fields would be more dependency than
// the format needs.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const regionsDir = path.join(repoRoot, 'regions');
const distDir = path.join(repoRoot, 'dist');

function parseFlatYaml(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
    if (match) result[match[1]] = match[2].trim();
  }
  return result;
}

/// Streams the file through the hash rather than reading it into a Buffer —
/// these archives run to hundreds of megabytes and a CI runner shouldn't have
/// to hold one in memory to describe it.
function describeAsset(file) {
  const filePath = path.join(distDir, file);
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.alloc(1 << 20);
  const handle = fs.openSync(filePath, 'r');
  try {
    let read = 0;
    while ((read = fs.readSync(handle, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(handle);
  }
  return {file, size: fs.statSync(filePath).size, sha256: hash.digest('hex')};
}

const countries = fs
  .readdirSync(regionsDir)
  .filter((file) => file.endsWith('.yml'))
  .map((file) => {
    const region = parseFlatYaml(
      fs.readFileSync(path.join(regionsDir, file), 'utf8'),
    );
    const basemapFile = `${region.iso}.pmtiles`;
    if (!fs.existsSync(path.join(distDir, basemapFile))) {
      throw new Error(
        `Missing dist/${basemapFile} — did build-region.sh run for ${region.iso}?`,
      );
    }
    const contoursFile = `${region.iso}_contours.pmtiles`;
    if (!fs.existsSync(path.join(distDir, contoursFile))) {
      throw new Error(
        `Missing dist/${contoursFile} — did build-contours.sh run for ${region.iso}?`,
      );
    }
    return {
      iso: region.iso,
      name: region.name,
      maxzoom: Number(region.maxzoom),
      basemap: describeAsset(basemapFile),
      contours: describeAsset(contoursFile),
    };
  });

const hillshade = fs.existsSync(path.join(distDir, 'hillshade.pmtiles'))
  ? describeAsset('hillshade.pmtiles')
  : null;

const manifest = {
  // 5, not 4: each country gained its own `contours` asset entry, back to
  // being a separate file from `basemap`. The app parses defensively
  // (unknown fields ignored, missing ones tolerated), so this is
  // informational rather than a gate — but it's the field to check first
  // when a client and a release disagree.
  schemaVersion: 5,
  generated_at: new Date().toISOString(),
  source: 'https://download.versatiles.org (VersaTiles Shortbread planet build)',
  hillshade,
  countries,
};

fs.writeFileSync(
  path.join(distDir, 'maps.json'),
  JSON.stringify(manifest, null, 2),
);
console.log(`Wrote ${countries.length} country entries to dist/maps.json`);
