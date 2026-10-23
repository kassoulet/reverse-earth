import gzip
import unittest

import mapbox_vector_tile
import numpy as np
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.strtree import STRtree

import build_natural_earth as build


def square(x: float, y: float, size: float = 1000.0) -> Polygon:
    return box(x, y, x + size, y + size)


class ProjectionTests(unittest.TestCase):
    def test_display_projection_negates_latitude(self):
        projected = build.display_project(
            np.array([[0.0, 0.0], [0.0, 45.0], [0.0, -45.0]])
        )
        self.assertAlmostEqual(projected[0, 0], build.WORLD_PIXELS / 2)
        self.assertAlmostEqual(projected[0, 1], build.WORLD_PIXELS / 2)
        self.assertGreater(projected[1, 1], projected[0, 1])
        self.assertLess(projected[2, 1], projected[0, 1])

    def test_poles_clamp_to_the_projection_limits(self):
        projected = build.display_project(
            np.array([[0.0, 90.0], [0.0, -90.0], [180.0, 0.0]])
        )
        self.assertAlmostEqual(projected[0, 1], build.WORLD_PIXELS, places=6)
        self.assertAlmostEqual(projected[1, 1], 0.0, places=6)
        self.assertAlmostEqual(projected[2, 0], build.WORLD_PIXELS, places=6)


class GeometryTests(unittest.TestCase):
    def test_normalise_clips_to_the_display_world(self):
        clipped = build.normalise_geometry(box(-100, -100, 100, 100))
        self.assertIsNotNone(clipped)
        self.assertGreaterEqual(clipped.bounds[0], 0)
        self.assertLessEqual(clipped.bounds[2], build.WORLD_PIXELS)
        self.assertGreaterEqual(clipped.bounds[1], 0)
        self.assertLessEqual(clipped.bounds[3], build.WORLD_PIXELS)

    def test_normalise_keeps_polar_land_valid(self):
        # A polar polygon reaches the display world edge, where the clamped
        # projection can otherwise create a self-touching ring.
        polar = Polygon(
            [
                (0, 0),
                (build.WORLD_PIXELS, 0),
                (build.WORLD_PIXELS, 3000),
                (0, 3000),
            ]
        )
        normalised = build.normalise_geometry(polar)
        self.assertIsNotNone(normalised)
        self.assertTrue(normalised.is_valid)

    def test_explode_parts_splits_multi_geometries(self):
        parts = build.explode_parts(
            MultiPolygon([square(0, 0), square(2000, 2000)])
        )
        self.assertEqual(len(parts), 2)
        self.assertTrue(all(part.geom_type == "Polygon" for part in parts))

    def test_simplify_falls_back_when_topology_breaks(self):
        geometry = square(0, 0, 10)
        simplified = build.simplify_for_display(geometry, "land")
        self.assertFalse(simplified.is_empty)
        self.assertTrue(simplified.is_valid)


class TileEncodingTests(unittest.TestCase):
    def sources(self):
        sources = {layer: ([], None) for layer in build.LAYER_ORDER}
        land = build.Feature(
            geometry=Polygon(
                [
                    (7000, 7000),
                    (9500, 7000),
                    (9500, 9500),
                    (7000, 9500),
                ]
            ),
            properties={"class": "land"},
        )
        place = build.Feature(
            geometry=Point(8200, 8200),
            properties={"name": "Test", "kind": "city"},
            kind="city",
        )
        sources["land"] = ([land], STRtree([land.geometry]))
        sources["place"] = ([place], STRtree([place.geometry]))
        return sources

    def test_encodes_gzipped_vector_tile_with_schema_layers(self):
        data, counts = build.encode_tile(self.sources(), 0, 0, 0)
        self.assertIsNotNone(data)
        self.assertEqual(counts.get("land"), 1)
        self.assertEqual(counts.get("place"), 1)

        decoded = mapbox_vector_tile.decode(gzip.decompress(data))
        self.assertIn("land", decoded)
        self.assertIn("place", decoded)
        land = decoded["land"]["features"][0]
        self.assertEqual(land["properties"], {"class": "land"})
        point = decoded["place"]["features"][0]
        self.assertEqual(point["properties"]["name"], "Test")


class OptionalDetailTests(unittest.TestCase):
    def test_admin1_boundaries_keep_their_own_kind(self):
        source = build.PreparedSource(
            layer="boundary", scale="10m", variant="admin1"
        )
        feature = build.build_feature(
            source,
            Point(0, 0),
            {
                "NAME": "Hesse",
                "ADM0_NAME": "Germany",
                "MIN_ZOOM": 5,
                "SCALERANK": 3,
            },
        )
        self.assertEqual(feature.properties["kind"], "admin1")
        self.assertEqual(feature.properties["admin0"], "Germany")
        self.assertEqual(feature.min_zoom, 5)

    def test_roads_are_filtered_by_zoom_and_class(self):
        features = [
            build.Feature(
                geometry=Point(0, 0),
                properties={"class": road_class, "type": "Road"},
                min_zoom=min_zoom,
            )
            for road_class, min_zoom in (
                ("major", 3),
                ("secondary", 5),
                ("minor", 3),
            )
        ]
        source = build.PreparedSource(
            layer="road", scale="10m", features=features
        )
        self.assertEqual(
            [feature.properties["class"] for feature in build.filtered_features(source, 5)],
            ["major", "secondary"],
        )
        self.assertEqual(
            [feature.properties["class"] for feature in build.filtered_features(source, 6)],
            ["major", "secondary", "minor"],
        )

    def test_road_class_ignores_unknown_ways(self):
        self.assertEqual(build.road_class("Major Highway"), "major")
        self.assertEqual(build.road_class("Secondary Highway"), "secondary")
        self.assertEqual(build.road_class("Road"), "minor")
        self.assertEqual(build.road_class("Unknown"), "other")

    def test_railways_use_scalerank_to_control_density(self):
        features = [
            build.Feature(
                geometry=Point(0, 0),
                properties={"class": "rail"},
                rank=rank,
            )
            for rank in (4, 6, 7)
        ]
        source = build.PreparedSource(
            layer="railway", scale="10m", features=features
        )
        self.assertEqual(
            [feature.rank for feature in build.filtered_features(source, 5)],
            [4],
        )
        self.assertEqual(
            [feature.rank for feature in build.filtered_features(source, 6)],
            [4, 6, 7],
        )

    def test_rank_filters_for_urban_airports_and_ports(self):
        urban = build.PreparedSource(
            layer="urban",
            scale="10m",
            features=[
                build.Feature(geometry=Point(0, 0), properties={}, rank=rank)
                for rank in (4, 6, 8)
            ],
        )
        self.assertEqual(
            [feature.rank for feature in build.filtered_features(urban, 5)],
            [4],
        )
        self.assertEqual(
            [feature.rank for feature in build.filtered_features(urban, 6)],
            [4, 6],
        )

        for layer, ranks, expected_z5, expected_z6 in (
            ("airport", (3, 5, 7), [3], [3, 5]),
            ("port", (3, 5, 6), [3], [3, 5]),
        ):
            source = build.PreparedSource(
                layer=layer,
                scale="10m",
                features=[
                    build.Feature(geometry=Point(0, 0), properties={}, rank=rank)
                    for rank in ranks
                ],
            )
            self.assertEqual(
                [feature.rank for feature in build.filtered_features(source, 5)],
                expected_z5,
            )
            self.assertEqual(
                [feature.rank for feature in build.filtered_features(source, 6)],
                expected_z6,
            )


class MetadataTests(unittest.TestCase):
    def test_metadata_marks_the_archive_south_up(self):
        metadata = build.build_metadata(
            0,
            6,
            {layer: 1 for layer in build.LAYER_ORDER},
        )
        self.assertTrue(metadata["south_up"])
        self.assertIn("display_latitude = -latitude", metadata["transform"])
        self.assertEqual(
            [layer["id"] for layer in metadata["vector_layers"]],
            list(build.LAYER_ORDER),
        )


if __name__ == "__main__":
    unittest.main()
