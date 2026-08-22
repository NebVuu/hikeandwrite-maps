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

`versatiles convert` can only cut a rectangle, and a country's rectangle is
much bigger than the country — measured padded-bbox area against boundary
area: BA 2.06x, RS 2.06x, SI 2.36x, ME 2.53x, HR 2.55x. Croatia is a
crescent, so its bbox contained the whole of Bosnia and Herzegovina plus
slices of five other countries; `HR.pmtiles` was 750 MiB against BA's 254 MiB
while covering a *smaller* country, and anyone downloading both paid for
Bosnia twice. So a second pass (`pmtiles extract --region`) clips the local
file down to a tile-aligned mask of the boundary itself — see
`scripts/region-mask.js` for why tile squares rather than the polygon, and
for the measured border pad it preserves. Resulting mask area against
boundary area: BA 1.36x, HR 1.35x, ME 1.63x, RS 1.32x, SI 1.61x.

`scripts/filter-basemap-layers.sh` then drops every Shortbread layer the app
can't draw. `versatiles convert` copies whole tiles and has no layer filter,
so `addresses` (every house number in the country, z14), `buildings` (every
footprint, z14), `pois`, `sites`, `public_transport`, `street_polygons`,
`bridges`, `ferries` and the dam/pier layers were all being downloaded and
never rendered. That script carries the allowlist of what survives — a
single-file `tile-join` pass, not a merge with anything else (see "Contours"
below for why that split matters).

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
~300MB each) to **one** file (`dist/hillshade.pmtiles`) covering every
`regions/*.yml` entry. First published at maxzoom 11 (measured 850MB) —
confirmed too slow/heavy on a real device (multi-minute download, an
interrupted-stream error), so dropped to maxzoom 10 (measured ~308MB via
`go-pmtiles extract --dry-run` against Mapterhorn directly: z12=2.1GB,
z11=850MB, z10=308MB, z9=107MB). z10 is visibly softer at close hiking zoom
than z11 was — accepted since contours (10m interval) carry the app's real
terrain-reading detail; hillshade is a soft base under them, not the main
event. The app downloads this file once, ever, regardless of how many
countries get added (see `offline-maps-rearchitecture` in the HikeAndWrite
repo).

Those numbers were measured against a single union **bbox**, which turned out
to be half waste: 547,607 km² covered against 275,707 km² of actual boundary
area, i.e. roughly every second byte was Adriatic or foreign territory. It now
extracts against the same tile-aligned mask the basemaps use
(`scripts/region-mask.js`, unioned over all five regions), covering
328,425 km² — 60% of that bbox for the same real coverage. **The zoom choice
is therefore open again:** re-run `pmtiles extract --dry-run` against the mask
before assuming z10 is still the right ceiling, since z11 may now cost about
what unclipped z10 did.

## Contours (own file per region, downloaded alongside the basemap)

`scripts/build-contours.sh` generates 10m-interval contour lines from
Copernicus GLO-30 DEM data (the same free source Mapterhorn's hillshade
already uses outside Switzerland) — `gdalbuildvrt` + `gdalwarp` (clip to the
region's tile mask) + `gdal_contour` (extract lines as GeoJSON) + `tippecanoe`
(build the vector tiles). `scripts/dem-tiles.js` works out which 1°×1°
Copernicus tiles cover a region's boundary and prints their (verified, public,
no-credentials-needed) download URLs.

The `gdalwarp -cutline` against `scripts/region-mask.js`' output matters more
here than anywhere else in the pipeline: "Build contours" is by far its
slowest step (64 min for five regions on a single runner), and every hectare
the cutline removes is contour lines never generated, simplified, tiered or
tiled. The 19.08.2026 objection to a cutline was about cutting on the
administrative border itself — this mask is already padded ~10.4 km past it,
so the Maglić fix stands.

Extended 21.08.2026 from the original BA-only trial (19.08.2026) to every
region in `regions/*.yml`. That same day it was folded into the basemap file
via `tile-join` to cut the download to one file per country — **reverted
22.08.2026**: that merge was silently discarding ~95% of the contour
features on every real build tested (confirmed with a same-region,
same-input A/B across four `tile-join` flag combinations, none of which
changed the result), consistent with an open, unresolved upstream bug
merging PMTiles archives in this exact tippecanoe fork
([felt/tippecanoe#278](https://github.com/felt/tippecanoe/issues/278) —
crashes and corrupted-geometry errors on the same operation). Checked how
Mapbox Outdoors and OpenAndroMaps do this: neither merges contours into the
basemap file either — both ship them as their own tileset/source. Contours
publish as `dist/<ISO>_contours.pmtiles` again, its own release asset and
its own `contours` entry in `dist/maps.json` per country, and the app
downloads it alongside the basemap under the same single download action
(see `offline-maps-rearchitecture` in the HikeAndWrite repo) — the user
still only taps one button; there are just two files behind it, the same
shape the shared hillshade download already has.

Known limitation, not yet resolved: even before that merge, the standalone
tippecanoe build's own `dropped_by_rate` accounting shows a large fraction
of generated contour lines being discarded somewhere inside tippecanoe's
own build (predates and is independent of the tile-join issue above — it
was already the cause of the "too sparse" complaint on 20.08.2026, before
contours were ever merged into anything). Diagnostic tooling for this is
on the `contour-investigation` branch (`scripts/diagnose-contour-input.js`,
`scripts/diagnose-contours.js --all-tiles`), not yet run to a conclusion.

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

`maxzoom` here is a request, not a guarantee — see the 21.08.2026 note
above. `scripts/validate-maxzoom.sh` (see "Publishing" below) fails the
build if a region's published file doesn't actually reach it.

## Publishing

`.github/workflows/build-maps.yml` runs on a push to `main` that touches
`scripts/`, `regions/` or the workflow itself, weekly, and on manual
dispatch — as three jobs: `discover` turns `regions/*.yml` into a matrix,
`region` builds one country per runner (basemap → contours → filter →
validate `max_zoom`) and uploads both `.pmtiles` files as one artifact, and
`publish` collects those artifacts, builds the one shared hillshade from
every region's boundary, writes the manifest and uploads the release.

The push trigger is path-scoped so a docs commit doesn't spend 25 minutes of
runners rebuilding identical tiles, and the whole workflow runs under one
global `concurrency` group with `cancel-in-progress` — the publish job
uploads to a fixed release tag with `--clobber`, so two overlapping runs
would race to overwrite each other's assets.

It used to be a single job looping over the regions serially. Two measured
reasons it isn't: the first full run took ~1h15m with the contour step alone
accounting for 64 min, and one runner has only ~14GB free — which the
basemaps plus a region's intermediate DEM and GeoJSON already strain
(`build-contours.sh` deletes its largest intermediate mid-run for exactly
that reason). Per-region runners give each region its own disk and cut
wall-clock to roughly the slowest single region.

`scripts/validate-maxzoom.sh` runs per region, before its artifact upload, so
a build silently capped below what `regions/<iso>.yml` asked for blocks
publishing rather than getting recorded in the manifest — see the 21.08.2026
note above for the incident it exists to catch.

Assets go to the `maps-v5` GitHub Release, overwriting that release's assets
each run (`gh release upload --clobber`) rather than creating a new dated
release each time — the app always points at the same release tag. v5 rather
than v4 because the *file layout* changed again (contours split back out into
their own asset per country), so clients must re-download; the app has a
`mapFormatVersion` migration for exactly this. `maps-v4`, `maps-v3` and
`maps-v2` all stay published, untouched, until an app build using `maps-v5`
has actually shipped — the base URL is a build-time `--dart-define`, so
there's no way for one app binary to handle more than one layout, and a
client pointed at a tag that no longer exists has no fallback.

## Local run order

Requires `versatiles`, `pmtiles`, `yq`, `node`, GDAL (`gdalbuildvrt`,
`gdalwarp`, `gdal_contour`, `ogr2ogr`) and `tippecanoe` (which also provides
`tile-join`) on `PATH`. Per region, in this order — each step depends on the
previous one's output:

```sh
for region in regions/*.yml; do
  scripts/build-region.sh "$region"             # basemap + boundary + tile mask
  scripts/build-contours.sh "$region"           # needs the boundary and the mask
  scripts/filter-basemap-layers.sh "$region"    # drop unused layers, basemap only
done
scripts/build-hillshade-regional.sh regions/*.yml   # needs every boundary
scripts/merge-manifest.sh                           # needs every final file
```

Output lands in `dist/` (gitignored): `<ISO>.pmtiles` and `<ISO>_contours.pmtiles`
per region, one shared `hillshade.pmtiles`, and `maps.json`.
