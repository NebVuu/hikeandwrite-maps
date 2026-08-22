#!/usr/bin/env node
'use strict';

// Minimal, controlled reproduction case for Problem A — a handful of clean,
// non-degenerate synthetic lines instead of the real 598,756-feature BA
// dataset. If tippecanoe still collapses these to ~1 feature/tile, the bug
// is a real, minimal, reportable tippecanoe defect independent of our
// input's scale or content. If these come through correctly (feature count
// and geometry richness growing with zoom, as per-feature minzoom should
// produce), the bug is specific to something about the real dataset
// (density, precision, geometry shape) and this rules out "tippecanoe
// can't do per-feature minzoom on lines at all" as an explanation.
//
// Uses the exact same z11/z12/z13/z14 tile chain
// (1125/747 -> 2251/1495 -> 4502/2991 -> 9004/5982) that
// diagnose-contours.js has decoded throughout this investigation, so the
// existing tooling and coordinate (43.6,17.85) apply unchanged.
//
// Emits 2 features per tier (11/12/13/14), each a zigzag LineString
// spanning that tier's own tile bounds, already tagged with
// `tippecanoe.minzoom` (skipping contour-tiers.js entirely — this isolates
// tippecanoe's own behavior from the tiering script). Per-feature minzoom
// is a floor, so the expected, correct cascade is:
//   z11 tile: only the 2 tier-11 features
//   z12 tile: tier-11 (clipped) + 2 tier-12 features
//   z13 tile: tier-11 + tier-12 (both clipped) + 2 tier-13 features
//   z14 tile: all three above (clipped) + 2 tier-14 features
// i.e. feature count and richness should GROW with zoom, not shrink.
//
// Usage: node generate-synthetic-contours.js > synthetic.geojsonl

function tileBBox(z, x, y) {
  const n = 2 ** z;
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latOf = (yy) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  const latMax = latOf(y); // north edge (y increases southward)
  const latMin = latOf(y + 1); // south edge
  return { lonMin, lonMax, latMin, latMax };
}

// A zigzag LineString covering ~90% of a bbox, offset slightly per index so
// multiple features in the same tile don't sit exactly on top of each other.
function zigzagLine(bbox, offsetFraction) {
  const { lonMin, lonMax, latMin, latMax } = bbox;
  const lonSpan = lonMax - lonMin;
  const latSpan = latMax - latMin;
  const pad = 0.05; // stay inside the tile, away from edge-clipping ambiguity
  const points = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lon = lonMin + lonSpan * (pad + t * (1 - 2 * pad));
    const zig = i % 2 === 0 ? pad : 1 - pad;
    const lat =
      latMin + latSpan * (offsetFraction * (1 - 2 * pad) + pad) +
      (i % 2 === 0 ? 0 : latSpan * 0.02); // small perpendicular wiggle
    points.push([lon, lat]);
  }
  return points;
}

// --with-maxzoom tests a specific hypothesis: tippecanoe's docs say a
// feature's `tippecanoe.maxzoom`, if unset, defaults to the layer's own
// --maximum-zoom (14 here) — i.e. minzoom should be a floor, not a pin.
// If features are actually only surviving at their own tagged minzoom and
// nowhere above it (exactly the symptom seen in both this synthetic repro
// and the real 598K-feature BA build), an unset per-feature maxzoom
// silently behaving as if maxzoom==minzoom would explain it perfectly —
// this flag tests that directly by setting maxzoom explicitly.
const withMaxzoom = process.argv.includes('--with-maxzoom');
// --no-tippecanoe-tag isolates whether the per-feature `tippecanoe.minzoom`
// tagging itself is what triggers the collapse, independent of maxzoom or
// drop-rate: with this flag, features carry no tippecanoe hints at all, so
// tippecanoe's own default pyramid logic decides zoom appearance instead
// of contour-tiers.js-style manual per-feature minzoom.
const noTag = process.argv.includes('--no-tippecanoe-tag');

function feature(tier, z, x, y, offsetFraction, elev) {
  const bbox = tileBBox(z, x, y);
  const result = {
    type: 'Feature',
    properties: { elev, tier },
    geometry: {
      type: 'LineString',
      coordinates: zigzagLine(bbox, offsetFraction),
    },
  };
  if (!noTag) {
    result.tippecanoe = withMaxzoom ? { minzoom: tier, maxzoom: 14 } : { minzoom: tier };
  }
  return result;
}

const tiles = {
  11: [1125, 747],
  12: [2251, 1495],
  13: [4502, 2991],
  14: [9004, 5982],
};

const features = [];
let elev = 1000;
for (const tier of [11, 12, 13, 14]) {
  const [x, y] = tiles[tier];
  features.push(feature(tier, tier, x, y, 0.3, elev));
  elev += 10;
  features.push(feature(tier, tier, x, y, 0.6, elev));
  elev += 10;
}

for (const f of features) {
  process.stdout.write(JSON.stringify(f) + '\n');
}
process.stderr.write(`generate-synthetic-contours: emitted ${features.length} features\n`);
