#!/usr/bin/env node
'use strict';

// Tags each contour line with a tippecanoe per-feature minzoom, read
// directly from a GeoJSON Feature's own `tippecanoe` property (a
// documented tippecanoe input convention — no extra flag needed to make
// it take effect). Without this, every line rendered at every zoom, which
// is most of why the first real BA build came out at 285MB — comparable to
// the whole basemap — for a single-attribute line layer (see TASKS.md,
// "Hillshade + konture").
//
// 20.08.2026: four tiers instead of two, after the interval went 20m ->
// 10m (see build-contours.sh). Each zoom step roughly doubles the line
// density, so the map gains detail as you zoom in rather than dumping
// every 10m line at once:
//   every 100m -> z11   (major structure, readable across a whole range)
//   every  50m -> z12
//   every  20m -> z13   (the old default interval)
//   every  10m -> z14   (deepest zoom the basemap itself supports)
// This tiering — not tippecanoe's drop-densest valve — is the intended
// size lever, since it thins by elevation significance rather than by
// whichever tile happens to be busiest (which meant steep terrain, i.e.
// exactly where contours matter, lost lines first).
//
// **Streams line-delimited input, one feature at a time.** The previous
// version read the whole file with `fs.readFileSync(path, 'utf8')` and
// `JSON.parse`d it, which died the moment the 10m interval landed:
//
//   Error: Cannot create a string longer than 0x1fffffe8 characters
//   code: 'ERR_STRING_TOO_LONG'   (contour-tiers.js, CI run #8)
//
// 0x1fffffe8 is (1<<29)-24 — V8's hard maximum string length, ~512MB. The
// whole-file approach could never scale past it regardless of available
// RAM, and halving the contour interval pushed the file straight through
// it. (Node also refuses any file over 2GiB outright, with
// ERR_FS_FILE_TOO_LARGE, so that approach was a dead end for a fine
// interval over a whole country either way.) Streaming a feature per line
// keeps memory flat no matter how large the region or how fine the
// interval, so this stops being a ceiling to keep re-tuning around.
//
// Input and output are both newline-delimited (`-f GeoJSONSeq` upstream).
// tippecanoe reads that natively — and per its README will even
// parallelise input automatically when given line-delimited JSON, which
// is a speed lever available later if the 10m interval makes the tiling
// step slow.
//
// Usage: node contour-tiers.js input.geojsonl > output.geojsonl

const fs = require('fs');
const readline = require('readline');

const path = process.argv[2];
if (!path) {
  console.error('Usage: node contour-tiers.js <contours.geojsonl>');
  process.exit(1);
}

// A tolerant "is this elevation a multiple of `step`" test — gdal_contour
// emits floating-point elevations, so an exact `% step === 0` would miss
// lines to representation error (e.g. 1699.9999999998 for 1700).
function isMultipleOf(elevation, step) {
  return Math.abs(elevation % step) < 0.001 ||
    Math.abs((elevation % step) - step) < 0.001;
}

function minzoomFor(elevation) {
  if (isMultipleOf(elevation, 100)) return 11;
  if (isMultipleOf(elevation, 50)) return 12;
  if (isMultipleOf(elevation, 20)) return 13;
  return 14;
}

const input = readline.createInterface({
  input: fs.createReadStream(path, 'utf8'),
  crlfDelay: Infinity,
});

let tagged = 0;
let skipped = 0;

input.on('line', (rawLine) => {
  // RFC 8142 JSON text sequences prefix each record with U+001E; GDAL's
  // GeoJSONSeq driver may or may not emit it depending on version, so
  // strip it rather than depending on which behaviour we get.
  const line = rawLine.replace(/^\x1e/, '').trim();
  if (!line || line === '[' || line === ']') return;

  let feature;
  try {
    feature = JSON.parse(line);
  } catch (_) {
    // A partial or non-feature line (e.g. a stray FeatureCollection
    // wrapper if the input wasn't really GeoJSONSeq). Count it so the
    // build log shows something is off rather than silently thinning the
    // output.
    skipped += 1;
    return;
  }
  const elevation = feature && feature.properties && feature.properties.elev;
  if (typeof elevation !== 'number') {
    skipped += 1;
    return;
  }
  feature.tippecanoe = { minzoom: minzoomFor(elevation) };
  tagged += 1;
  process.stdout.write(JSON.stringify(feature) + '\n');
});

input.on('close', () => {
  process.stderr.write(`contour-tiers: tagged ${tagged} features`);
  if (skipped > 0) {
    process.stderr.write(`, skipped ${skipped} unusable lines`);
  }
  process.stderr.write('\n');
  if (tagged === 0) {
    process.stderr.write(
      'contour-tiers: no features tagged — is the input newline-delimited ' +
        'GeoJSON (-f GeoJSONSeq)?\n',
    );
    process.exit(1);
  }
});
