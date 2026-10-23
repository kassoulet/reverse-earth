# Reversed Earth map build pipeline

This directory produces the static artifacts the viewer needs: the vector
archive `public/data/world.pmtiles` and four raster overlays
(`hillshade-{south,north}.pmtiles`, `forest-{south,north}.pmtiles`).

The default **V1** pipeline uses Natural Earth only. It needs no Java, no OSM
PBF and no tile database.

```text
Pinned Natural Earth GeoJSON (110m / 50m / 10m)
   │
   ▼
natural-earth/build_natural_earth.py
   │   display latitude = -latitude
   │   clip to the display world, simplify per tile, encode MVT
   ▼
public/data/world.pmtiles   (south-up geometry, native z0–z6)

Pinned Natural Earth shaded relief + land cover
   │
   ▼
natural-earth/build_terrain.py
   │   warp to Web Mercator, derive hillshade / forest masks
   │   encode WebP raster tiles, flip a south-up copy
   ▼
public/data/hillshade-{south,north}.pmtiles   (z0–z5)
public/data/forest-{south,north}.pmtiles      (z0–z5)
```

The optional **V2** path in `scripts/build-world.sh` is the older
Planetiler/OpenMapTiles workflow. It is retained for denser detail but is not
used by the default site.

## Requirements

| Tool | Default Natural Earth build | Optional OSM build |
| --- | --- | --- |
| Python | 3.10+ (tested on 3.14) | 3.10+ |
| Node.js | 22+ for the viewer and size gate | 22+ |
| Java | not required | 25+ (Planetiler 0.10.x) |
| Input | pinned GeoJSON, downloaded automatically | planet PBF or Geofabrik extract |
| RAM | up to about 1 GB during the raster warp | roughly 0.5× the PBF |
| Disk | about 1.5 GB | 5–10× the PBF |

Natural Earth downloads and generated archives are gitignored and must never be
committed.

## One-time setup

```bash
python3 -m venv map-build/.venv
map-build/.venv/bin/pip install -r map-build/requirements.txt
```

The Python dependencies are pinned to `pmtiles==3.8.1`,
`mapbox-vector-tile==2.2.0`, `shapely==2.2.0`, `numpy==2.5.4` and
`pillow==11.3.0`.

## Build the default archives

```bash
npm run map:build
```

Equivalent explicit commands:

```bash
map-build/.venv/bin/python map-build/natural-earth/build_natural_earth.py \
  --force \
  --report map-build/.work/natural-earth-report.json
map-build/.venv/bin/python map-build/natural-earth/build_terrain.py \
  --force \
  --report map-build/.work/natural-earth-terrain-report.json
```

To rebuild only the raster overlays, use `npm run map:build:terrain`.

What the vector builder does:

1. Downloads the pinned Natural Earth GeoJSON files from
   `nvkelso/natural-earth-vector` at commit
   `ca96624a56bd078437bca8184e78163e5039ad19`.
2. Verifies every file against its SHA-256 checksum. A mismatch fails the build;
   delete the cached file and retry.
3. Loads land, lakes, country boundaries, rivers/lake centerlines and populated
   places at 110m, 50m and 10m, plus 10m Admin 1 boundaries, Admin 1 label
   anchors, roads, railways, urban areas, airports, ports, parks, glaciers,
   coral reefs, ocean/sea label anchors, named wetland polygons,
   desert/range/plain/plateau/basin/valley label anchors and mountain peaks.
4. Projects longitude/latitude into the display world with
   `display_latitude = -latitude`, then clips to the Web Mercator display bounds.
5. Splits multi-geometries into indexed parts, simplifies, and clips each part
   per tile.
6. Writes MVT layers `land`, `glacier`, `water`, `wetland`, `reef`, `urban`,
   `park`, `boundary`, `waterway`, `place`, `road`, `railway`, `airport`,
   `port`, `marine`, `physio` and `peak` into a single PMTiles archive, native
   z0–z6.
7. Records `south_up=true`, the coordinate transform and the source commit in
   the archive metadata.

A full vector build is currently about 5.3 MB and 3,363 non-empty tiles. The
four raster overlays add about 29 MB. Building everything takes roughly three
minutes on a laptop; the raster warp and WebP encoding are the slower part.

### Zoom and detail

| Zoom | Natural Earth scale | Content |
| --- | --- | --- |
| z0–z2 | 110m | land, major ice sheets, major lakes, ocean names, physical regions, country borders, capitals, country labels |
| z3–z4 | 50m | more lakes, rivers, boundaries, cities, seas, glaciers and physical regions |
| z5–z6 | 10m | detailed coastlines, smaller lakes/rivers, coral reefs, towns, urban areas, parks, airports, ports, named mountain peaks, selected Admin 1 boundaries, denser roads and railways; selected Admin 1 labels at z6 |

Native z0–z6 are mandatory for V1. The viewer allows overzoom to z14; overzoom
does not duplicate data in the archive.

### Layer schema

| Layer | Geometry | Fields |
| --- | --- | --- |
| `land` | polygons | `class` |
| `glacier` | polygons | `class`, `rank` |
| `water` | polygons | `name`, `class`, `rank` |
| `wetland` | polygons | `name`, `class`, `rank` |
| `reef` | lines | `class`, `rank` |
| `urban` | polygons | `class`, `rank` |
| `park` | polygons | `name`, `type`, `rank` |
| `boundary` | lines | `name`, `kind`, `disputed`, `admin0` |
| `waterway` | lines | `name`, `class`, `rank` |
| `place` | points | `name`, `name_en`, `kind`, `rank`, `population`, `country`, `capital` |
| `road` | lines | `name`, `class`, `type`, `rank` |
| `railway` | lines | `name`, `class`, `rank` |
| `airport` | points | `name`, `type`, `iata`, `rank` |
| `port` | points | `name`, `rank` |
| `marine` | points | `name`, `class`, `rank` |
| `physio` | points | `name`, `class`, `rank` |
| `peak` | points | `name`, `class`, `elevation`, `rank`, `country` |

Boundary `kind` is `country` or `admin1`; Admin 1 lines appear only at z5–z6
and carry their parent country in `admin0`. Place `kind` is one of `country`,
`capital`, `city`, `town` or `region`. Road `class` is `major`, `secondary` or
`minor` (only selected classes reach the tiles). `disputed` is a boolean.
`rank` is Natural Earth's scalerank/labelrank; lower is more important.

The optional detail follows Natural Earth's own `MIN_ZOOM` hints and is
deliberately filtered: Admin 1 lines with `MIN_ZOOM <= z`; major and secondary
roads at z5 with local roads added at z6; railways with `scalerank <= 5` at z5
and `<= 7` at z6; urban areas with `scalerank <= 5` at z5 and `<= 7` at z6;
airports with `scalerank <= 4` at z5 and `<= 6` at z6; and ports with
`scalerank <= 4` at z5 and `<= 5` at z6. Glaciers use `scalerank <= 0` at
z0–z1, rising to the full set at z6; ocean/sea labels use Natural Earth's
`min_label` plus a scalerank cap (oceans first, then seas, gulfs and bays);
desert, range, plain, plateau, basin and valley labels use the same
one-zoom-earlier `min_label` rule with a scalerank cap; named wetlands are shown
at every zoom; coral reefs appear at z5–z6; and mountain peaks appear at z5–z6
with `scalerank <= 2` at z5 and `<= 3` at z6.
Admin 1 labels appear only at z6 and
only when both `min_label <= 9` and `labelrank <= 5`. The label thresholds
cover countries whose region labels normally start at z7–z8 (for example
Spain, France and Japan) without opening the map to every county. Airports and
ports are Natural Earth's selected global points; the park layer is the US
National Park Service dataset, so parks only appear in the United States.
There are no buildings, address data or exhaustive POIs.

### Geometry notes

Natural Earth ships the whole land layer as one global MultiPolygon. Indexing
that as a single feature makes every coastal tile a candidate for a
world-sized intersection. The builder therefore explodes multi-geometries into
individual polygons before indexing, which keeps per-tile clipping local.

Clamping latitude at the Web Mercator limit turns Antarctica's ring at the
south pole into a degenerate line. The builder clips geometry to a display
world box with a tiny inset (`1e-6` display pixels), which removes that
degenerate edge and produces valid polar polygons without a costly
`make_valid` repair of the global land multipolygon.

Simplification happens once in display space before parts are indexed. If a
simplified geometry is invalid, the builder keeps the unsimplified version
rather than emitting invalid MVT.

### Tuning and troubleshooting

- **Checksum mismatch:** remove the named file under `map-build/.cache/ne/` and
  rerun. Do not edit the expected hash to match a different download.
- **Archive too large:** lower `--maxzoom`, or reduce detail by raising the
  simplification tolerances in `simplify_for_display`. z0–z6 is the intended V1
  range.
- **Missing polar land:** check that clipping still uses `WORLD_CLIP`; a raw
  latitude clamp without the inset can make the global land polygon invalid.
- **Slow build:** the common cause is indexing one world-spanning geometry
  instead of its parts. Confirm `explode_parts` runs before `STRtree`.
- **Blank labels:** confirm the glyph path resolves under the Vite base URL and
  that the place features retain `kind` and `name`.

## Terrain overlays

`build_terrain.py` downloads two pinned Natural Earth 1:10m rasters: the
grayscale shaded-relief image (`SR_HR`, 21,600 × 10,800) and the Natural Earth I
land-cover image (`NE1_LR_LC`, 16,200 × 8,100). Both are public domain.

- Shaded relief is sampled against its flat-water value (206). Flat areas stay
transparent; darker slopes become a warm shadow and brighter slopes a pale
highlight.
- Dark-green land-cover pixels become a transparent forest wash. This is a
  cartographic classification, not a surveyed forest boundary; dry grassland,
cropland and desert are deliberately excluded.
- Both images are warped to Web Mercator at 8,192 × 4,096, split into 256 px
  WebP tiles for z0–z5, and written as PMTiles. Transparent tiles are skipped.
- The south-up copy is the north-up image flipped vertically. That keeps the
  overlays registered with the south-up vector geometry without a browser-side
  image transform.

Wetlands are separate vector polygons from Natural Earth's physical regions
layer, so they can be clicked and inspected like other features.

Tuning notes:

- **Overlays too large:** lower `--maxzoom` (the default is 5) or lower the WebP
  `quality` in `encode_tile`.
- **Terrain missing on water:** keep `SHADED_RELIEF_NEUTRAL` at the source's
  flat-water value; changing it leaves a gray veil over oceans.
- **Forest mask too broad/narrow:** adjust the green thresholds in
  `forest_image`, not the style opacity.
- **North-up out of register:** rebuild both orientations; do not reuse a
  north-up archive from a different source transform.

## Storage gate

`configuration/size-budget.json` sets a generous Pages budget:

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

The second form runs during the Pages deployment. It fails if the vector
archive is missing, the vector archive exceeds its budget, the deployment
(including the terrain overlays) exceeds its budget, or the deployment reaches
GitHub Pages' 1 GB hard limit.

## Optional OSM / Planetiler path

The old V2 workflow is:

```text
OSM .osm.pbf
   │
   ▼
Planetiler 0.10.2 + OpenMapTiles profile
   ▼
world.mbtiles (normal orientation)
   │
   ▼
transformations/flip_world.py: lat → −lat in every MVT tile
   ▼
world.pmtiles (south_up=true)
```

```bash
npm run map:build:osm -- --pbf /data/planet-260101.osm.pbf --heap 48g
```

Planetiler is downloaded by the wrapper and verified against SHA-256
`f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d` (0.10.2).
The wrapper runs Planetiler to MBTiles, flips at MVT level, checks the size
budget and atomically moves the result into `public/data/world.pmtiles`.

The OSM schema is not consumed by the current `public/style.json`. If you switch
to this path, use a style written for the OpenMapTiles layers (the previous
style is available in the repository history), or adapt the style and schema
together.

For the flip implementation, coordinate contract and end-to-end tests, see
[`transformations/README.md`](transformations/README.md).

## Verification

```bash
npm run typecheck
npm test
npm run map:test
npm run build
npm run size:check
```

`map:test` runs the Natural Earth vector and terrain builder tests first, then
the optional MVT transform tests. The terrain tests include small synthetic
images for the hillshade/forest masks and, when the overlays are present, check
that each archive is WebP PMTiles with `south_up=true`.
