# hikeandwrite-maps

Builds and publishes the offline country basemaps that the HikeAndWrite app
downloads (`OFFLINE_MAP_BASE_URL`, see `CountryMapDownloader` in the main
repo).

## Pipeline

Each region is extracted directly from
[VersaTiles' public planet-wide Shortbread build](https://docs.versatiles.org/guides/download_tiles.html)
(`download.versatiles.org/osm.versatiles`, maxzoom 14 — see
`regions/*.yml`) — not built from scratch. `versatiles convert` reads the
source over HTTP byte-range requests (confirmed in versatiles-rs' own
source, not just docs), so this never downloads the full ~60GB+ planet
file, only the tiles inside the requested region's bbox.

21.08.2026: tried raising `maxzoom` from 14 to 16 for more trail/POI
detail, then reverted — confirmed via the published `maps-v3` files' own
PMTiles headers (`min_zoom`/`max_zoom` bytes) that every region still came
out at max_zoom 14 regardless of the requested `--max-zoom`. VersaTiles'
`osm.versatiles` planet build is itself only built to z14 — there is no
deeper source data for `versatiles convert` to extract, so `regions/*.yml`
cannot ask for more than the source actually has. Getting real z15+ detail
would need a different/deeper upstream source, not a config change here.

19.08.2026: pivoted from Protomaps' basemap schema
(`build.protomaps.com`, maxzoom 15) to VersaTiles Shortbread — see
`TASKS.md` in the HikeAndWrite repo, "Offline mape" — for a minimal
outdoor-map look (forest/meadow/water/discreet roads) instead of a generic
city map. The "extract from an uncut planet-wide source" principle carries
over unchanged from the Protomaps era: this originally replaced merging
neighboring countries' Geofabrik `.osm.pbf` extracts and running Planetiler
locally, to work around Geofabrik's per-country cuts leaving border
multipolygons (lakes, rivers) incomplete. Extracting from a planet-wide
source has no per-country cut to begin with, so that bug class can't happen
here regardless of which planet-wide source is used.

**Not covered by this pipeline:** hiking-specific overlays like `sac_scale`
trail grading or mountain-hut POIs — Shortbread's basemap schema doesn't
carry these either (same limitation Protomaps had), only generic road
`kind`s on its `streets` layer. Hillshade/terrain relief and contours are
separate, own pipelines — see below.

## Hillshade (one shared regional file)

`scripts/build-hillshade-regional.sh` is a plain `pmtiles extract
--bbox=...` against Mapterhorn's public planet-wide Terrarium-encoded
PMTiles archive (`download.mapterhorn.com/planet.pmtiles`, Copernicus
GLO-30, real data up to z12 outside Switzerland) — same HTTP-range-request
pattern as `build-region.sh`'s basemap step, just a different source. No
DEM download, no GDAL, no separate raster bake/convert step: the extract
is already the finished, Terrarium-encoded output `hiking_map_style.dart`'s
`hillshade-dem` source expects.

21.08.2026: switched from a per-country extract (`<ISO>_hillshade.pmtiles`,
~300MB each) to **one** file (`dist/hillshade.pmtiles`) covering the union
bbox of every `regions/*.yml` entry. First published at maxzoom 11
(measured 850MB) — confirmed too slow/heavy on a real device (multi-minute
download, an interrupted-stream error), so dropped to maxzoom 10 (measured
~308MB via `go-pmtiles extract --dry-run` against Mapterhorn directly:
z12=2.1GB, z11=850MB, z10=308MB, z9=107MB). z10 is visibly softer at close
hiking zoom than z11 was — accepted since contours (10m interval) carry
the app's real terrain-reading detail; hillshade is a soft base under them,
not the main event. The app downloads this file once, ever, regardless of
how many countries get added (see `offline-maps-rearchitecture` in the
HikeAndWrite repo).

## Contours (all regions, merged into the basemap)

`scripts/build-contours.sh` generates 10m-interval contour lines from
Copernicus GLO-30 DEM data (the same free source Mapterhorn's hillshade
already uses outside Switzerland) — `gdalbuildvrt` + `gdalwarp` (clip to the
region boundary) + `gdal_contour` (extract lines as GeoJSON) + `tippecanoe`
(build the vector tiles). `scripts/dem-tiles.js` works out which 1°×1°
Copernicus tiles cover a region's boundary and prints their (verified, public,
no-credentials-needed) download URLs.

Extended 21.08.2026 from the original BA-only trial (19.08.2026) to every
region in `regions/*.yml`, and no longer published as its own
`<ISO>_contours.pmtiles` release asset: `scripts/merge-basemap-
contours.sh` runs `tile-join` right after, folding the `contours` layer
into that same region's `dist/<ISO>.pmtiles` and deleting the standalone
file — Shortbread's basemap layers and the `contours` layer don't share a
name, so this is a straight union, not a conflict to resolve. The app
downloads one vector file per country, not two.

## Adding a region

Add a `regions/<iso>.yml`:

```yaml
iso: BA
name: Bosna i Hercegovina
geofabrik_poly_url: https://download.geofabrik.de/europe/bosnia-herzegovina.poly
maxzoom: 16
```

`geofabrik_poly_url` only needs to point at a boundary outline (Geofabrik's
`.poly` files are convenient because one already exists per country/region)
— `scripts/poly2geojson.js` converts it to the GeoJSON `versatiles convert`
needs. The workflow picks up every file in `regions/` automatically.

## Running locally

Requires `versatiles` (versatiles-rs CLI), `pmtiles` (go-pmtiles CLI, used by
the hillshade step's Mapterhorn extract), `yq`, and Node on `PATH`.

```sh
for region in regions/*.yml; do scripts/build-region.sh "$region"; done
scripts/build-hillshade-regional.sh regions/*.yml
scripts/merge-manifest.sh
```

Output lands in `dist/` (gitignored) — `<ISO>.pmtiles` per region plus one
shared `hillshade.pmtiles` and `maps.json`.

Contours additionally need `gdalbuildvrt`/`gdalwarp`/`gdal_contour` (GDAL)
and `tippecanoe` (which also provides `tile-join`) on `PATH`, and must run
before the manifest step so each region's `<ISO>.pmtiles` already has its
contours merged in when `merge-manifest.js` reads its size:

```sh
for region in regions/*.yml; do
  scripts/build-contours.sh "$region"
  scripts/merge-basemap-contours.sh "$region"
done
```

## Publishing

`.github/workflows/build-maps.yml` runs weekly (and on manual dispatch),
builds every region, and publishes the results to the `maps-v3` GitHub
Release, overwriting that release's assets each run (`gh release upload
--clobber`) rather than creating a new dated release each time — the app
always points at the same release tag. `maps-v2` (the old per-country
3-file layout: separate basemap/hillshade/contours) stays published,
untouched, until an app build using `maps-v3` has actually shipped — the
base URL is a build-time `--dart-define`, so there's no way for one app
binary to handle both layouts.
