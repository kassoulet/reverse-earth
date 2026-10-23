# Latitude inversion (MVT level)

`flip_world.py` converts a normal Planetiler MBTiles archive into a south-up
PMTiles archive.

## Math

Real geographic coordinates are unchanged; only their display representation on
this map is inverted:

```text
display_latitude  = -latitude
display_longitude = longitude
```

Because Web Mercator y is odd in latitude, a global vertical mirror maps the
tile grid onto itself. For a tile at TMS row `r`:

```text
output TMS row = (2^z - 1) - r
output XYZ y   = r
```

and for every coordinate inside the tile (extent `E`, normally 4096):

```text
x' = x
y' = E - y
```

Longitude, the antimeridian and the Web Mercator latitude limit are untouched.

The geometry is decoded from MVT and re-encoded, so the mirror's reversal of
polygon ring orientation is corrected by the encoder. Holes stay holes,
properties stay attached, and label anchors move with the feature. Nothing is
mirrored at render time; MapLibre draws normal upright text.

## Metadata

The output metadata includes:

```json
{
  "south_up": true,
  "transform": "display_latitude = -latitude; display_longitude = longitude"
}
```

Bounds and center latitudes are reordered and negated. The viewer checks
`south_up` before creating the map.

## Why not flip before Planetiler?

Planetiler's profile also reads ocean polygons and Natural Earth data. Applying
the mirror to the finished MVT is the only stage that covers every source
consistently, including clipping and label anchor points. This is a data
transform, not a MapLibre or CSS hack.

## Usage

```bash
PYTHONHASHSEED=0 map-build/.venv/bin/python \
  map-build/transformations/flip_world.py \
  --input world.mbtiles \
  --output south-up.pmtiles \
  --force
```

Options: `--minzoom`, `--maxzoom`, `--no-verify`.

Dependencies are in `../requirements.txt`. The build wrapper
`../scripts/build-world.sh` installs nothing automatically; create
`map-build/.venv` first.

## Tests

```bash
PYTHONHASHSEED=0 map-build/.venv/bin/python -m unittest discover \
  -s map-build/transformations -p 'test_*.py' -v
```

The suite covers geometry mirroring, polygon holes/winding, deterministic gzip,
bounds/center metadata, tile address conversion and a full MBTiles → PMTiles
round trip with a known point.
