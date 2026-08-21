#!/usr/bin/env node
'use strict';

// Builds dist/maps.json — one entry per region in regions/*.yml, with the
// actual file size of its built dist/<ISO>.pmtiles, plus a single
// top-level `hillshade` entry for the shared regional extract (see
// build-hillshade-regional.sh and HikeAndWrite's `offline-maps-
// rearchitecture` decision, 21.08.2026 — hillshade stopped being a
// per-country file, and contours stopped being a separate per-country
// file too, once scripts/merge-basemap-contours.sh folds them into the
// basemap itself). `hasContours` is a fixed `true`, not a per-region
// probe: every region's dist/<ISO>.pmtiles has already had its contours
// tileset merged in by the time this script runs, for every region in
// regions/*.yml — there's no longer a BA-only trial to distinguish.
//
// No YAML dependency: regions/*.yml files are flat `key: value` pairs
// (see regions/ba.yml), so a line-based parse is enough — pulling in a
// real YAML parser for four scalar fields would be more dependency than
// the format needs.

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

const countries = fs
  .readdirSync(regionsDir)
  .filter((file) => file.endsWith('.yml'))
  .map((file) => {
    const region = parseFlatYaml(
      fs.readFileSync(path.join(regionsDir, file), 'utf8'),
    );
    const basemapPath = path.join(distDir, `${region.iso}.pmtiles`);
    if (!fs.existsSync(basemapPath)) {
      throw new Error(`Missing ${basemapPath} — did build-region.sh run for ${region.iso}?`);
    }
    return {
      iso: region.iso,
      name: region.name,
      maxzoom: Number(region.maxzoom),
      hasContours: true,
      basemap: {
        file: `${region.iso}.pmtiles`,
        size: fs.statSync(basemapPath).size,
      },
    };
  });

const hillshadePath = path.join(distDir, 'hillshade.pmtiles');
const hillshade = fs.existsSync(hillshadePath)
  ? { file: 'hillshade.pmtiles', size: fs.statSync(hillshadePath).size }
  : null;

const manifest = {
  schemaVersion: 3,
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
