#!/usr/bin/env node
'use strict';

// Investigation tool, not part of the normal build. Reads a local .pmtiles
// file directly off disk (no HTTP needed — this runs inside the CI job that
// just built the file) and reports, per layer: tippecanoe's own recorded
// drop strategy and a real feature count decoded from a handful of sample
// tiles, so "how many contour lines actually survived" can be checked
// without downloading anything or touching the published release.
//
// Why this exists: the published maps-v4 archive's own tilestats showed
// tippecanoe/tile-join reporting `dropped_by_rate` counts in the hundreds of
// thousands per zoom against only ~30k contour features kept, and decoding
// a single on-device tile found exactly 1 contour line where many were
// expected. That measurement was taken from the finished, merged, published
// file — it was never established whether the drop happens in the
// tippecanoe step that builds the contours-only file, or in the tile-join
// step that merges it into the basemap (tile-join has its own independent
// tile-size limit and does not accept tippecanoe's `-r`/`--no-*-limit`
// flags at all — see its own README section). Running this against both
// `dist/<ISO>_contours.pmtiles` (pre-merge) and `dist/<ISO>.pmtiles`
// (post-merge) in the same CI run answers that directly.
//
// Usage: node diagnose-contours.js <path.pmtiles> <label> [lat,lon ...]

const fs = require('fs');
const zlib = require('zlib');

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  varint() {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.buf[this.pos++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }
}

function readDirectory(buf) {
  const r = new Reader(buf);
  const count = r.varint();
  const ids = [];
  const runLengths = [];
  const lengths = [];
  const offsets = [];
  let lastId = 0;
  for (let i = 0; i < count; i++) {
    lastId += r.varint();
    ids.push(lastId);
  }
  for (let i = 0; i < count; i++) runLengths.push(r.varint());
  for (let i = 0; i < count; i++) lengths.push(r.varint());
  for (let i = 0; i < count; i++) {
    const value = r.varint();
    offsets.push(value === 0 ? offsets[i - 1] + lengths[i - 1] : value - 1);
  }
  return ids.map((id, i) => ({
    id,
    runLength: runLengths[i],
    length: lengths[i],
    offset: offsets[i],
  }));
}

function findEntry(entries, tileId) {
  let low = 0;
  let high = entries.length - 1;
  let candidate = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (entries[mid].id <= tileId) {
      candidate = entries[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (!candidate) return null;
  if (candidate.runLength === 0) return candidate;
  return tileId - candidate.id < candidate.runLength ? candidate : null;
}

function tileIdFor(zoom, x, y) {
  let accumulated = 0;
  for (let level = 0; level < zoom; level++) accumulated += 4 ** level;
  const gridSize = 2 ** zoom;
  let distance = 0;
  let tileX = x;
  let tileY = y;
  for (let step = gridSize / 2; step > 0; step /= 2) {
    const digitX = (tileX & step) > 0 ? 1 : 0;
    const digitY = (tileY & step) > 0 ? 1 : 0;
    distance += step * step * ((3 * digitX) ^ digitY);
    if (digitY === 0) {
      if (digitX === 1) {
        tileX = step - 1 - tileX;
        tileY = step - 1 - tileY;
      }
      const swap = tileX;
      tileX = tileY;
      tileY = swap;
    }
  }
  return accumulated + distance;
}

function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat, zoom) {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  const radians = (clamped * Math.PI) / 180;
  const mercator = Math.log(Math.tan(radians) + 1 / Math.cos(radians));
  return Math.floor(((1 - mercator / Math.PI) / 2) * 2 ** zoom);
}

/// Counts features per layer name in a decompressed MVT tile buffer, and
/// reports a parse error rather than throwing past it — a malformed tile is
/// exactly the kind of thing this tool needs to surface, not crash on.
function countFeaturesPerLayer(tileBuffer) {
  const layers = {};
  let error = null;
  try {
    const r = new Reader(tileBuffer);
    while (r.pos < tileBuffer.length) {
      const key = r.varint();
      const field = key >> 3;
      const wireType = key & 7;
      if (field === 3 && wireType === 2) {
        const length = r.varint();
        const end = r.pos + length;
        const layerBuf = tileBuffer.subarray(r.pos, end);
        r.pos = end;
        const lr = new Reader(layerBuf);
        let name = '?';
        let features = 0;
        while (lr.pos < layerBuf.length) {
          const k2 = lr.varint();
          const f2 = k2 >> 3;
          const w2 = k2 & 7;
          if (f2 === 1 && w2 === 2) {
            const l = lr.varint();
            name = layerBuf.subarray(lr.pos, lr.pos + l).toString();
            lr.pos += l;
          } else if (f2 === 2 && w2 === 2) {
            const l = lr.varint();
            lr.pos += l;
            features++;
          } else if (w2 === 2) {
            const l = lr.varint();
            lr.pos += l;
          } else if (w2 === 0) {
            lr.varint();
          } else if (w2 === 5) {
            lr.pos += 4;
          } else if (w2 === 1) {
            lr.pos += 8;
          } else {
            throw new Error(`unknown wire type ${w2} in layer`);
          }
        }
        layers[name] = features;
      } else if (wireType === 2) {
        const l = r.varint();
        r.pos += l;
      } else if (wireType === 0) {
        r.varint();
      } else if (wireType === 5) {
        r.pos += 4;
      } else if (wireType === 1) {
        r.pos += 8;
      } else {
        throw new Error(`unknown wire type ${wireType} at tile level`);
      }
    }
  } catch (e) {
    error = e.message;
  }
  return {layers, error};
}

function readTile(fileBuffer, header, zoom, x, y) {
  const rootDirOffset = Number(header.readBigUInt64LE(8));
  const rootDirLength = Number(header.readBigUInt64LE(16));
  const leafDirOffset = Number(header.readBigUInt64LE(40));
  const tileDataOffset = Number(header.readBigUInt64LE(56));
  const internalCompression = header[97];
  const tileCompression = header[98];

  const decompress = (buf) =>
    internalCompression === 2 ? zlib.gunzipSync(buf) : buf;

  let directoryBuf = decompress(
    fileBuffer.subarray(rootDirOffset, rootDirOffset + rootDirLength),
  );
  let entry = findEntry(readDirectory(directoryBuf), tileIdFor(zoom, x, y));
  let hops = 0;
  while (entry && entry.runLength === 0 && hops < 4) {
    const leafBuf = decompress(
      fileBuffer.subarray(
        leafDirOffset + entry.offset,
        leafDirOffset + entry.offset + entry.length,
      ),
    );
    entry = findEntry(readDirectory(leafBuf), tileIdFor(zoom, x, y));
    hops++;
  }
  if (!entry) return null;
  let tileBuf = fileBuffer.subarray(
    tileDataOffset + entry.offset,
    tileDataOffset + entry.offset + entry.length,
  );
  if (tileCompression === 2) tileBuf = zlib.gunzipSync(tileBuf);
  return tileBuf;
}

function readMetadata(fileBuffer, header) {
  const jsonOffset = Number(header.readBigUInt64LE(24));
  const jsonLength = Number(header.readBigUInt64LE(32));
  const internalCompression = header[97];
  let buf = fileBuffer.subarray(jsonOffset, jsonOffset + jsonLength);
  if (internalCompression === 2) buf = zlib.gunzipSync(buf);
  return JSON.parse(buf.toString());
}

const [filePath, label, ...coordArgs] = process.argv.slice(2);
if (!filePath || !label) {
  console.error(
    'Usage: node diagnose-contours.js <path.pmtiles> <label> [lat,lon ...]',
  );
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  // Exit 1, not 0 — a missing file here means this diagnostic step told
  // nobody anything useful, and that is a failure worth seeing immediately
  // rather than discovering after a full CI run that every "successful"
  // step was silently a no-op (which is exactly what happened the first
  // time this ran, from a lowercase/uppercase filename mismatch).
  console.error(`## ${label}\n(missing: ${filePath})\n`);
  process.exit(1);
}

const fileBuffer = fs.readFileSync(filePath);
const header = fileBuffer.subarray(0, 127);
const minZoom = header[100];
const maxZoom = header[101];

const lines = [`## ${label}`, `file: ${filePath}`, `size: ${fileBuffer.length} bytes`, `zoom: ${minZoom}-${maxZoom}`];

let metadata;
try {
  metadata = readMetadata(fileBuffer, header);
  const contourStats = (metadata.tilestats?.layers || []).find(
    (l) => l.layer === 'contours',
  );
  if (contourStats) {
    lines.push(
      `contours tilestats: count=${contourStats.count} geometry=${contourStats.geometry}`,
    );
  } else {
    lines.push('contours tilestats: (no "contours" layer in tilestats)');
  }
  if (metadata.strategies) {
    lines.push(`strategies: ${JSON.stringify(metadata.strategies)}`);
  }
  lines.push(`generator: ${metadata.generator || '?'}`);
} catch (e) {
  lines.push(`metadata read failed: ${e.message}`);
}

// Default sample coordinates: Volujak summit area (the exact spot a device
// decode found only 1 contour feature) across every zoom the archive has,
// so this reproduces that finding directly rather than a new location.
const coords =
  coordArgs.length > 0
    ? coordArgs.map((s) => s.split(',').map(Number))
    : [[43.305, 18.665]];

for (const [lat, lon] of coords) {
  for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
    const x = lonToTileX(lon, zoom);
    const y = latToTileY(lat, zoom);
    const tileBuf = readTile(fileBuffer, header, zoom, x, y);
    if (!tileBuf) {
      lines.push(`  z${zoom}/${x}/${y} (${lat},${lon}): no tile entry`);
      continue;
    }
    const {layers, error} = countFeaturesPerLayer(tileBuf);
    const contourCount = layers.contours ?? 0;
    const allLayers = Object.entries(layers)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(
      `  z${zoom}/${x}/${y} (${lat},${lon}): contours=${contourCount}` +
        (error ? `  !! PARSE ERROR: ${error}` : `  [${allLayers}]`),
    );
  }
}

lines.push('');
console.log(lines.join('\n'));

const outPath = process.env.DIAGNOSTIC_OUTPUT_FILE;
if (outPath) {
  fs.appendFileSync(outPath, lines.join('\n') + '\n');
}
