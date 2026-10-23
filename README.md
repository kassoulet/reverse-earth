# South Is Up

A static, south-up world map built from OpenStreetMap data.

- **South is up, north is down, east and west are unchanged.**
- Antarctica is at the top, Australia and South America in the upper half,
  Europe in the lower half, and Canada below the United States.
- Labels stay upright and readable.
- No tile server, no database, no runtime backend: MapLibre GL JS reads one
  PMTiles archive directly in the browser.
- The archive is generated with Planetiler and inverted at the **geometry**
  level, not with CSS, a rotated camera or a client-side hack.

The repository intentionally does **not** contain `world.pmtiles`. It is a
large generated artifact (target ≤ 850 MB). Until you build it or attach it to
a GitHub release, the viewer shows a clear "Map data not built yet" panel.

```
OpenStreetMap PBF
      │
      ▼
Planetiler + OpenMapTiles schema ──► world.mbtiles
      │                                   (normal orientation)
      ▼
flip_world.py: lat → −lat in every MVT tile
      │        tile y addresses + in-tile y + winding
      ▼
world.pmtiles (south-up geometry)
      │
      ▼
MapLibre GL JS + pmtiles protocol, static on GitHub Pages
```

## Why the data is transformed

This is not:

```css
transform: scaleY(-1);
```

and it is not a 180° camera rotation. Either would break east/west or turn
labels upside down.

The contract is:

```text
display_latitude  = -latitude
display_longitude = longitude
```

The latitude flip is applied by `map-build/transformations/flip_world.py`
between Planetiler's MBTiles output and the final PMTiles archive:

1. A Web Mercator tile at TMS row `r` becomes TMS row `2^z − 1 − r`.
   (In XYZ terms the output tile's y equals the source TMS row.)
2. Every y coordinate inside the tile becomes `extent − y`.
3. Geometry is decoded and re-encoded, so mirrored polygon rings keep correct
   winding and holes remain holes. Feature properties survive.
4. Point label anchors, line geometry and polygon geometry all move with the
   data. Glyph textures are **not** mirrored, so text stays upright.

The transform runs after tile generation on purpose. Planetiler's
OpenMapTiles profile also uses ocean polygons and Natural Earth sources; those
affect coastlines and low-zoom content and must be flipped consistently with
OSM geometry. Transforming the final MVT covers every source, plus clipping
and label anchor points. It is still pure geometry: the tiles themselves
contain the inverted world.

See [`map-build/transformations/flip_world.py`](map-build/transformations/flip_world.py)
for the implementation and the end-to-end test.

## Map experience

- Fullscreen, responsive MapLibre viewer.
- Drag, wheel/trackpad zoom, touch drag, pinch zoom and keyboard navigation.
- `+` / `−` controls (top right).
- Overzoom to **z14** from native z0–z9 (optional z10) data. No duplicated
  geometry is stored for overzoom.
- Progressive detail: land/ocean and countries first, then capitals, cities,
  major roads, railways, waterways, regional boundaries, towns and finer
  roads.
- Original style in [`public/style.json`](public/style.json): warm land,
  blue water, terracotta road hierarchy, muted borders and a clear place-label
  hierarchy.
- Self-hosted Noto Sans glyphs; no runtime CDN dependency.

Rotation and pitch are deliberately disabled so the south-up plan view stays
unambiguous. The map still behaves like a conventional pan/zoom viewer in every
other respect.

## Coordinate API

Application code crosses between coordinate spaces only through
[`src/coordinates.ts`](src/coordinates.ts):

```ts
import { geoToDisplay, displayToGeo } from "./coordinates";

geoToDisplay(1.44, 43.6);   // [1.44, -43.6]  (Toulouse)
displayToGeo(1.44, -43.6);  // [1.44, 43.6]

geoToDisplay(151.21, -33.87); // [151.21, 33.87] (Sydney)
```

External/domain coordinates stay conventional longitude/latitude. Display
coordinates are only used for the map view and tiles. The transformation is
its own inverse and rejects invalid latitudes.

The archive metadata must contain `"south_up": true`. The app refuses to render
a PMTiles archive without it, so a north-up tile set cannot accidentally be
displayed under a "South is up" badge.

## Quick start (viewer only)

```bash
npm install
npm run dev
```

The map data panel explains that `public/data/world.pmtiles` is missing. To test
with an archive elsewhere, pass a CORS/range-capable URL:

```bash
VITE_PMTILES_URL=https://example.com/world.pmtiles npm run dev
# or at runtime:
# http://localhost:5173/?pmtiles=https://example.com/world.pmtiles
```

For a local archive, place it at `public/data/world.pmtiles` before running the
build or dev server.

## Build the map

Full instructions and tuning are in [`map-build/README.md`](map-build/README.md).
The short version:

### Requirements

- **Java 25+** (Planetiler 0.10.2)
- Node.js 22+
- Python 3.10+ with the pinned transform dependencies
- A machine with roughly 0.5× the PBF size in RAM and 5–10× in free SSD space
- An OSM planet snapshot or a Geofabrik extract

The planet PBF, Planetiler cache, MBTiles and generated PMTiles are all ignored
by git.

### Install transform dependencies

```bash
python3 -m venv map-build/.venv
map-build/.venv/bin/pip install -r map-build/requirements.txt
```

### Build a planet archive

```bash
# Use a dated snapshot for reproducibility; any current planet PBF works.
npm run map:build -- --pbf /data/planet-260101.osm.pbf --heap 48g
```

This downloads the pinned Planetiler release, runs the OpenMapTiles profile,
inverts latitude in every tile, writes `public/data/world.pmtiles`, prints the
final size and enforces the archive budget. The input PBF is never modified or
deleted.

Native zoom 10 is attempted by default. If the finished archive exceeds the
850 MB budget, the wrapper automatically re-flips the same MBTiles at z9. You
can also request z9 directly:

```bash
npm run map:build -- --pbf /data/planet-260101.osm.pbf --heap 48g --maxzoom 9
```

`z0–z9` are mandatory; z10 is a budget-dependent bonus. An explicit
`--maxzoom 10` is respected and fails the size gate rather than silently
falling back. The viewer always allows overzoom to z14.

### Small end-to-end smoke build

```bash
npm run map:build -- --area monaco --maxzoom 10
```

Planetiler downloads a Monaco extract automatically. This exercises the same
Planetiler → flip → PMTiles → size gate path as the planet build.

## Storage budget

GitHub Pages has a 1 GB published-site limit. The pipeline enforces stricter
limits in [`map-build/configuration/size-budget.json`](map-build/configuration/size-budget.json):

| Artifact | Limit |
| --- | ---: |
| `world.pmtiles` | 850 MB |
| Complete deployment | 900 MB |
| GitHub Pages hard limit | 1 GB |

The deployment contains about 13 MB of app, worker and font glyph assets before
the archive, leaving margin under the hard limit. `check-size.mjs` prints the
largest files, the archive size, total size and headroom, and exits non-zero if
any configured limit is exceeded. It runs in the local build, CI and the Pages
deployment.

The map data is one PMTiles file. It is not split into thousands of files.

## Deploy to GitHub Pages

The workflow is [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

1. Build `world.pmtiles` as above.
2. Create a GitHub release in this repository and attach the file with the
   exact name **`world.pmtiles`**. The release is just storage; the Pages site
   contains a copy, so no runtime asset server is involved.

   ```bash
   gh release create map-data-2026-01 \
     --title "Map data 2026-01" \
     public/data/world.pmtiles
   ```

   The workflow uses the **latest** release, so make sure the asset is on it
   (or rerun the workflow after editing the release).
3. In **Settings → Pages**, set **Source** to **GitHub Actions**.
4. Push to `main` or run **Deploy to GitHub Pages** manually.

If you use a custom domain instead of the default `github.io` URL, set
`VITE_BASE=/` for the build (or adjust the base-path step in the workflow)
because a custom domain serves the site from its root.

The workflow:

- installs, typechecks and tests the app,
- downloads `world.pmtiles` from the latest release if it is not already in
  `public/data/`,
- builds with the correct GitHub Pages base path
  (`/<repository>/`, or `/` for `<user>.github.io`),
- enforces the storage budget with `--require-data`,
- uploads and deploys only static files.

If the release asset is missing, the deploy fails with an explicit
"Map data missing" annotation rather than publishing an empty map.

The app resolves its style, glyphs and default archive against the Vite base
URL, so project-site subpaths work without hard-coded `/` paths. The PMTiles
URL can also be set with `VITE_PMTILES_URL` or `?pmtiles=`.

## Project layout

```
index.html                  fullscreen viewer shell
src/
  main.ts                   boot, loading/data states, zoom controls
  map.ts                    MapLibre setup, PMTiles protocol, style URL patching
  archive.ts                PMTiles preflight + south_up contract
  coordinates.ts            geoToDisplay / displayToGeo
  styles/app.css            minimal UI
public/
  style.json                original MapLibre style
  fonts/                    self-hosted KlokanTech Noto Sans glyphs
  data/                     destination for world.pmtiles (gitignored)
map-build/
  README.md                 pipeline, tuning and troubleshooting
  configuration/            Planetiler config + size budget
  scripts/build-world.sh    pinned end-to-end build
  scripts/check-size.mjs    deployment size gate
  transformations/          MVT latitude inversion + tests
.github/workflows/          CI and Pages deployment
```

## Verification

```bash
npm run typecheck
npm test
PYTHONHASHSEED=0 map-build/.venv/bin/python -m unittest discover -s map-build/transformations -p 'test_*.py' -v
npm run build
npm run size:check
```

The Python tests cover point/line/polygon mirroring, holes and winding,
gzip/determinism, bounds/center metadata and a full tiny MBTiles → PMTiles
round trip that asserts the tile moves to the correct XYZ row. The TypeScript
tests cover the coordinate contract and known places.

The complete path was smoke-tested with a real Planetiler build of Monaco: the
PMTiles archive was flipped, loaded by MapLibre, and the `place` point for
Monaco decoded at display longitude `7.42676`, display latitude `-43.73935`
(the exact negation of its source latitude). The temporary archive is not
committed.

## Data and licensing

- Application code: MIT (see [`LICENSE`](LICENSE)).
- Map data: © OpenStreetMap contributors, ODbL 1.0.
  <https://www.openstreetmap.org/copyright>
- Schema: based on OpenMapTiles; the style and generated tiles credit
  OpenMapTiles. <https://openmaptiles.org>
- Glyphs: Noto Sans, SIL Open Font License 1.1, self-hosted under
  [`public/fonts/`](public/fonts/). Font names are kept as published by
  KlokanTech to credit their merged Noto font build.
- Natural Earth and ocean-polygon sources are fetched by Planetiler and are not
  committed.

Maps made from these tiles must visibly credit OpenStreetMap and OpenMapTiles.
The viewer's attribution control does this.

## Limitations

- No buildings, addresses, indoor data, trees, benches or exhaustive POIs.
- Native detail stops at z10 (if it fits) or z9; z14 is overzoom.
- The archive is a snapshot; there are no live OSM updates.
- Labels prefer `name:latin`, then `name`, then `name:en`. A label needs one
  of those fields; features with no name are not rendered.
- A planet build is a large local operation, not something the Pages workflow
  attempts. The workflow only deploys an already-built archive.
