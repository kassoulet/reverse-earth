import io
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
from pmtiles.reader import MmapSource, Reader

import build_terrain as terrain

ARCHIVE_DIR = Path(__file__).resolve().parents[2] / "public/data"


class RasterTests(unittest.TestCase):
    def test_hillshade_leaves_flat_water_transparent(self):
        source = Image.fromarray(np.full((8, 8), 206, dtype=np.uint8))
        rgba = np.asarray(terrain.hillshade_image(source))
        self.assertTrue((rgba[..., 3] == 0).all())

    def test_hillshade_renders_shadow_and_highlight(self):
        source = Image.fromarray(np.full((2, 2), 100, dtype=np.uint8))
        shadow = np.asarray(terrain.hillshade_image(source))
        self.assertGreater(int(shadow[0, 0, 3]), 0)
        self.assertEqual(tuple(shadow[0, 0, :3]), (74, 63, 48))

        bright = Image.fromarray(np.full((2, 2), 255, dtype=np.uint8))
        highlight = np.asarray(terrain.hillshade_image(bright))
        self.assertGreater(int(highlight[0, 0, 3]), 0)
        self.assertEqual(tuple(highlight[0, 0, :3]), (255, 248, 235))

    def test_forest_mask_keeps_green_land_and_skips_dry_land(self):
        forest = np.array([168, 200, 172], dtype=np.uint8).reshape(1, 1, 3)
        self.assertGreater(
            int(np.asarray(terrain.forest_image(Image.fromarray(forest)))[0, 0, 3]),
            0,
        )

        grassland = np.array([232, 230, 190], dtype=np.uint8).reshape(1, 1, 3)
        self.assertEqual(
            int(
                np.asarray(terrain.forest_image(Image.fromarray(grassland)))[
                    0, 0, 3
                ]
            ),
            0,
        )

    def test_mercator_warp_preserves_source_orientation(self):
        source = Image.fromarray(
            np.array(
                [
                    [0, 0],
                    [128, 128],
                    [255, 255],
                ],
                dtype=np.uint8,
            )
        )
        warped = np.asarray(terrain.warp_to_mercator(source, 3, 3))
        self.assertEqual(warped.shape, (3, 3))
        self.assertEqual(int(warped[0, 0]), 0)
        self.assertEqual(int(warped[2, 0]), 255)
        self.assertLess(int(warped[0, 0]), int(warped[2, 0]))


@unittest.skipUnless(
    (ARCHIVE_DIR / "hillshade-south.pmtiles").exists(),
    "terrain overlays have not been built",
)
class TerrainArchiveTests(unittest.TestCase):
    def test_overlays_are_webp_pmtiles_with_south_up_metadata(self):
        for name in (
            "hillshade-south.pmtiles",
            "hillshade-north.pmtiles",
            "forest-south.pmtiles",
            "forest-north.pmtiles",
        ):
            with self.subTest(name=name):
                with (ARCHIVE_DIR / name).open("rb") as handle:
                    reader = Reader(MmapSource(handle))
                    header = reader.header()
                    metadata = reader.metadata()
                    self.assertEqual(header["max_zoom"], terrain.MAX_ZOOM)
                    self.assertEqual(header["tile_type"], terrain.TileType.WEBP)
                    self.assertEqual(metadata["south_up"], name.endswith("south.pmtiles"))
                    tile = reader.get(0, 0, 0)
                    self.assertIsNotNone(tile)
                    image = Image.open(io.BytesIO(tile))
                    self.assertEqual(image.size, (terrain.TILE_SIZE, terrain.TILE_SIZE))


if __name__ == "__main__":
    unittest.main()
