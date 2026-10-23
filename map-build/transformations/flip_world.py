#!/usr/bin/env python3
"""Turn a normal Planetiler MBTiles archive into a south-up PMTiles archive.

The inversion is applied to geometry, not to the camera and not with CSS:

    display_latitude  = -latitude
    display_longitude = longitude

For Web Mercator this is a vertical mirror of the whole world. At a given
zoom, a tile at TMS row r becomes a tile at TMS row (2^z - 1 - r), and every
y coordinate inside the tile becomes (extent - y). Mirroring reverses polygon
ring winding, so the MVT is decoded and re-encoded with the encoder's winding
fix (holes remain holes). Points, line labels and text anchors move with the
geometry; MapLibre still draws all glyphs upright.

The output metadata contains ``"south_up": true``. The web app refuses to
display an archive without that declaration, so a north-up archive can never
be shown under a south-up label by mistake.

This runs after Planetiler on purpose: the OpenMapTiles profile also uses
ocean polygons and Natural Earth data, and those must be inverted in exactly
the same way as OSM geometry. Doing the mirror on the final MVT covers every
source, including clipping and label anchor points.

Usage:
    python3 map-build/transformations/flip_world.py \
        --input map-build/.work/world.mbtiles \
        --output public/data/world.pmtiles

Requires: pmtiles==3.8.1, mapbox-vector-tile==2.2.0, shapely==2.2.0.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

import mapbox_vector_tile
from mapbox_vector_tile.encoder import on_invalid_geometry_make_valid
from pmtiles.reader import MmapSource, Reader
from pmtiles.tile import (
    Compression,
    TileType,
    tileid_to_zxy,
    zxy_to_tileid,
)
from pmtiles.writer import Writer

LOG = logging.getLogger("flip-world")

WORLD_BOUNDS = (-180.0, -85.0511287798066, 180.0, 85.0511287798066)
ATTRIBUTION = (
    '<a href="https://www.openstreetmap.org/copyright" target="_blank">'
    "© OpenStreetMap contributors</a> · "
    '<a href="https://openmaptiles.org" target="_blank">OpenMapTiles</a>'
)


def target_xyz_y(z: int, tms_row: int) -> int:
    """MBTiles TMS row -> XYZ y of the south-up output tile.

    Careful with the two conventions:
      * source XYZ y      = (2^z - 1) - source TMS row
      * target XYZ y      = (2^z - 1) - source XYZ y = source TMS row
      * target TMS row    = (2^z - 1) - source TMS row

    PMTiles tile IDs use XYZ coordinates, so the value passed to
    zxy_to_tileid is the source TMS row, not the target TMS row. Mirroring
    this line (a double flip in the wrong direction) puts every tile back in
    its original row and is a bug the end-to-end test guards against.
    """
    if tms_row < 0 or tms_row >= (1 << z):
        raise ValueError(f"TMS row {tms_row} outside zoom {z}")
    return tms_row


def flip_bounds(bounds: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Mirror a geographic bounds tuple into display bounds.

    The input is (west, south, east, north) in real coordinates. After
    lat -> -lat, the old north edge becomes the new south edge.
    """
    west, south, east, north = bounds
    return (west, -north, east, -south)


def flip_geometry(geometry: dict[str, Any], extent: int) -> dict[str, Any]:
    """Mirror one decoded GeoJSON geometry about the tile's horizontal axis."""
    geom_type = geometry.get("type")
    if geom_type == "GeometryCollection":
        geometries = geometry.get("geometries")
        if not isinstance(geometries, list):
            raise ValueError("GeometryCollection without geometries")
        return {
            **geometry,
            "geometries": [flip_geometry(item, extent) for item in geometries],
        }

    if "coordinates" not in geometry:
        raise ValueError(f"Geometry {geom_type!r} has no coordinates")

    coords = geometry["coordinates"]
    if not isinstance(coords, (list, tuple)) or len(coords) == 0:
        raise ValueError(f"Geometry {geom_type!r} has empty coordinates")

    def mirror(node: Any) -> list[Any]:
        if isinstance(node, (list, tuple)) and len(node) >= 2 and isinstance(
            node[0], (int, float)
        ):
            x, y = node[0], node[1]
            return [x, extent - y]
        if isinstance(node, (list, tuple)):
            return [mirror(child) for child in node]
        raise ValueError(f"Unsupported coordinate value in {geom_type!r}: {node!r}")

    return {**geometry, "coordinates": mirror(coords)}


def flip_tile(tile_data: bytes) -> bytes | None:
    """Mirror every feature in an MVT tile and return gzip-compressed MVT.

    Returns None when the input has no renderable features. Planetiler stores
    gzip-compressed tiles in MBTiles; raw MVT is accepted too.
    """
    raw = gzip.decompress(tile_data) if tile_data[:2] == b"\x1f\x8b" else tile_data
    if not raw:
        return None

    layers = mapbox_vector_tile.decode(raw, default_options={"y_coord_down": True})
    encoded_layers: list[dict[str, Any]] = []
    per_layer_options: dict[str, dict[str, Any]] = {}

    for name, layer in layers.items():
        features = layer.get("features") or []
        extent = int(layer.get("extent", 4096))
        if extent <= 0:
            raise ValueError(f"Layer {name!r} has invalid extent {extent}")

        flipped_features: list[dict[str, Any]] = []
        for feature in features:
            geometry = feature.get("geometry")
            if geometry is None:
                continue
            flipped = dict(feature)
            flipped["geometry"] = flip_geometry(geometry, extent)
            flipped_features.append(flipped)

        if not flipped_features:
            continue

        encoded_layers.append(
            {
                "name": name,
                "features": flipped_features,
                "extent": extent,
            }
        )
        per_layer_options[name] = {"extents": extent, "y_coord_down": True}

    if not encoded_layers:
        return None

    encoded = mapbox_vector_tile.encode(
        encoded_layers,
        per_layer_options=per_layer_options,
        default_options={
            "y_coord_down": True,
            "check_winding_order": True,
            "on_invalid_geometry": on_invalid_geometry_make_valid,
        },
    )
    if not encoded:
        return None
    return gzip.compress(encoded, mtime=0, compresslevel=6)


def _parse_floats(value: str, count: int, label: str) -> tuple[float, ...]:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) < count:
        raise ValueError(f"Invalid {label} metadata: {value!r}")
    try:
        return tuple(float(part) for part in parts[:count])
    except ValueError as exc:
        raise ValueError(f"Invalid {label} metadata: {value!r}") from exc


def _read_mbtiles_metadata(conn: sqlite3.Connection) -> tuple[dict[str, str], dict[str, Any]]:
    meta = {str(row[0]): str(row[1]) for row in conn.execute("SELECT name, value FROM metadata")}
    extra: dict[str, Any] = {}
    if "json" in meta:
        try:
            parsed = json.loads(meta["json"])
            if isinstance(parsed, dict):
                extra.update(parsed)
        except json.JSONDecodeError as exc:
            LOG.warning("Ignoring invalid MBTiles json metadata: %s", exc)

    # Some tools put vector_layers/tilestats directly in metadata as JSON.
    for key in ("vector_layers", "tilestats"):
        value = meta.get(key)
        if value and key not in extra:
            try:
                extra[key] = json.loads(value)
            except (TypeError, json.JSONDecodeError):
                pass
    return meta, extra


def _build_metadata(
    meta: dict[str, str],
    extra: dict[str, Any],
    minzoom: int,
    maxzoom: int,
    display_bounds: tuple[float, float, float, float],
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "name": meta.get("name") or "Reverse Earth",
        "description": (
            meta.get("description")
            or "A world basemap with latitude inverted: south is up, north is down."
        ),
        "attribution": ATTRIBUTION,
        "version": meta.get("version") or "1",
        "type": "baselayer",
        "format": "pbf",
        "minzoom": minzoom,
        "maxzoom": maxzoom,
        "south_up": True,
        "transform": "display_latitude = -latitude; display_longitude = longitude",
        "generator": "flip_world.py (MVT geometry-level latitude inversion)",
        "bounds": ",".join(f"{value:.7f}" for value in display_bounds),
    }
    if "vector_layers" in extra:
        result["vector_layers"] = extra["vector_layers"]
    if "tilestats" in extra:
        result["tilestats"] = extra["tilestats"]
    result["description"] = (
        f"{result['description']} South-up display coordinates; real geographic "
        "latitude is the negation of the displayed latitude."
    )
    return result


def _collect_tiles(
    conn: sqlite3.Connection, minzoom: int, maxzoom: int
) -> list[tuple[int, int, int, int]]:
    rows = conn.execute(
        "SELECT zoom_level, tile_column, tile_row FROM tiles "
        "WHERE zoom_level BETWEEN ? AND ?",
        (minzoom, maxzoom),
    ).fetchall()
    if not rows:
        raise RuntimeError("No tiles found in the input MBTiles archive")

    result: list[tuple[int, int, int, int]] = []
    for z_value, x_value, row_value in rows:
        z = int(z_value)
        x = int(x_value)
        row = int(row_value)
        result.append((zxy_to_tileid(z, x, target_xyz_y(z, row)), z, x, row))
    result.sort(key=lambda item: item[0])

    seen: set[int] = set()
    for tile_id, _z, _x, _row in result:
        if tile_id in seen:
            raise RuntimeError("Tile row inversion produced a duplicate target tile")
        seen.add(tile_id)
    return result


def transform(
    input_path: Path,
    output_path: Path,
    *,
    minzoom: int = 0,
    maxzoom: int | None = None,
    verify: bool = True,
) -> dict[str, Any]:
    if not input_path.is_file():
        raise FileNotFoundError(f"Input MBTiles not found: {input_path}")
    if output_path.exists():
        raise FileExistsError(
            f"Output already exists: {output_path} (remove it or pass --force)"
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    conn = sqlite3.connect(f"{input_path.resolve().as_uri()}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = ON")

    tile_min, tile_max = conn.execute(
        "SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles"
    ).fetchone()
    if tile_min is None:
        raise RuntimeError("No tiles found in the input MBTiles archive")
    source_min = int(tile_min)
    source_max = int(tile_max)
    if maxzoom is None:
        maxzoom = source_max
    maxzoom = min(maxzoom, source_max)
    minzoom = max(minzoom, source_min)
    if minzoom > maxzoom:
        raise ValueError(f"Empty zoom range {minzoom}-{maxzoom}")

    meta, extra = _read_mbtiles_metadata(conn)
    raw_bounds = meta.get("bounds")
    bounds = (
        _parse_floats(raw_bounds, 4, "bounds") if raw_bounds else WORLD_BOUNDS
    )
    if len(bounds) != 4:
        bounds = WORLD_BOUNDS
    display_bounds = flip_bounds(bounds)  # type: ignore[arg-type]

    raw_center = meta.get("center")
    center_zoom = source_min
    center_lon = (bounds[0] + bounds[2]) / 2.0
    center_lat = (bounds[1] + bounds[3]) / 2.0
    if raw_center:
        center_values = _parse_floats(raw_center, 3, "center")
        center_lon, center_lat, center_zoom = center_values
        center_zoom = int(round(center_zoom))
    center_zoom = max(minzoom, min(maxzoom, center_zoom))

    tiles = _collect_tiles(conn, minzoom, maxzoom)
    LOG.info(
        "Input %s: zooms %s-%s, %s tiles, bounds %s",
        input_path,
        minzoom,
        maxzoom,
        len(tiles),
        bounds,
    )

    header: dict[str, Any] = {
        "min_zoom": minzoom,
        "max_zoom": maxzoom,
        "min_lon_e7": round(display_bounds[0] * 10_000_000),
        "min_lat_e7": round(display_bounds[1] * 10_000_000),
        "max_lon_e7": round(display_bounds[2] * 10_000_000),
        "max_lat_e7": round(display_bounds[3] * 10_000_000),
        "center_zoom": center_zoom,
        "center_lon_e7": round(center_lon * 10_000_000),
        "center_lat_e7": round(-center_lat * 10_000_000),
        "tile_type": TileType.MVT,
        "tile_compression": Compression.GZIP,
    }
    metadata = _build_metadata(
        meta, extra, minzoom, maxzoom, display_bounds  # type: ignore[arg-type]
    )

    written_ids: list[int] = []
    skipped = 0
    cursor = conn.cursor()
    report_every = max(1, len(tiles) // 20)
    with output_path.open("wb") as output_file:
        writer = Writer(output_file)
        for index, (tile_id, z, x, source_row) in enumerate(tiles, start=1):
            row = cursor.execute(
                "SELECT tile_data FROM tiles "
                "WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
                (z, x, source_row),
            ).fetchone()
            if row is None or row[0] is None:
                raise RuntimeError(f"Missing tile data at z={z} x={x} row={source_row}")
            try:
                flipped = flip_tile(bytes(row[0]))
            except Exception as exc:  # noqa: BLE001 - add tile context, then fail loudly
                raise RuntimeError(
                    f"Could not flip tile z={z} x={x} source_row={source_row}: {exc}"
                ) from exc
            if flipped is None:
                skipped += 1
                continue
            writer.write_tile(tile_id, flipped)
            written_ids.append(tile_id)
            if index % report_every == 0 or index == len(tiles):
                LOG.info("Flipped %s/%s tiles", index, len(tiles))
        writer.finalize(header, metadata)
        output_file.flush()

    elapsed = time.monotonic() - started
    size = output_path.stat().st_size
    hasher = hashlib.sha256()
    with output_path.open("rb") as digest_file:
        for chunk in iter(lambda: digest_file.read(1024 * 1024), b""):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    LOG.info(
        "Wrote %s: %s bytes, %s/%s tiles (%s empty skipped), sha256 %s, %.1fs",
        output_path,
        f"{size:,}",
        len(written_ids),
        len(tiles),
        skipped,
        digest,
        elapsed,
    )

    if verify:
        if not written_ids:
            raise RuntimeError("Output archive contains no tiles")
        with output_path.open("rb") as output_file:
            reader = Reader(MmapSource(output_file))
            out_header = reader.header()
            if out_header["tile_type"] != TileType.MVT:
                raise RuntimeError("Verification failed: output is not MVT")
            if out_header["tile_compression"] != Compression.GZIP:
                raise RuntimeError("Verification failed: output tiles are not gzip")
            if out_header["addressed_tiles_count"] != len(written_ids):
                raise RuntimeError(
                    "Verification failed: header tile count "
                    f"{out_header['addressed_tiles_count']} != {len(written_ids)}"
                )
            out_metadata = reader.metadata()
            if out_metadata.get("south_up") is not True:
                raise RuntimeError("Verification failed: south_up metadata missing")
            z, x, y = tileid_to_zxy(written_ids[len(written_ids) // 2])
            sample = reader.get(z, x, y)
            if not sample:
                raise RuntimeError("Verification failed: sample tile missing")
            sample_raw = (
                gzip.decompress(sample) if sample[:2] == b"\x1f\x8b" else sample
            )
            if not mapbox_vector_tile.decode(
                sample_raw, default_options={"y_coord_down": True}
            ):
                raise RuntimeError("Verification failed: sample tile has no layers")
        LOG.info("Verified PMTiles header, metadata and a sample tile")

    conn.close()
    return {
        "tiles_in": len(tiles),
        "tiles_out": len(written_ids),
        "skipped": skipped,
        "minzoom": minzoom,
        "maxzoom": maxzoom,
        "size": size,
        "sha256": digest,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Invert latitude in an MBTiles archive and write south-up PMTiles."
    )
    parser.add_argument("--input", required=True, type=Path, help="input .mbtiles")
    parser.add_argument("--output", required=True, type=Path, help="output .pmtiles")
    parser.add_argument("--minzoom", type=int, default=0)
    parser.add_argument("--maxzoom", type=int, default=None)
    parser.add_argument("--force", action="store_true", help="replace the output if it exists")
    parser.add_argument(
        "--no-verify",
        action="store_true",
        help="skip the post-write header/metadata/sample check",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    try:
        if args.force and args.output.exists():
            args.output.unlink()
        result = transform(
            args.input,
            args.output,
            minzoom=args.minzoom,
            maxzoom=args.maxzoom,
            verify=not args.no_verify,
        )
    except Exception as exc:  # noqa: BLE001 - CLI surface
        LOG.error("%s", exc)
        return 1

    LOG.info(
        "Done: %s tiles, zooms %s-%s, %.1f MB. south_up metadata is present.",
        result["tiles_out"],
        result["minzoom"],
        result["maxzoom"],
        result["size"] / 1_000_000,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
