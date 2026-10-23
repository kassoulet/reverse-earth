"""Tests for the geometry-level latitude inversion.

Run from the repository root with:
    PYTHONHASHSEED=0 map-build/.venv/bin/python -m unittest discover \
      -s map-build/transformations -p 'test_*.py' -v
"""

from __future__ import annotations

import gzip
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

import mapbox_vector_tile
from shapely.geometry import shape

sys.path.insert(0, str(Path(__file__).resolve().parent))

from flip_world import (  # noqa: E402
    flip_bounds,
    flip_geometry,
    flip_tile,
    target_xyz_y,
    transform,
)
from pmtiles.reader import MmapSource, Reader  # noqa: E402


def make_tile(features: list[dict[str, Any]], extent: int = 4096) -> bytes:
    return mapbox_vector_tile.encode(
        [{"name": "test", "features": features, "extent": extent}],
        default_options={"y_coord_down": True, "extents": extent},
    )


def decode(tile: bytes) -> dict[str, Any]:
    raw = gzip.decompress(tile) if tile[:2] == b"\x1f\x8b" else tile
    return mapbox_vector_tile.decode(raw, default_options={"y_coord_down": True})


def feature_by_prop(tile: dict[str, Any], key: str, value: Any) -> dict[str, Any]:
    for feature in tile["test"]["features"]:
        if feature["properties"].get(key) == value:
            return feature
    raise AssertionError(f"No feature with {key}={value!r}")


class GeometryTests(unittest.TestCase):
    def test_point_is_mirrored(self) -> None:
        geometry = {"type": "Point", "coordinates": [500, 600]}
        flipped = flip_geometry(geometry, 4096)
        self.assertEqual(flipped, {"type": "Point", "coordinates": [500, 3496]})

    def test_line_is_mirrored_without_reversing_direction(self) -> None:
        geometry = {
            "type": "LineString",
            "coordinates": [[100, 200], [1000, 300]],
        }
        flipped = flip_geometry(geometry, 4096)
        self.assertEqual(
            flipped["coordinates"],
            [[100, 3896], [1000, 3796]],
        )

    def test_multipolygon_rings_are_mirrored(self) -> None:
        geometry = {
            "type": "MultiPolygon",
            "coordinates": [
                [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
                [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]],
            ],
        }
        flipped = flip_geometry(geometry, 100)
        self.assertEqual(
            flipped["coordinates"],
            [
                [[[0, 100], [10, 100], [10, 90], [0, 90], [0, 100]]],
                [[[20, 80], [30, 80], [30, 70], [20, 70], [20, 80]]],
            ],
        )


class TileTests(unittest.TestCase):
    def test_point_line_and_properties_survive(self) -> None:
        original = make_tile(
            [
                {
                    "geometry": {"type": "Point", "coordinates": [500, 600]},
                    "properties": {"kind": "city", "name": "Test"},
                },
                {
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[100, 200], [1000, 300]],
                    },
                    "properties": {"kind": "road"},
                },
            ]
        )
        flipped = decode(flip_tile(original) or b"")
        point = feature_by_prop(flipped, "kind", "city")
        line = feature_by_prop(flipped, "kind", "road")
        self.assertEqual(point["geometry"]["coordinates"], [500, 3496])
        self.assertEqual(point["properties"]["name"], "Test")
        self.assertEqual(
            line["geometry"]["coordinates"],
            [[100, 3896], [1000, 3796]],
        )

    def test_polygon_hole_remains_a_hole(self) -> None:
        shell = [[500, 500], [1500, 500], [1500, 1500], [500, 1500], [500, 500]]
        hole = [[800, 800], [800, 1200], [1200, 1200], [1200, 800], [800, 800]]
        original = make_tile(
            [
                {
                    "geometry": {"type": "Polygon", "coordinates": [shell, hole]},
                    "properties": {"kind": "lake"},
                }
            ]
        )
        flipped = decode(flip_tile(original) or b"")
        geometry = feature_by_prop(flipped, "kind", "lake")["geometry"]
        self.assertEqual(geometry["type"], "Polygon")
        self.assertEqual(len(geometry["coordinates"]), 2)
        mirrored = shape(geometry)
        self.assertTrue(mirrored.is_valid)
        self.assertAlmostEqual(mirrored.area, 1_000_000 - 160_000)
        self.assertEqual(mirrored.interiors[0].bounds, (800, 2896, 1200, 3296))

    def test_whole_polygon_moves_to_the_other_side_of_the_tile(self) -> None:
        original = make_tile(
            [
                {
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [[100, 100], [900, 100], [900, 900], [100, 900], [100, 100]]
                        ],
                    },
                    "properties": {"kind": "land"},
                }
            ]
        )
        flipped = decode(flip_tile(original) or b"")
        geom = feature_by_prop(flipped, "kind", "land")["geometry"]
        self.assertEqual(shape(geom).bounds, (100, 3196, 900, 3996))

    def test_tile_is_gzip_and_deterministic(self) -> None:
        original = make_tile(
            [
                {
                    "geometry": {"type": "Point", "coordinates": [1, 2]},
                    "properties": {"name": "x"},
                }
            ]
        )
        first = flip_tile(original)
        second = flip_tile(original)
        self.assertIsNotNone(first)
        self.assertTrue(first.startswith(b"\x1f\x8b"))
        self.assertEqual(first, second)

    def test_empty_tile_returns_none(self) -> None:
        empty_layer = mapbox_vector_tile.encode(
            [{"name": "empty", "features": [], "extent": 4096}],
            default_options={"y_coord_down": True},
        )
        self.assertIsNone(flip_tile(empty_layer))


class EndToEndTests(unittest.TestCase):
    def test_mbtiles_to_pmtiles_moves_the_tile_and_the_point(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mbtiles = Path(tmp) / "in.mbtiles"
            pmtiles = Path(tmp) / "out.pmtiles"

            point_tile = make_tile(
                [
                    {
                        "geometry": {"type": "Point", "coordinates": [100, 100]},
                        "properties": {"name": "southern point", "class": "city"},
                    }
                ]
            )
            conn = sqlite3.connect(mbtiles)
            conn.execute("CREATE TABLE metadata (name text, value text)")
            conn.execute(
                "CREATE TABLE tiles (zoom_level integer, tile_column integer, "
                "tile_row integer, tile_data blob)"
            )
            conn.executemany(
                "INSERT INTO metadata VALUES (?, ?)",
                [
                    ("name", "test"),
                    ("format", "pbf"),
                    ("minzoom", "1"),
                    ("maxzoom", "1"),
                    ("bounds", "-10,-20,10,30"),
                    ("center", "0,5,1"),
                    (
                        "json",
                        json.dumps(
                            {"vector_layers": [{"id": "test", "fields": {}}]}
                        ),
                    ),
                ],
            )
            # TMS row 0 is the southern z1 tile. The point sits near the top
            # (equator side) of that tile.
            conn.execute(
                "INSERT INTO tiles VALUES (?, ?, ?, ?)",
                (1, 1, 0, gzip.compress(point_tile, mtime=0)),
            )
            conn.commit()
            conn.close()

            result = transform(mbtiles, pmtiles, verify=True)
            self.assertEqual(result["tiles_in"], 1)
            self.assertEqual(result["tiles_out"], 1)

            with pmtiles.open("rb") as output:
                reader = Reader(MmapSource(output))
                header = reader.header()
                metadata = reader.metadata()

                # North and south bounds swap, longitude does not.
                self.assertEqual(header["min_lon_e7"], -10 * 10_000_000)
                self.assertEqual(header["max_lon_e7"], 10 * 10_000_000)
                self.assertEqual(header["min_lat_e7"], -30 * 10_000_000)
                self.assertEqual(header["max_lat_e7"], 20 * 10_000_000)
                self.assertEqual(header["center_lat_e7"], -5 * 10_000_000)
                self.assertIs(metadata["south_up"], True)
                self.assertEqual(metadata["vector_layers"][0]["id"], "test")

                # The southern source tile moves to XYZ y=0 (top), and the
                # point's in-tile y is mirrored near the equator edge.
                tile = reader.get(1, 1, 0)
                self.assertIsNotNone(tile)
                decoded = decode(tile)
                point = feature_by_prop(decoded, "name", "southern point")
                self.assertEqual(point["geometry"]["coordinates"], [100, 3996])


class TileAddressTests(unittest.TestCase):
    def test_output_xyz_row_is_the_source_tms_row(self) -> None:
        # z1: TMS row 0 is the southern tile (source XYZ y=1). After the
        # mirror it belongs at the top, XYZ y=0, which is TMS row 1.
        self.assertEqual(target_xyz_y(1, 0), 0)
        self.assertEqual(target_xyz_y(1, 1), 1)

        # z2 Monaco: TMS row 2 -> source XYZ y=1 -> target XYZ y=2.
        self.assertEqual(target_xyz_y(2, 2), 2)
        self.assertEqual(target_xyz_y(2, 0), 0)
        self.assertEqual(target_xyz_y(2, 3), 3)

    def test_bounds_are_reordered_not_just_negated(self) -> None:
        self.assertEqual(
            flip_bounds((-180.0, -85.0, 180.0, 85.0)),
            (-180.0, -85.0, 180.0, 85.0),
        )
        self.assertEqual(
            flip_bounds((1.0, 43.0, 2.0, 44.0)),
            (1.0, -44.0, 2.0, -43.0),
        )


if __name__ == "__main__":
    unittest.main()
