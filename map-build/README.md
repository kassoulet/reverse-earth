# Map build pipeline

This directory produces the single static artifact the viewer needs:
`south-up world.pmtiles`.

The pipeline is:

```text
OSM .osm.pbf
   │
   ▼
Planetiler 0.10.2 + bundled OpenMapTiles profile
   │   + ocean/water polygons and Natural Earth sources
   ▼
world.mbtiles          (normal Web Mercator orientation)
   │
   ▼
transformations/flip_world.py
   │   lat → −lat for every vertex
   │   TMS rows + in-tile y mirrored
   │   ring winding repaired
   ▼
world.pmtiles          (south-up geometry, metadata south_up=true)
```

No PostGIS, database, tile server or runtime backend is involved. The browser
reads the PMTiles archive with HTTP range requests.

## Requirements

| Tool | Version / notes |
| --- | --- |
| Java | 25+ (Planetiler 0.10.x requires it) |
| Node.js | 22+ (size gate and app) |
| Python | 3.10+ (tested on 3.14) |
| RAM | roughly 0.5× the input PBF (JVM heap) |
| Disk | roughly 5–10× the PBF for Planetiler temp, plus input and output |
| OSM input | Planet PBF or a Geofabrik extract |

The planet PBF, Planetiler cache, MBTiles and PMTiles output are gitignored and
must never be committed.

## One-time setup

```bash
python3 -m venv map-build/.venv
map-build/.venv/bin/pip install -r map-build/requirements.txt
```

The transform is pinned to `pmtiles==3.8.1`, `mapbox-vector-tile==2.2.0` and
`shapely==2.2.0`.

Planetiler itself is downloaded by the build script and verified against the
SHA-256 below. It is not vendored.

```text
0.10.2  f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d
```

## Build a planet archive

Use a dated snapshot. Record its URL and SHA-256 with your release notes.

```bash
npm run map:build -- \
  --pbf /data/planet-260101.osm.pbf \
  --heap 48g
```

What the wrapper does:

1. Checks Java 25+ and the Python transform imports.
2. Downloads/verifies Planetiler 0.10.2 if needed.
3. Runs Planetiler with `configuration/planetiler.properties`, `--download`,
   `--minzoom=0`, `--maxzoom=10` (default), and an MBTiles intermediate.
4. Runs `flip_world.py` into `world.pmtiles.tmp`.
5. Checks the archive against the size budget. If the default z10 build is over
   budget, it re-flips the same MBTiles at z9 and checks again.
6. Atomically moves the verified archive to `public/data/world.pmtiles`.
7. Prints the final size and SHA-256; removes the MBTiles and temp directory
   unless `--keep-intermediate` is used.

The input `.osm.pbf` is never deleted. `planetiler.properties` also leaves
`free_osm_after_read` off for the same reason.

### Control disk and memory

Planetiler writes a large node map and temporary feature storage. The wrapper
warns if free space looks smaller than 5× the input. Options:

```bash
--heap 48g                # JVM -Xmx; roughly 0.5× the PBF
--threads 12
--keep-intermediate       # keep MBTiles + tmp for inspection
```

Planetiler's own guidance for a planet build is a machine with enough RAM for
about half the PBF and 5–10× the PBF in fast local disk. The Pages workflow does
**not** run this build.

### Native zoom and z9 fallback

Native z0–z9 are mandatory. z10 is optional and must fit the budget. A default
build tries z10 and, if the finished archive is over budget, automatically
re-flips the retained MBTiles at z9. Request z9 explicitly to skip that attempt:

```bash
npm run map:build -- --pbf /data/planet-260101.osm.pbf --heap 48g --maxzoom 9
```

An explicit `--maxzoom 10` fails the size gate instead of falling back, so a
requested zoom is never changed silently.

The viewer allows overzoom to z14 regardless. Overzoom does not duplicate data
in the archive; MapLibre scales the native z9/z10 tiles.

### Smoke build

```bash
npm run map:build -- --area monaco --maxzoom 10
```

This downloads a Monaco extract and its sources, then exercises the same
Planetiler → flip → PMTiles → size-check path. Output still defaults to
`public/data/world.pmtiles`. For a tiny test download, Planetiler's own
documentation offers small test source URLs; pass them with `PLANETILER_ARGS`:

```bash
PLANETILER_ARGS="--water-polygons-url=... --natural-earth-url=..." \
  npm run map:build -- --area monaco --maxzoom 10
```

The repository does not commit any smoke-test archive.

## Configuration

### `configuration/planetiler.properties`

The important choices:

- `minzoom=0`, `maxzoom=10` (the CLI override is authoritative).
- `only_layers=water,waterway,water_name,landcover,landuse,park,boundary,transportation,transportation_name,place,aerodrome_label,mountain_peak`
- `exclude_layers=building,housenumber,poi,aeroway`
- `use_wikidata=false`, `languages=en`. The style prefers `name:latin`, then
  `name`, then `name:en`; this avoids embedding full translation sets while
  keeping labels readable across scripts.
- `compress_temp=true` to trade CPU for temporary disk.
- Transport/road-name merging enabled.
- `tile_compression=gzip`.

No buildings, addresses, house numbers, dense POIs, indoor data, benches, trees
or other street-furniture layers are generated.

### Detail by zoom

The generated layers and the style's minzooms together produce:

| Zoom | Content |
| --- | --- |
| z0–z3 | land, ocean, ice, country borders, country labels, major capitals |
| z4–z5 | state boundaries, cities, capitals, major rivers, motorway/trunk, railways, lakes |
| z6–z7 | towns, primary/secondary roads, parks and broad land cover, county boundaries |
| z8–z9 | tertiary/minor roads, villages, streams, airports, peaks, road labels |
| z10 (optional) | finer geometry, additional local roads and place labels |
| z14 | overzoom only; no native z11–z14 tiles |

### Size tuning

If z10 is over budget, try in this order:

1. Let the default automatic fallback produce z9, or rebuild explicitly with
   `--maxzoom 9`.
2. Restrict `only_layers` further (the style requires at least water, boundary,
   transportation, place and their label companions).
3. Increase `min_feature_size` / `simplify_tolerance` carefully; these change
   cartography and are not enabled by default.
4. Keep `languages=en`, `use_wikidata=false`, `compress_temp=true`.

Do not solve the limit by publishing millions of small files. It is one PMTiles
archive.

### Storage gate

`configuration/size-budget.json`:

```json
{
  "maxArchiveBytes": 850000000,
  "maxDeployBytes": 900000000,
  "hardDeployBytes": 1000000000,
  "archiveRelativePath": "data/world.pmtiles"
}
```

```bash
node map-build/scripts/check-size.mjs --archive public/data/world.pmtiles
node map-build/scripts/check-size.mjs dist --require-data
```

The second form is run by the Pages workflow. It prints the largest files,
total deployment size, archive size and headroom, and exits non-zero on any
violation.

## The latitude inversion

`transformations/flip_world.py` operates on Mapbox Vector Tiles, not on the
camera and not with CSS.

### Coordinate contract

```text
display_latitude  = -latitude
display_longitude = longitude
```

The tile-level consequences, with `r` the MBTiles/TMS row and `extent` the MVT
extent (normally 4096):

```text
output TMS row  = (2^z - 1) - source TMS row
output XYZ y    = source TMS row
in-tile y'      = extent - y
```

The XYZ line is easy to get wrong. PMTiles tile IDs use XYZ, not TMS. If you
flip the row once to convert to XYZ and again to build the output address, every
tile returns to its original row. The end-to-end unit test asserts the correct
address.

Longitude and the antimeridian are untouched. The Web Mercator latitude limit
is unchanged; the extreme north and south tiles simply swap ends.

### Why after tile generation?

Planetiler's OpenMapTiles profile reads OSM **and** external sources:

- ocean/water polygons from the OpenMapTiles water-polygon data,
- Natural Earth for low-zoom context and labels.

Flipping only the OSM node latitudes would leave those sources north-up and
produce mismatched coastlines and labels. Flipping the final MVT covers every
source, plus tile clipping and point label anchors. The resulting tiles already
represent the inverted world; MapLibre receives ordinary vector geometry.

### Winding, holes and labels

Mirroring a polygon flips ring orientation. Decoding to GeoJSON and re-encoding
with `mapbox_vector_tile` repairs exterior/interior winding and preserves holes.
Feature properties and feature IDs are retained. If a tile polygon is invalid,
the encoder attempts to make it valid rather than silently dropping it.

Text is never mirrored: glyph atlases are ordinary textures and MapLibre draws
text upright. Line labels use MapLibre's `text-keep-upright` behavior. The data
transform moves label anchors and line geometry, not the glyphs.

The output archive metadata contains:

```json
{
  "south_up": true,
  "transform": "display_latitude = -latitude; display_longitude = longitude"
}
```

The web app refuses to render an archive without `south_up: true`.

### Determinism

- Tile gzip uses `mtime=0`.
- PMTiles directory metadata is gzip-compressed with `mtime=0`.
- The build script sets `PYTHONHASHSEED=0` so PMTiles content deduplication is
  stable.
- Planetiler and Python dependencies are pinned.
- The OSM snapshot should be dated and recorded. A different snapshot will
  naturally produce a different archive.
- The output SHA-256 is written to `map-build/.work/world.pmtiles.sha256` and
  printed by the build.

### Tests

```bash
PYTHONHASHSEED=0 map-build/.venv/bin/python -m unittest discover -s map-build/transformations -p 'test_*.py' -v
```

Coverage includes:

- point/line/multipolygon mirroring,
- polygon holes and winding after re-encoding,
- gzip output and deterministic bytes,
- bounds and center metadata reordering,
- the TMS ↔ XYZ tile address mapping,
- an end-to-end MBTiles → PMTiles test that asserts the tile moved rows and the
  point moved to the correct in-tile position.

## Manual Planetiler invocation

If you need to run a stage independently, the equivalent commands are:

```bash
java -Xmx48g -jar map-build/.cache/planetiler-0.10.2.jar \
  --config=map-build/configuration/planetiler.properties \
  --minzoom=0 --maxzoom=10 \
  --osm-path=/data/planet-260101.osm.pbf \
  --output=map-build/.work/world.mbtiles \
  --tmpdir=map-build/.work/tmp \
  --download --force

PYTHONHASHSEED=0 map-build/.venv/bin/python \
  map-build/transformations/flip_world.py \
  --input map-build/.work/world.mbtiles \
  --output public/data/world.pmtiles \
  --force
```

## Deploying the archive

The Pages workflow downloads `world.pmtiles` from the **latest GitHub release**
if it is not present at `public/data/world.pmtiles`:

1. Build the archive.
2. Attach it to a release under the exact asset name `world.pmtiles`.
3. Run the "Deploy to GitHub Pages" workflow.

The archive becomes part of the static Pages artifact; the release is not used
at runtime. If no archive is available, the workflow fails with a clear
annotation.

See the root [`README.md`](../README.md) for the full deployment and hosting
notes.

## Troubleshooting

**`Map data not built yet` in the viewer**
The archive is missing at `public/data/world.pmtiles` (or the configured URL).
Build it, place it there, or pass `?pmtiles=<url>`.

**`Archive geometry is not south-up`**
The PMTiles metadata has no `south_up: true`. Did the transform stage run? Do
not add the flag to a normal archive; rebuild it through `flip_world.py`.

**Java version error**
Planetiler 0.10.x requires Java 25+. `java -version` must show 25 or newer.

**Out of memory or disk**
Increase `--heap` (roughly 0.5× the PBF), use a local SSD for
`map-build/.work`, keep `compress_temp=true`, and make sure the temp filesystem
has 5–10× the PBF free. The wrapper warns when free space looks low.

**Transform says dependencies are missing**
```bash
python3 -m venv map-build/.venv
map-build/.venv/bin/pip install -r map-build/requirements.txt
```
The build script automatically uses `map-build/.venv/bin/python` when present.

**PMTiles header cannot be read over HTTP**
The host must support HTTP range requests and CORS. GitHub Pages and standard
static hosts do. A plain `file://` page cannot range-read a remote archive.

**Archive over budget**
A default build retries at z9 automatically. If z9 is still over budget, or you
explicitly requested z10, reduce layers/geometry (see "Size tuning"). The
failed temporary archive stays at `<output>.tmp` for inspection, and any
existing published archive is left untouched.

**Glyphs missing**
Keep the `KlokanTech Noto Sans ...` directory names (and their spaces) under
`public/fonts/`. The style references those exact stacks. MapLibre requests the
font-stack path URL-encoded; the static server must serve it.
