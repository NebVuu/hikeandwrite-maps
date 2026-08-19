# hikeandwrite-maps

Builds and publishes the offline country basemaps that the HikeAndWrite app
downloads (`OFFLINE_MAP_BASE_URL`, see `CountryMapDownloader` in the main
repo).

## Pipeline

Each region is extracted directly from
[Protomaps' public, weekly-updated planet-wide PMTiles build](https://docs.protomaps.com/basemaps/downloads)
(`build.protomaps.com/<date>.pmtiles`, maxzoom 15) — not built from scratch.
`pmtiles extract` reads the source over HTTP range requests, so this never
downloads the full ~120GB planet file, only the tiles inside the requested
region's boundary.

This replaced an earlier approach (see `TASKS.md` in the HikeAndWrite repo,
"Offline mape") that merged neighboring countries' Geofabrik `.osm.pbf`
extracts and ran Planetiler locally, to work around Geofabrik's per-country
cuts leaving border multipolygons (lakes, rivers) incomplete. Extracting
from a planet-wide source has no per-country cut to begin with, so that bug
class can't happen here — and it's far cheaper per region, since there's no
shared cluster build cost that grows with the number of neighboring
countries.

**Not covered by this pipeline:** hillshade/terrain relief (still an open,
separate problem — see `TASKS.md`, "Hillshade (teren) — NIJE riješeno") and
hiking-specific overlays like `sac_scale` trail grading or mountain-hut POIs
(Protomaps' basemap schema doesn't carry these — confirmed from its own
layer docs, only generic `kind_detail: path/cycleway/footway` on the roads
layer).

## Adding a region

Add a `regions/<iso>.yml`:

```yaml
iso: BA
name: Bosna i Hercegovina
geofabrik_poly_url: https://download.geofabrik.de/europe/bosnia-herzegovina.poly
maxzoom: 15
```

`geofabrik_poly_url` only needs to point at a boundary outline (Geofabrik's
`.poly` files are convenient because one already exists per country/region)
— `scripts/poly2geojson.js` converts it to the GeoJSON `pmtiles extract`
needs. The workflow picks up every file in `regions/` automatically.

## Running locally

Requires `pmtiles` (go-pmtiles CLI), `yq`, and Node on `PATH`.

```sh
scripts/build-region.sh regions/ba.yml
scripts/merge-manifest.sh
```

Output lands in `dist/` (gitignored) — `<ISO>.pmtiles` per region plus
`maps.json`.

## Publishing

`.github/workflows/build-maps.yml` runs weekly (and on manual dispatch),
builds every region, and publishes the results to the `maps-v2` GitHub
Release, overwriting that release's assets each run (`gh release upload
--clobber`) rather than creating a new dated release each time — the app
always points at the same release tag.
