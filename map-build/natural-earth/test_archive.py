import gzip
import math
import unittest
from pathlib import Path

import mapbox_vector_tile
from pmtiles.reader import MmapSource, Reader

ARCHIVE = Path(__file__).resolve().parents[2] / "public/data/world.pmtiles"
EXPECTED_LAYERS = {
    "land",
    "glacier",
    "water",
    "urban",
    "park",
    "boundary",
    "waterway",
    "place",
    "road",
    "railway",
    "airport",
    "port",
    "marine",
    "physio",
    "peak",
}


def tile_for(longitude: float, latitude: float, zoom: int) -> tuple[int, int]:
    count = 2**zoom
    x = int((longitude + 180.0) / 360.0 * count)
    display_latitude = max(-85.0511287798066, min(85.0511287798066, -latitude))
    y = int(
        (
            1.0
            - math.asinh(math.tan(math.radians(display_latitude))) / math.pi
        )
        / 2.0
        * count
    )
    return min(x, count - 1), min(y, count - 1)


@unittest.skipUnless(ARCHIVE.exists(), "world.pmtiles has not been built")
class ArchiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.handle = ARCHIVE.open("rb")
        cls.reader = Reader(MmapSource(cls.handle))
        cls.header = cls.reader.header()
        cls.metadata = cls.reader.metadata()

    @classmethod
    def tearDownClass(cls):
        cls.handle.close()

    def test_archive_opens_with_expected_header_and_metadata(self):
        self.assertEqual(self.header["min_zoom"], 0)
        self.assertEqual(self.header["max_zoom"], 6)
        self.assertTrue(self.metadata["south_up"])
        self.assertEqual(
            {layer["id"] for layer in self.metadata["vector_layers"]},
            EXPECTED_LAYERS,
        )

    def test_land_and_places_exist_at_world_and_city_scale(self):
        world = self.reader.get(0, 0, 0)
        self.assertIsNotNone(world)
        decoded_world = mapbox_vector_tile.decode(gzip.decompress(world))
        land = decoded_world["land"]["features"]
        self.assertGreater(len(land), 0)
        self.assertGreater(len(decoded_world["boundary"]["features"]), 0)

        def min_y(geometry):
            kind = geometry["type"]
            coordinates = geometry["coordinates"]
            if kind == "Polygon":
                points = coordinates[0]
            elif kind == "MultiPolygon":
                points = [point for polygon in coordinates for point in polygon[0]]
            else:
                points = coordinates
            return min(point[1] for point in points)

        # South-up z0 puts Antarctica at the top of the single world tile.
        self.assertLess(min(min_y(feature["geometry"]) for feature in land), 1000)

        x, y = tile_for(2.3522, 48.8566, 5)
        tile = self.reader.get(5, x, y)
        self.assertIsNotNone(tile)
        decoded = mapbox_vector_tile.decode(gzip.decompress(tile))
        names = {
            feature["properties"].get("name")
            for feature in decoded.get("place", {}).get("features", [])
        }
        self.assertIn("Paris", names)
        self.assertGreater(len(decoded.get("land", {}).get("features", [])), 0)

    def test_glaciers_marine_labels_and_peaks_are_present(self):
        world = self.reader.get(0, 0, 0)
        self.assertIsNotNone(world)
        decoded_world = mapbox_vector_tile.decode(gzip.decompress(world))

        glacier_classes = {
            feature["properties"].get("class")
            for feature in decoded_world.get("glacier", {}).get("features", [])
        }
        self.assertIn("glacier", glacier_classes)

        marine_names = {
            feature["properties"].get("name")
            for feature in decoded_world.get("marine", {}).get("features", [])
        }
        self.assertIn("North Atlantic Ocean", marine_names)

        x, y = tile_for(13.0, 23.0, 2)
        sahara = mapbox_vector_tile.decode(
            gzip.decompress(self.reader.get(2, x, y))
        )
        region_names = {
            feature["properties"].get("name")
            for feature in sahara.get("physio", {}).get("features", [])
        }
        self.assertIn("Sahara", region_names)

        x, y = tile_for(86.925, 27.988, 6)
        everest = mapbox_vector_tile.decode(
            gzip.decompress(self.reader.get(6, x, y))
        )
        peak_names = {
            feature["properties"].get("name")
            for feature in everest.get("peak", {}).get("features", [])
        }
        self.assertIn("Mount Everest", peak_names)

    def test_optional_admin1_roads_and_railways_are_present_at_z6(self):
        x, y = tile_for(8.6821, 50.1109, 6)
        tile = self.reader.get(6, x, y)
        self.assertIsNotNone(tile)
        decoded = mapbox_vector_tile.decode(gzip.decompress(tile))

        boundary = decoded.get("boundary", {}).get("features", [])
        self.assertIn(
            "admin1",
            {feature["properties"].get("kind") for feature in boundary},
        )

        roads = decoded.get("road", {}).get("features", [])
        self.assertGreater(len(roads), 0)
        self.assertTrue(
            {feature["properties"].get("class") for feature in roads}
            <= {"major", "secondary", "minor"}
        )

        railways = decoded.get("railway", {}).get("features", [])
        self.assertGreater(len(railways), 0)
        self.assertTrue(
            all(feature["properties"].get("rank", 99) <= 7 for feature in railways)
        )

    def test_admin1_labels_appear_only_at_z6(self):
        z6_x, z6_y = tile_for(-105.543, 38.9998, 6)
        z6_tile = self.reader.get(6, z6_x, z6_y)
        self.assertIsNotNone(z6_tile)
        z6_places = mapbox_vector_tile.decode(gzip.decompress(z6_tile))["place"]["features"]
        region_names = {
            feature["properties"].get("name")
            for feature in z6_places
            if feature["properties"].get("kind") == "region"
        }
        self.assertIn("Colorado", region_names)

        paris_x, paris_y = tile_for(2.3522, 48.8566, 6)
        paris_tile = self.reader.get(6, paris_x, paris_y)
        self.assertIsNotNone(paris_tile)
        paris_places = mapbox_vector_tile.decode(gzip.decompress(paris_tile))["place"][
            "features"
        ]
        paris_regions = {
            feature["properties"].get("name")
            for feature in paris_places
            if feature["properties"].get("kind") == "region"
        }
        # France's region labels normally start at z8; the z6 policy is
        # deliberately broadened for countries like France and Spain.
        self.assertIn("Yvelines", paris_regions)

        z5_x, z5_y = tile_for(-105.543, 38.9998, 5)
        z5_tile = self.reader.get(5, z5_x, z5_y)
        self.assertIsNotNone(z5_tile)
        z5_places = mapbox_vector_tile.decode(gzip.decompress(z5_tile))["place"]["features"]
        self.assertFalse(
            any(
                feature["properties"].get("kind") == "region"
                for feature in z5_places
            )
        )

    def test_low_zoom_road_and_railway_filters_stay_sparse(self):
        x, y = tile_for(8.6821, 50.1109, 5)
        tile = self.reader.get(5, x, y)
        self.assertIsNotNone(tile)
        decoded = mapbox_vector_tile.decode(gzip.decompress(tile))

        roads = decoded.get("road", {}).get("features", [])
        self.assertGreater(len(roads), 0)
        self.assertTrue(
            {feature["properties"].get("class") for feature in roads}
            <= {"major", "secondary"}
        )

        railways = decoded.get("railway", {}).get("features", [])
        self.assertGreater(len(railways), 0)
        self.assertTrue(
            all(feature["properties"].get("rank", 99) <= 5 for feature in railways)
        )

    def test_urban_airports_ports_and_parks_are_present(self):
        x, y = tile_for(2.3522, 48.8566, 6)
        paris = mapbox_vector_tile.decode(gzip.decompress(self.reader.get(6, x, y)))
        urban = paris.get("urban", {}).get("features", [])
        self.assertGreater(len(urban), 0)
        self.assertTrue(
            all(feature["properties"].get("class") == "urban" for feature in urban)
        )

        x, y = tile_for(2.541868, 49.01442, 6)
        cdg = mapbox_vector_tile.decode(gzip.decompress(self.reader.get(6, x, y)))
        airport_names = {
            feature["properties"].get("name")
            for feature in cdg.get("airport", {}).get("features", [])
        }
        self.assertIn("Charles de Gaulle Int'l", airport_names)

        x, y = tile_for(4.292874, 51.927222, 6)
        rotterdam = mapbox_vector_tile.decode(gzip.decompress(self.reader.get(6, x, y)))
        port_names = {
            feature["properties"].get("name")
            for feature in rotterdam.get("port", {}).get("features", [])
        }
        self.assertIn("Rotterdam", port_names)

        x, y = tile_for(-110.5885, 44.428, 6)
        yellowstone = mapbox_vector_tile.decode(gzip.decompress(self.reader.get(6, x, y)))
        park_names = {
            feature["properties"].get("name")
            for feature in yellowstone.get("park", {}).get("features", [])
        }
        self.assertIn("Yellowstone", park_names)

    def test_archive_fits_the_configured_budget(self):
        self.assertLess(ARCHIVE.stat().st_size, 850_000_000)


if __name__ == "__main__":
    unittest.main()
