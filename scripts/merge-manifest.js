#!/usr/bin/env node
'use strict';

// Builds dist/maps.json — one entry per region in regions/*.yml, with the
// actual file size of its built dist/<ISO>.pmtiles. Hillshade stays a
// separate, unsolved problem (see TASKS.md, "Hillshade (teren) — NIJE
// riješeno") — a region only gets a `hillshade` entry if a
// dist/<ISO>_hillshade.pmtiles file happens to already be there.
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
    const hillshadePath = path.join(distDir, `${region.iso}_hillshade.pmtiles`);
    if (!fs.existsSync(basemapPath)) {
      throw new Error(`Missing ${basemapPath} — did build-region.sh run for ${region.iso}?`);
    }
    return {
      iso: region.iso,
      name: region.name,
      maxzoom: Number(region.maxzoom),
      basemap: {
        file: `${region.iso}.pmtiles`,
        size: fs.statSync(basemapPath).size,
      },
      hillshade: fs.existsSync(hillshadePath)
        ? { file: `${region.iso}_hillshade.pmtiles`, size: fs.statSync(hillshadePath).size }
        : null,
    };
  });

const manifest = {
  generated_at: new Date().toISOString(),
  source: 'https://build.protomaps.com (Protomaps public planet build)',
  countries,
};

fs.writeFileSync(
  path.join(distDir, 'maps.json'),
  JSON.stringify(manifest, null, 2),
);
console.log(`Wrote ${countries.length} entries to dist/maps.json`);
