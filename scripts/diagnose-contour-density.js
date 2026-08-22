#!/usr/bin/env node
'use strict';

// Counts how many candidate contour-line features actually fall inside one
// specific tile's footprint, straight out of contour-tiers.js's output —
// i.e. what tippecanoe is handed for that tile, before tippecanoe or the
// `pmtiles extract --region` clip touch anything. Answers the question the
// other diagnostics can't: is the sparseness (1 feature/tile, seen at real
// mountains in the published maps-v5 contours file) already present in the
// raw candidate set for that location, or does it only appear once
// tippecanoe/extract get involved?
//
// A feature counts as "inside" if any of its vertices falls within the
// tile's lon/lat bounds — approximate (a long line could pass through
// without any vertex landing inside after simplification), but good enough
// to tell "roughly zero" from "dozens", which is the distinction that
// matters here.
//
// Usage: node diagnose-contour-density.js <contours_tiered.geojsonl> <lat> <lon> [zoom=14]

const fs = require('fs');
const readline = require('readline');

const [path, latArg, lonArg, zoomArg] = process.argv.slice(2);
if (!path || latArg === undefined || lonArg === undefined) {
  console.error(
    'Usage: node diagnose-contour-density.js <contours_tiered.geojsonl> <lat> <lon> [zoom=14]',
  );
  process.exit(1);
}
const lat = Number(latArg);
const lon = Number(lonArg);
const zoom = zoomArg ? Number(zoomArg) : 14;

function lonToTileX(longitude, z) {
  return Math.floor(((longitude + 180) / 360) * 2 ** z);
}
function latToTileY(latitude, z) {
  const clamped = Math.max(-85.051129, Math.min(85.051129, latitude));
  const radians = (clamped * Math.PI) / 180;
  const mercator = Math.log(Math.tan(radians) + 1 / Math.cos(radians));
  return Math.floor(((1 - mercator / Math.PI) / 2) * 2 ** z);
}
function tileYToLat(y, z) {
  const n = 2 ** z;
  const merc = Math.PI * (1 - (2 * y) / n);
  return (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
}
function tileXToLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}

const tileX = lonToTileX(lon, zoom);
const tileY = latToTileY(lat, zoom);
const lonMin = tileXToLon(tileX, zoom);
const lonMax = tileXToLon(tileX + 1, zoom);
const latMax = tileYToLat(tileY, zoom);
const latMin = tileYToLat(tileY + 1, zoom);

function anyVertexInside(geometry) {
  const check = (coord) =>
    coord[0] >= lonMin && coord[0] <= lonMax && coord[1] >= latMin && coord[1] <= latMax;
  if (!geometry) return false;
  if (geometry.type === 'LineString') return geometry.coordinates.some(check);
  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.some((line) => line.some(check));
  }
  return false;
}

let total = 0;
let matched = 0;
const tierCounts = {};
const elevations = [];

const input = readline.createInterface({
  input: fs.createReadStream(path, 'utf8'),
  crlfDelay: Infinity,
});

input.on('line', (rawLine) => {
  const line = rawLine.replace(/^\x1e/, '').trim();
  if (!line) return;
  total += 1;
  let feature;
  try {
    feature = JSON.parse(line);
  } catch (_) {
    return;
  }
  if (anyVertexInside(feature.geometry)) {
    matched += 1;
    const mz = feature.tippecanoe && feature.tippecanoe.minzoom;
    tierCounts[mz] = (tierCounts[mz] || 0) + 1;
    const elev = feature.properties && feature.properties.elev;
    if (typeof elev === 'number' && elevations.length < 30) elevations.push(elev);
  }
});

input.on('close', () => {
  console.log(`## contour density near (${lat},${lon}) at z${zoom} tile ${tileX}/${tileY}`);
  console.log(`tile bounds: lon [${lonMin.toFixed(5)}, ${lonMax.toFixed(5)}] lat [${latMin.toFixed(5)}, ${latMax.toFixed(5)}]`);
  console.log(`scanned ${total} input records, ${matched} have a vertex inside this tile's bounds`);
  const tierSummary = Object.entries(tierCounts)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([z, c]) => `minzoom${z}=${c}`)
    .join(' ');
  console.log(`by tier: ${tierSummary || '(none)'}`);
  console.log(`sample elevations: ${elevations.join(', ')}`);
});
