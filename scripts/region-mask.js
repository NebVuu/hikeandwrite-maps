#!/usr/bin/env node
'use strict';

// Turns one or more region boundary GeoJSONs into a tile-aligned
// MultiPolygon mask for `pmtiles extract --region=...`, replacing the plain
// `--bbox` those extracts used before.
//
// Why a mask instead of a bbox: a country's bbox can be several times its
// own area. Measured against the Geofabrik boundaries this pipeline already
// downloads (padded bbox area / boundary area): BA 2.06x, RS 2.06x, SI
// 2.36x, ME 2.53x, HR 2.55x. Croatia is the extreme case — it's a crescent,
// so its bbox contains the whole of Bosnia and Herzegovina plus slices of
// Serbia, Hungary, Slovenia, Italy and Austria, and `HR.pmtiles` came out at
// 750 MiB against BA's 254 MiB despite covering a *smaller* country. The
// same 2x waste applies to the shared hillshade: the union bbox of all five
// regions is 547,607 km² against 275,707 km² of actual boundary area, so
// half that archive was Adriatic and foreign territory.
//
// Why tile squares rather than the boundary polygon itself: the extracts
// deliberately reach *past* the border. A strict cutline right on the
// administrative line dropped a whole diagonal block of tiles just past it
// (confirmed 19.08.2026 against Maglić, whose summit sits ON the BA/ME
// border — a border-ridge trail's far side was simply not in the download).
// Snapping to a tile grid and dilating by whole tiles reproduces that
// padding in the same units the archive is actually stored in.
//
// The z13/dilate-3 defaults were measured, not guessed. One z13 tile is
// ~3.45 km wide at these latitudes, so 3 tiles is ~10.4 km — inside the
// 8-11 km that `border_pad_deg=0.1` actually delivered (0.1° is ~11.1 km of
// latitude, ~8.0 km of longitude at 44°N), so this cannot regress the Maglić
// fix. Resulting mask area against boundary area, and the padded bbox it
// replaces:
//
//        mask   bbox        mask   bbox
//   BA  1.36x  2.06x    RS  1.32x  2.06x
//   HR  1.35x  2.55x    SI  1.61x  2.36x
//   ME  1.63x  2.53x
//
// Coarser grids fit worse (z12/dilate-2 = 13.8 km pad, BA 1.51x) and finer
// ones only add rectangles for no gain (z14/dilate-5 = 8.6 km pad, BA 1.29x
// but twice the rings). Small countries sit higher because a fixed border pad
// is a larger share of a small area — that is the pad doing its job, not the
// mask fitting badly.
//
// Multiple inputs are unioned into one mask (that's how the shared regional
// hillshade covers all five regions in a single extract).
//
// Usage:
//   node region-mask.js build/boundaries/BA.geojson > build/masks/BA.geojson
//   node region-mask.js --dilate=4 build/boundaries/*.geojson > mask.geojson

const fs = require('fs');

const DEFAULT_ZOOM = 13;
const DEFAULT_DILATE = 3;

function parseArgs(argv) {
  let zoom = DEFAULT_ZOOM;
  let dilate = DEFAULT_DILATE;
  const paths = [];
  for (const arg of argv) {
    const zoomMatch = arg.match(/^--zoom=(\d+)$/);
    const dilateMatch = arg.match(/^--dilate=(\d+)$/);
    if (zoomMatch) zoom = Number(zoomMatch[1]);
    else if (dilateMatch) dilate = Number(dilateMatch[1]);
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else paths.push(arg);
  }
  return {zoom, dilate, paths};
}

function lonToTileX(lon, scale) {
  return ((lon + 180) / 360) * scale;
}

// Web-Mercator latitude → fractional tile Y. Clamped short of the poles
// because the projection diverges there and country boundaries never need
// it.
function latToTileY(lat, scale) {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  const rad = (clamped * Math.PI) / 180;
  const merc = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
  return ((1 - merc / Math.PI) / 2) * scale;
}

function tileXToLon(x, scale) {
  return (x / scale) * 360 - 180;
}

function tileYToLat(y, scale) {
  const merc = Math.PI * (1 - (2 * y) / scale);
  return (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
}

/// Every polygon (as an array of rings) across every input file. Rings stay
/// grouped by polygon so the even-odd fill below sees a polygon's holes but
/// not an unrelated polygon's — two separate islands must not cancel each
/// other out.
function readPolygons(paths) {
  const polygons = [];
  const pushGeometry = (geometry) => {
    if (!geometry) return;
    if (geometry.type === 'Polygon') polygons.push(geometry.coordinates);
    else if (geometry.type === 'MultiPolygon') polygons.push(...geometry.coordinates);
    else if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries ?? []) pushGeometry(child);
    }
  };
  for (const path of paths) {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (parsed.type === 'FeatureCollection') {
      for (const feature of parsed.features ?? []) pushGeometry(feature.geometry);
    } else if (parsed.type === 'Feature') {
      pushGeometry(parsed.geometry);
    } else {
      pushGeometry(parsed);
    }
  }
  return polygons;
}

function key(x, y) {
  return `${x},${y}`;
}

/// Marks every tile a segment passes through, not just the ones its
/// endpoints land in — a "supercover" walk rather than plain Bresenham, so a
/// segment clipping the corner of a tile still marks it. Without this, a
/// coastline running diagonally through a tile could leave that tile
/// unmarked and the scanline below wouldn't catch it either (its centre line
/// may miss the geometry entirely).
function markSegment(tiles, x0, y0, x1, y1) {
  let tileX = Math.floor(x0);
  let tileY = Math.floor(y0);
  const endX = Math.floor(x1);
  const endY = Math.floor(y1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;

  tiles.add(key(tileX, tileY));
  if (tileX === endX && tileY === endY) return;

  // Distance along the segment (as a 0..1 fraction) to the next vertical and
  // horizontal grid line, and how much a full tile step costs.
  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
  let tMaxX = dx === 0
    ? Infinity
    : Math.abs(((dx > 0 ? tileX + 1 : tileX) - x0) / dx);
  let tMaxY = dy === 0
    ? Infinity
    : Math.abs(((dy > 0 ? tileY + 1 : tileY) - y0) / dy);

  // Bounded by the real tile span plus slack rather than `while (true)` —
  // floating-point ties on an exact grid line must not turn into a hang.
  const maxSteps = Math.abs(endX - tileX) + Math.abs(endY - tileY) + 2;
  for (let step = 0; step < maxSteps; step += 1) {
    if (tMaxX < tMaxY) {
      tileX += stepX;
      tMaxX += tDeltaX;
    } else {
      tileY += stepY;
      tMaxY += tDeltaY;
    }
    tiles.add(key(tileX, tileY));
    if (tileX === endX && tileY === endY) return;
  }
}

/// Even-odd scanline fill along each tile row's centre latitude. This is what
/// fills a country's interior; [markSegment] only covers the outline.
function fillPolygon(tiles, polygon, scale) {
  const rings = polygon.map((ring) => {
    const projected = ring.map(([lon, lat]) => [
      lonToTileX(lon, scale),
      latToTileY(lat, scale),
    ]);
    // Both loops below read `ring[i]`/`ring[i + 1]` up to `length - 1`, i.e.
    // they assume the ring repeats its first point last. poly2geojson.js does
    // close its rings, but an unclosed input would silently drop the closing
    // edge — and that edge is exactly the one an even-odd fill needs.
    const [firstX, firstY] = projected[0];
    const [lastX, lastY] = projected[projected.length - 1];
    if (firstX !== lastX || firstY !== lastY) projected.push([firstX, firstY]);
    return projected;
  });

  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [, y] of ring) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minY)) return;

  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      markSegment(tiles, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
    }
  }

  for (let row = Math.floor(minY); row <= Math.floor(maxY); row += 1) {
    const scanY = row + 0.5;
    const crossings = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[i + 1];
        if (ay > scanY === by > scanY) continue;
        crossings.push(ax + ((scanY - ay) / (by - ay)) * (bx - ax));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.floor(crossings[i]);
      const to = Math.floor(crossings[i + 1]);
      for (let column = from; column <= to; column += 1) {
        tiles.add(key(column, row));
      }
    }
  }
}

function dilateTiles(tiles, radius, scale) {
  if (radius <= 0) return tiles;
  const grown = new Set();
  const limit = scale - 1;
  for (const entry of tiles) {
    const [x, y] = entry.split(',').map(Number);
    for (let dy = -radius; dy <= radius; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny > limit) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        // Wraps in X so a mask touching the antimeridian stays contiguous;
        // Y is clamped above because there is nothing past the poles.
        const nx = ((x + dx) % scale + scale) % scale;
        grown.add(key(nx, ny));
      }
    }
  }
  return grown;
}

/// Greedily merges the tile set into as few axis-aligned rectangles as
/// possible: horizontal runs first, then each run extended downward while
/// the row below has an identical run. A per-tile polygon would be tens of
/// thousands of rings for a country-sized mask; this keeps it in the
/// hundreds.
function toRectangles(tiles) {
  const rowRuns = new Map();
  const byRow = new Map();
  for (const entry of tiles) {
    const [x, y] = entry.split(',').map(Number);
    if (!byRow.has(y)) byRow.set(y, []);
    byRow.get(y).push(x);
  }
  for (const [row, columns] of byRow) {
    columns.sort((a, b) => a - b);
    const runs = [];
    let start = columns[0];
    let previous = columns[0];
    for (let i = 1; i < columns.length; i += 1) {
      if (columns[i] === previous + 1) {
        previous = columns[i];
        continue;
      }
      runs.push([start, previous]);
      start = columns[i];
      previous = columns[i];
    }
    runs.push([start, previous]);
    rowRuns.set(row, runs);
  }

  const rectangles = [];
  const consumed = new Set();
  const sortedRows = [...rowRuns.keys()].sort((a, b) => a - b);
  for (const row of sortedRows) {
    for (const [fromColumn, toColumn] of rowRuns.get(row)) {
      const runKey = `${row}:${fromColumn}-${toColumn}`;
      if (consumed.has(runKey)) continue;
      let lastRow = row;
      while (true) {
        const nextRow = lastRow + 1;
        const nextRuns = rowRuns.get(nextRow);
        if (!nextRuns) break;
        const match = nextRuns.some(([a, b]) => a === fromColumn && b === toColumn);
        if (!match) break;
        consumed.add(`${nextRow}:${fromColumn}-${toColumn}`);
        lastRow = nextRow;
      }
      rectangles.push({fromColumn, toColumn, fromRow: row, toRow: lastRow});
    }
  }
  return rectangles;
}

const {zoom, dilate, paths} = parseArgs(process.argv.slice(2));
if (paths.length === 0) {
  console.error(
    `Usage: node region-mask.js [--zoom=${DEFAULT_ZOOM}] ` +
      `[--dilate=${DEFAULT_DILATE}] <boundary.geojson>...`,
  );
  process.exit(1);
}

const scale = 2 ** zoom;
const polygons = readPolygons(paths);
if (polygons.length === 0) {
  console.error(`region-mask: no polygons found in ${paths.join(', ')}`);
  process.exit(1);
}

let tiles = new Set();
for (const polygon of polygons) fillPolygon(tiles, polygon, scale);
tiles = dilateTiles(tiles, dilate, scale);

const coordinates = toRectangles(tiles).map(
  ({fromColumn, toColumn, fromRow, toRow}) => {
    const west = tileXToLon(fromColumn, scale);
    const east = tileXToLon(toColumn + 1, scale);
    const north = tileYToLat(fromRow, scale);
    const south = tileYToLat(toRow + 1, scale);
    return [[
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ]];
  },
);

process.stderr.write(
  `region-mask: ${tiles.size} z${zoom} tiles (dilate ${dilate}) -> ` +
    `${coordinates.length} rectangles\n`,
);

process.stdout.write(
  `${JSON.stringify({
    type: 'Feature',
    properties: {zoom, dilate, tiles: tiles.size},
    geometry: {type: 'MultiPolygon', coordinates},
  })}\n`,
);
