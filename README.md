# Reversed Earth

[![CI](https://github.com/kassoulet/reversed-earth/actions/workflows/ci.yml/badge.svg)](https://github.com/kassoulet/reversed-earth/actions/workflows/ci.yml)
[![Deploy to GitHub Pages](https://github.com/kassoulet/reversed-earth/actions/workflows/pages.yml/badge.svg)](https://github.com/kassoulet/reversed-earth/actions/workflows/pages.yml)
[![Live smoke test](https://github.com/kassoulet/reversed-earth/actions/workflows/live-smoke.yml/badge.svg)](https://github.com/kassoulet/reversed-earth/actions/workflows/live-smoke.yml)
[![Live site](https://img.shields.io/badge/live-kassoulet.github.io%2Freversed--earth-2f6b57)](https://kassoulet.github.io/reversed-earth/)

Reversed Earth is a static, south-up world map built from Natural Earth data.

- **South is up, north is down, east and west are unchanged.**
- Antarctica is at the top, Australia and South America in the upper half,
  Europe in the lower half, and Canada below the United States.
- Labels stay upright and readable.
- A **South up / North up** switch compares the same data in either
  orientation. North-up is derived in the browser from the same archive, with
  no second download and no mirrored text.
- The address bar stores **real geographic coordinates**, so a copied URL opens
  the same place in either orientation.
- Search by place name or by coordinates such as `48.8566, 2.3522`.
- No tile server, no database, no runtime backend: MapLibre GL JS reads its
  PMTiles archives directly in the browser.

The default V1 archive is generated entirely from Natural Earth, inverted at
the **geometry** level, not with CSS, a rotated camera or a mirrored canvas.

```
Pinned Natural Earth GeoJSON + shaded-relief / land-cover rasters
      │
      ▼
build_natural_earth.py        build_terrain.py
      │   display lat = -lat        │   warp, derive hillshade/forest
      │   clip per tile, write MVT  │   write WebP raster tiles
      ▼                            ▼
world.pmtiles (z0–z6)        hillshade/forest-{south,north}.pmtiles (z0–z5)
      └──────────────┬─────────────┘
                     ▼
MapLibre GL JS + pmtiles protocol, static on GitHub Pages
```

The generated vector archive is about **5.3 MB**; the four raster overlays add
about **29 MB**. None of them are committed. Until they are built and
published, the viewer shows a clear “Map data not built yet” panel.

## Map experience

- A “Reversed Earth” splash screen in Roboto Thin holds for at least two seconds
  and until the first map frame, then fades into the fullscreen, responsive
  MapLibre viewer. It uses the warm map background and an indeterminate
  progress bar. The opening is capped at four seconds.
- Drag, wheel/trackpad zoom, touch drag, pinch zoom and keyboard navigation.
- `+` / `−` controls (top right).
- A live scale bar and the current center's real latitude/longitude sit above the
  attribution. Both update while panning and zooming and keep real coordinates
  in either orientation.
- Native **z0–z6** data, overzoom to z14. No duplicated geometry is stored for
  overzoom.
- Progressive detail: land, ice sheets, lakes, ocean/sea labels and physical
  region labels at world scale, country boundaries, rivers, capitals, cities
  and towns as you zoom in. Named lakes and rivers appear from z4. The
  highest-ranked Admin 1 boundaries and labels also appear at z4, with more
  labels joining at z5. At z5–z6 the map adds coral reefs, urban areas, parks,
  airports, ports, named mountain peaks, a denser road and railway network,
  and the fuller Admin 1 boundary and label selection. A transparent hillshade
  and forest cover are drawn from z0–z5, with named wetland polygons from
  Natural Earth at every zoom.
- Style in [`public/style.json`](public/style.json): warm land, blue water,
  muted country borders and a compact place-label hierarchy.
- Self-hosted Noto Sans glyphs; no runtime CDN dependency.
- Search combobox with keyboard navigation. Coordinates are parsed locally and
  place names use a bundled Natural Earth index, so no geocoding request leaves
  the browser.
- An information control explains the orientation, the data source and the
  coordinate contract.
- A legend control beside the information button explains the ice, terrain,
  forest, wetland, ocean and sea, physical region, and peak layers, and toggles
  the terrain, forest, and wetland layers on and off.
- A share control in the top-right controls sends the current view with the
  native share sheet where available and copies the URL to the clipboard
  otherwise. The share text names a nearby rendered city, town, region or
  country, and both paths use the same real-coordinate hash as the address bar.
- Click a place, airport, port, park, wetland, ocean/sea, physical region or
  mountain peak for a compact card with its category, population, IATA code,
  elevation or physical-region type where available, and real-world coordinates.

Rotation and pitch are deliberately disabled so the plan view stays
unambiguous. The map still behaves like a conventional pan/zoom viewer in every
other respect.

## Coordinate contract

Application code crosses between coordinate spaces only through
[`src/coordinates.ts`](src/coordinates.ts):

```ts
import { geoToDisplay, displayToGeo } from "./coordinates";

geoToDisplay(1.44, 43.6);    // [1.44, -43.6]  (Toulouse)
displayToGeo(1.44, -43.6);   // [1.44, 43.6]
```

```text
display_latitude  = -latitude
display_longitude = longitude
```

External/domain coordinates, search results and the URL stay conventional
longitude/latitude. Display coordinates are only used for the map view and
tiles. The transformation is its own inverse and rejects invalid latitudes.

The archive metadata must contain `"south_up": true`. The app refuses to render
a PMTiles archive without it, so a north-up tile set cannot accidentally be
displayed under a “South is up” badge.

## URL state

The canonical view is stored in the hash:

```text
#map=6/43.60/1.44
```

- The parts are **zoom / real latitude / real longitude**.
- Latitude and longitude are conventional north- and east-positive values, even
  while the map is displayed south-up.
- Loading a link converts those real coordinates through `geoToDisplay()` before
  centering MapLibre.
- `?orientation=north` is present only for the north-up comparison. The default
  south-up view omits it.
- Query options such as `?pmtiles=` and `?orientation=` are preserved.
- Query-form links with `lat`/`lon`/`z` (or `latitude`/`longitude`/`lng`/`zoom`)
  still load for compatibility, but new links use the `#map=` form.
- Updates use `history.replaceState`, so panning does not fill the back button
  history.

The display-to-real conversion happens in
[`src/url-state.ts`](src/url-state.ts), with tests in
[`src/url-state.test.ts`](src/url-state.test.ts).

## North-up comparison

The default view is south-up. The orientation switch never rotates the camera,
flips the canvas or mirrors labels. Instead, a MapLibre tile protocol derives
north-up tiles from the same south-up archive:

1. For a requested display tile `(z, x, y)`, read the complementary row
   `(2^z - 1) - y` from the archive.
2. Invert every feature's y coordinate back with `extent - y` and reverse
   polygon rings to restore winding.
3. Return a normal MVT tile to MapLibre. Labels and symbols render upright.

The inversion is covered by [`src/north-up.test.ts`](src/north-up.test.ts) and
costs no extra storage. Switching orientation keeps the same geographic place
at the center and keeps the URL in real coordinates.

## Search

`src/search.ts` accepts decimal degrees in `latitude, longitude` order, with
optional hemisphere letters (`48.8566 N, 2.3522 E`). It also searches a bundled
index of 7,342 populated places from Natural Earth 1:10m. The index loads on
first use (about 370 KB) and matching is accent- and case-insensitive. The
combobox supports arrow keys, Enter and Escape.

Search is intentionally offline: there is no Nominatim, Photon or other
geocoding call at runtime, so it works on a static host and does not leak
queries. It does not cover street addresses or individual businesses.

## Quick start (viewer only)

```bash
npm install
npm run dev
```

The map data panel explains that the map archives in `public/data/` are
missing. Build them once with the steps below, or test with a vector archive
elsewhere:

```bash
VITE_PMTILES_URL=https://example.com/world.pmtiles npm run dev
# or at runtime:
# http://localhost:5173/?pmtiles=https://example.com/world.pmtiles
```

## Build the map

Requirements: Python 3.10+ and about 1.5 GB of free disk while the raster
sources are cached. No Java, no OSM PBF and no Planetiler run are needed.

```bash
python3 -m venv map-build/.venv
map-build/.venv/bin/pip install -r map-build/requirements.txt

npm run map:build
```

`map:build` downloads the pinned Natural Earth GeoJSON and raster sources into
`map-build/.cache/`, verifies their SHA-256 checksums, builds the vector archive
and the four terrain overlays, and writes everything to `public/data/`. A full
build takes roughly three minutes on a typical laptop. Use `--report` to write
JSON summaries:

```bash
map-build/.venv/bin/python map-build/natural-earth/build_natural_earth.py \
  --force --report map-build/.work/natural-earth-report.json
map-build/.venv/bin/python map-build/natural-earth/build_terrain.py \
  --force --report map-build/.work/natural-earth-terrain-report.json
```

To rebuild only the raster overlays, run `npm run map:build:terrain`.

The builder is deliberately database-free:

- 110m data for z0–z2, 50m for z3–z4, 10m for z5–z6.
- Latitude is negated while projecting, so the tile grid itself is south-up.
- Geometry is clipped to the display world, which keeps polar rings valid.
- Multi-geometries are split into small indexed parts before per-tile clipping.
- MVT layers: `land`, `glacier`, `water`, `wetland`, `reef`, `urban`, `park`,
  `boundary`, `waterway`, `place`, `road`, `railway`, `airport`, `port`,
  `marine`, `physio`, `peak`.
- Terrain overlays: shaded relief and a land-cover forest mask, warped to Web
  Mercator and written as south-up and north-up WebP PMTiles at z0–z5.
- Admin 1 label anchors use Natural Earth's `min_label`/`labelrank` hints, so
  the z4–z6 set grows gradually instead of showing every subdivision.
- PMTiles metadata records `south_up=true`, the transform and the source commit.

See [`map-build/README.md`](map-build/README.md) for the layer schema and
tuning.

### Optional OSM build

The older Planetiler/OpenMapTiles path is retained for a future V2 with denser
detail. It is not used by the default site:

```bash
npm run map:build:osm -- --pbf /data/planet-260101.osm.pbf --heap 48g
```

That path requires Java 25+, a planet PBF and a machine with roughly 0.5× the
PBF size in RAM. It produces the same south-up contract, but its OpenMapTiles
schema is not consumed by the default Natural Earth style.

## Verification

```bash
npm run typecheck
npm test
npm run map:test
npm run build
npm run size:check
npm run test:browser
```

The TypeScript tests cover the coordinate contract, URL state, north-up tile
inversion, coordinate parsing, place ranking, inspect cards and scale-bar
selection. The Python tests cover the Natural Earth projection, geometry
cleanup, part splitting, tile encoding, the generated vector and raster PMTiles
archives (when present), the hillshade/forest masks and the optional MVT
latitude-flip transform. The browser smoke test checks the splash background and its
indeterminate progress bar, then starts the built site in headless Chrome and
asserts that the z6 Admin 1 boundaries, urban areas, parks, airports, roads,
railways and region labels are actually rendered, checks the selected Admin 1
boundaries and labels at z4, toggles the terrain, forest and wetland layers,
then switches to north-up and back, and exercises keyboard selection of both a
place result and a coordinate result. It also checks that the share control passes the current URL to the
native share sheet and, when sharing is unavailable, copies it to the
clipboard, and that the share text names the nearby place. Click-to-inspect
cards are opened for a place, airport, park, port, ocean/sea label, physical
region and mountain peak, and the card's real-world coordinates are checked in
both orientations. The legend contents are checked, and the world view is also
checked for rendered ice sheets and ocean labels, and the lake and river label
layers are checked at load. The live scale bar and center readout are checked
before and after a search flight. And it checks that the
share URL keeps real geographic coordinates through orientation and search
changes. It
needs the vector and terrain archives in `dist/data/` and a local Chrome or
Chromium (override the binary with `CHROME_PATH`). Set
`SMOKE_URL=https://<account>.github.io/<repository>/` to run the same checks
against a deployed Pages site instead of a local preview.

The **Live smoke test** workflow runs that deployed-site check against the
project Pages URL every day at 04:17 UTC, and can be started manually from the
Actions tab.

## Deploy to GitHub Pages

The workflow is [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

1. Build the archives as above, or let the **Publish map data** workflow do it.
2. Publish them as release assets with the exact names **`world.pmtiles`**,
   **`hillshade-south.pmtiles`**, **`hillshade-north.pmtiles`**,
   **`forest-south.pmtiles`** and **`forest-north.pmtiles`**. The release is
   just storage; the Pages site contains a copy, so no runtime asset server is
   involved.

   The workflow builds, checks the storage budget and archive schemas, and
   attaches the five archives, a combined checksum file and both build reports.
   Run **Actions → Publish map data → Run workflow**, or push a tag:

   ```bash
   git tag map-data-2026-10
   git push origin map-data-2026-10
   ```

   The manual equivalent is still:

   ```bash
   (cd public/data && sha256sum *.pmtiles > world.pmtiles.sha256)
   gh release create map-data-2026-10 \
     --title "Map data 2026-10" \
     public/data/*.pmtiles \
     public/data/world.pmtiles.sha256
   ```

3. In **Settings → Pages**, set **Source** to **GitHub Actions**.
4. Push to `main`, run **Deploy to GitHub Pages** manually, or let a successful
   **Publish map data** run trigger it automatically.

The workflow installs and tests the app, downloads the map archives and
checksum file from the latest release if they are not already in
`public/data/`, verifies every checksum, builds with the correct Pages base
path, enforces the storage budget and deploys only static files. If the release
predates the terrain overlays, it builds the four overlays from the pinned
Natural Earth rasters instead of failing. A failed release build does not
trigger a deployment.

If you use a custom domain instead of the default `github.io` URL, set
`VITE_BASE=/` for the build because a custom domain serves the site from its
root. Also update the canonical URL, `og:url` and the absolute `og:image` and
`twitter:image` URLs in [`index.html`](index.html) to the new origin.

The app resolves its style, glyphs, vector archive and terrain overlays against
the Vite base URL, so project-site subpaths work without hard-coded `/` paths.
The vector PMTiles URL can also be set with `VITE_PMTILES_URL` or `?pmtiles=`.

## Project layout

```text
index.html                  fullscreen viewer shell
src/
  main.ts                   boot, loading/data states, controls, URL and info wiring
  map.ts                    MapLibre setup, orientation styles, camera conversion
  url-state.ts              #map=zoom/lat/lon real-coordinate URL state
  north-up.ts               client-side MVT inversion + north-up tile protocol
  search.ts                 coordinate parsing, place index, ranking
  search-control.ts         accessible search combobox
  archive.ts                PMTiles preflight + south_up contract
  coordinates.ts            geoToDisplay / displayToGeo
  feature-card.ts           click-to-inspect card models and formatting
  share-caption.ts          nearby place/region caption for the share sheet
  scale.ts                  Web Mercator scale-bar calculation
  styles/app.css            minimal UI
public/
  favicon.svg, favicon.ico  browser icon
  og-image.png              1200×630 social preview
  style.json                Natural Earth style
  fonts/                    self-hosted Noto Sans glyphs and Roboto Thin
  data/places.json          offline Natural Earth place index
  data/                    destination for the map archives (gitignored)
map-build/
  natural-earth/            default V1 vector and terrain builders + tests
  transformations/          optional OSM MVT latitude inversion + tests
  scripts/check-size.mjs    deployment size gate
.github/workflows/          CI, Pages, map-data release and live smoke
```

## Data and licensing

- Application code: MIT (see [`LICENSE`](LICENSE)).
- Map data: Natural Earth, public domain.
  <https://www.naturalearthdata.com/>
- Urban areas, airports, ports, parks, glaciers, coral reefs, marine labels,
  wetlands, physical regions and mountain peaks: Natural Earth, public domain.
- Hillshade: Natural Earth 1:10m shaded relief, public domain.
- Forest cover: derived from Natural Earth I 1:10m land cover, public domain.
- Place index: Natural Earth 1:10m populated places, public domain.
- Map glyphs: Noto Sans, SIL Open Font License 1.1, self-hosted under
  [`public/fonts/`](public/fonts/).
- Splash font: Roboto Thin, SIL Open Font License 1.1, self-hosted under
  [`public/fonts/roboto/`](public/fonts/roboto/).
- The optional OSM build uses © OpenStreetMap contributors (ODbL 1.0) and the
  OpenMapTiles schema.

No attribution is required for the default Natural Earth map, but the viewer
keeps a source credit visible in the map and in the information panel.

## Limitations

- No buildings, addresses, indoor data or exhaustive POIs.
- Roads and railways are Natural Earth's sparse 1:10m selection, shown only at
  z5–z6; they are not an OSM-scale street network. Local roads appear at z6,
  not at country scale.
- Airports and ports are Natural Earth's selected global points, not an
  exhaustive directory. The park layer is Natural Earth's US National Park
  Service dataset, so parks are only shown in the United States.
- Native vector detail stops at z6; terrain overlays stop at z5. Higher zooms
  are overzoom.
- The forest wash is a cartographic classification of Natural Earth's
  land-cover raster, not a surveyed forest boundary. Grassland, cropland and
  desert are deliberately excluded.
- The archive is a snapshot of Natural Earth, not live data.
- Ocean/sea labels, glaciers and mountain peaks come from Natural Earth's
  selected 1:10m physical layers, not an exhaustive gazetteer.
- Place labels are point labels; dense areas can still overlap at low zoom.
