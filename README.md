# hikeandwrite-maps

Builds and publishes the offline country basemaps that the HikeAndWrite app
downloads (`OFFLINE_MAP_BASE_URL`, see `CountryMapDownloader` in the main
repo).

## Pipeline

Each region is extracted directly from
[VersaTiles' public planet-wide Shortbread build](https://docs.versatiles.org/guides/download_tiles.html)
(`download.versatiles.org/osm.versatiles`, maxzoom 14) — not built from
scratch. `versatiles convert` reads the source over HTTP byte-range
requests (confirmed in versatiles-rs' own source, not just docs), so this
never downloads the full ~60GB+ planet file, only the tiles inside the
requested region's bbox.

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

## Hillshade (trial, BA only)

`scripts/build-hillshade.sh` is a plain `pmtiles extract --bbox=...` against
Mapterhorn's public planet-wide Terrarium-encoded PMTiles archive
(`download.mapterhorn.com/planet.pmtiles`, Copernicus GLO-30, real data up
to z12 outside Switzerland) — same HTTP-range-request pattern as
`build-region.sh`'s basemap step, just a different source. No DEM
download, no GDAL, no separate raster bake/convert step: the extract is
already the finished, Terrarium-encoded output `hiking_map_style.dart`'s
`hillshade-dem` source expects.

Trial, BA only for now (see `.github/workflows/build-maps.yml`'s "Build BA
hillshade (trial)" step) — extend to `regions/*.yml` once the output's been
checked and looks right.

## Contours (trial, BA only)

`scripts/build-contours.sh` generates 20m-interval contour lines from
Copernicus GLO-30 DEM data (the same free source Mapterhorn's hillshade
already uses outside Switzerland) — `gdalbuildvrt` + `gdalwarp` (clip to the
region boundary) + `gdal_contour` (extract lines as GeoJSON) + `tippecanoe`
(build the vector tiles). `scripts/dem-tiles.js` works out which 1°×1°
Copernicus tiles cover a region's boundary and prints their (verified, public,
no-credentials-needed) download URLs.

This is a trial — see `.github/workflows/build-maps.yml`'s "Build BA
contours (trial)" step — run for `regions/ba.yml` only, and **not yet
verified end-to-end anywhere** (no GDAL/tippecanoe available on the machine
that wrote this). Check the actual output (`dist/BA_contours.pmtiles`, e.g.
via the `pmtiles.io` viewer) before trusting it or extending it to other
regions. Not wired into the app yet either — that's a separate step once the
tiles themselves look right.

## Adding a region

Add a `regions/<iso>.yml`:

```yaml
iso: BA
name: Bosna i Hercegovina
geofabrik_poly_url: https://download.geofabrik.de/europe/bosnia-herzegovina.poly
maxzoom: 14
```

`geofabrik_poly_url` only needs to point at a boundary outline (Geofabrik's
`.poly` files are convenient because one already exists per country/region)
— `scripts/poly2geojson.js` converts it to the GeoJSON `versatiles convert`
needs. The workflow picks up every file in `regions/` automatically.

## Running locally

Requires `versatiles` (versatiles-rs CLI), `pmtiles` (go-pmtiles CLI, used by
the hillshade step's Mapterhorn extract), `yq`, and Node on `PATH`.

```sh
scripts/build-region.sh regions/ba.yml
scripts/build-hillshade.sh regions/ba.yml
scripts/merge-manifest.sh
```

Output lands in `dist/` (gitignored) — `<ISO>.pmtiles`/`<ISO>_hillshade.pmtiles`
per region plus `maps.json`.

Contours additionally need `gdalbuildvrt`/`gdalwarp`/`gdal_contour` (GDAL)
and `tippecanoe` on `PATH`:

```sh
scripts/build-contours.sh regions/ba.yml
```

## Publishing

`.github/workflows/build-maps.yml` runs weekly (and on manual dispatch),
builds every region, and publishes the results to the `maps-v2` GitHub
Release, overwriting that release's assets each run (`gh release upload
--clobber`) rather than creating a new dated release each time — the app
always points at the same release tag.
