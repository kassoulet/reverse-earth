#!/usr/bin/env python3
"""Build a south-up Natural Earth vector basemap as one PMTiles archive.

The pipeline is deliberately database-free: it downloads a pinned Natural
Earth commit, selects a small number of datasets, transforms latitude to
display latitude, clips and simplifies geometry per tile, and writes MVT
layers into PMTiles. No OSM extract and no Planetiler run are required.

Layer schema (shared with any future filtered OSM source):

    land       polygons
    glacier    polygons (ice caps and glaciers)
    water      polygons (lakes)
    wetland    polygons (Natural Earth named wetlands)
    reef       lines (coral reefs)
    urban      polygons (Natural Earth urban areas at z5-z6)
    park       polygons (Natural Earth parks and protected areas at z5-z6)
    boundary   lines (international and z5-z6 Admin 1 boundaries)
    waterway   lines (rivers and lake centerlines)
    road       lines (major/secondary roads at z5-z6, local roads at z6)
    railway    lines (selected railways at z5-z6)
    airport    points (major airports at z5-z6)
    port       points (major ports at z5-z6)
    marine     points (ocean, sea, gulf, bay and strait labels)
    physio     points (desert, mountain range and plain labels)
    peak       points (mountains, passes and depressions at z5-z6)
    place      points (countries, capitals, cities, towns, selected Admin 1 regions)

The tile grid is a normal XYZ grid in display space. South-up comes from
negating latitude while projecting, so the top of every tile at y=0 is the
south pole side of the map. Labels are point features and stay upright.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import math
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from mapbox_vector_tile import encode
from mapbox_vector_tile.encoder import on_invalid_geometry_make_valid
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from shapely import make_valid, transform
from shapely.affinity import affine_transform
from shapely.geometry import box, shape
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

LOG = logging.getLogger("natural-earth")

NE_COMMIT = "ca96624a56bd078437bca8184e78163e5039ad19"
NE_BASE = (
    f"https://raw.githubusercontent.com/nvkelso/natural-earth-vector/{NE_COMMIT}/geojson"
)
MAX_NATIVE_ZOOM = 6
TILE_SIZE = 256
EXTENT = 4096
MAX_MERCATOR_LAT = 85.0511287798066
WORLD_PIXELS = TILE_SIZE * (2**MAX_NATIVE_ZOOM)

ATTRIBUTION = (
    "Natural Earth (public domain) · "
    '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">'
    "naturalearthdata.com</a>"
)

# Pinned inputs, with SHA-256 checksums. Only datasets that reach the map are
# listed; the cache is ignored by git.
SOURCES: dict[str, tuple[str, str]] = {
    "ne_110m_land.geojson": (
        "9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9",
        f"{NE_BASE}/ne_110m_land.geojson",
    ),
    "ne_50m_land.geojson": (
        "e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b",
        f"{NE_BASE}/ne_50m_land.geojson",
    ),
    "ne_10m_land.geojson": (
        "1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416",
        f"{NE_BASE}/ne_10m_land.geojson",
    ),
    "ne_110m_admin_0_boundary_lines_land.geojson": (
        "d42479fd79552cca4eec7f85fcdca717a790d29ff06be7676f1af0568c6d3f7c",
        f"{NE_BASE}/ne_110m_admin_0_boundary_lines_land.geojson",
    ),
    "ne_50m_admin_0_boundary_lines_land.geojson": (
        "2faac4f6b34386f3d21b6e018cf151f241f00e5c936d44dd17d7d9bfb147fa48",
        f"{NE_BASE}/ne_50m_admin_0_boundary_lines_land.geojson",
    ),
    "ne_10m_admin_0_boundary_lines_land.geojson": (
        "74d9c16229c095fde65943a9919e337682f044bcebccb120764f38edf3b70f4a",
        f"{NE_BASE}/ne_10m_admin_0_boundary_lines_land.geojson",
    ),
    "ne_110m_populated_places_simple.geojson": (
        "0dbd25c9ad8bd797ddf164b067f563be5c16be2c002254eb594862377963f9dc",
        f"{NE_BASE}/ne_110m_populated_places_simple.geojson",
    ),
    "ne_50m_populated_places_simple.geojson": (
        "8e70756b39fae9bcdc1e332bfc510c024c5edd3a13203ffd20092ee37b61d978",
        f"{NE_BASE}/ne_50m_populated_places_simple.geojson",
    ),
    "ne_10m_populated_places_simple.geojson": (
        "fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f",
        f"{NE_BASE}/ne_10m_populated_places_simple.geojson",
    ),
    "ne_110m_rivers_lake_centerlines.geojson": (
        "55aa4497405afc07cdc931b7fbe062c4d6693ba2a550c0d24899953f5d507c8d",
        f"{NE_BASE}/ne_110m_rivers_lake_centerlines.geojson",
    ),
    "ne_50m_rivers_lake_centerlines.geojson": (
        "f286e0ce978fde999ca2d7a78c764be08542e19b63cded52b05c12d5173ccc51",
        f"{NE_BASE}/ne_50m_rivers_lake_centerlines.geojson",
    ),
    "ne_10m_rivers_lake_centerlines.geojson": (
        "bb854a900ecbd3b408df46d5e16e3e0f974ba55993f9d8b5c26e855273c0905a",
        f"{NE_BASE}/ne_10m_rivers_lake_centerlines.geojson",
    ),
    "ne_110m_lakes.geojson": (
        "eb02ecc86c82004fccbf979058bfabbbd6c2d07968c7844d38eb1c9152d2ffc9",
        f"{NE_BASE}/ne_110m_lakes.geojson",
    ),
    "ne_50m_lakes.geojson": (
        "d350b75978b26fe839b797c2c529b2fb8f47fb3983c03f4964e36d5df9378a52",
        f"{NE_BASE}/ne_50m_lakes.geojson",
    ),
    "ne_10m_lakes.geojson": (
        "2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9",
        f"{NE_BASE}/ne_10m_lakes.geojson",
    ),
    "ne_10m_urban_areas.geojson": (
        "5136ffd816a9b28c0f295e6797b4c03eaa421be80d78b90f542db4a932dd4497",
        f"{NE_BASE}/ne_10m_urban_areas.geojson",
    ),
    "ne_10m_airports.geojson": (
        "28892a892f670f1cf654c62253c6169fdc2504b92c956addb4ac8224f50cebe0",
        f"{NE_BASE}/ne_10m_airports.geojson",
    ),
    "ne_10m_ports.geojson": (
        "c5a5028f5187a5e1b9fe7f0fab99804a8be7482099a2365d404fb7e9dd6b5457",
        f"{NE_BASE}/ne_10m_ports.geojson",
    ),
    "ne_10m_parks_and_protected_lands_area.geojson": (
        "78163a10b3a7f5698e24e4421b7da1955ed7d1dafa986f053473c0b5ec8fe055",
        f"{NE_BASE}/ne_10m_parks_and_protected_lands_area.geojson",
    ),
    "ne_110m_admin_0_countries.geojson": (
        "6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f",
        f"{NE_BASE}/ne_110m_admin_0_countries.geojson",
    ),
    "ne_10m_admin_1_states_provinces_lines.geojson": (
        "1a1f30ccaaf4cc9c4bde34266f0b8cbb955d3a4cf254b756912255f2ec7c75b6",
        f"{NE_BASE}/ne_10m_admin_1_states_provinces_lines.geojson",
    ),
    "ne_10m_admin_1_states_provinces.geojson": (
        "22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5",
        f"{NE_BASE}/ne_10m_admin_1_states_provinces.geojson",
    ),
    "ne_10m_roads.geojson": (
        "66a0c7b438e92fd124822cc5921cfa11042f48c294ade5e0f03f2c6640fd0248",
        f"{NE_BASE}/ne_10m_roads.geojson",
    ),
    "ne_10m_railroads.geojson": (
        "a0962d7866060ae3e24df255f6d662389ac9ba7e0df40cf329c2281190b861e6",
        f"{NE_BASE}/ne_10m_railroads.geojson",
    ),
    "ne_10m_glaciated_areas.geojson": (
        "04fd2303d5f0ece2cf482af19d06731d745db9690501d7b0a2a4b7fe23a7726f",
        f"{NE_BASE}/ne_10m_glaciated_areas.geojson",
    ),
    "ne_10m_geography_marine_polys.geojson": (
        "53f865e8ffa966cdd402145c82c5cd14ee7ce974cd0eb9a3f59f03a4cfd2d66c",
        f"{NE_BASE}/ne_10m_geography_marine_polys.geojson",
    ),
    "ne_10m_geography_regions_elevation_points.geojson": (
        "f98a16867867146ec4146d6d4b18c823eeedb2825947de666116cf9a4e3f43cb",
        f"{NE_BASE}/ne_10m_geography_regions_elevation_points.geojson",
    ),
    "ne_10m_geography_regions_polys.geojson": (
        "b7b26e50ea917d3696aec87f932def2bf5f890f5770e441d59c162c6f4c92a77",
        f"{NE_BASE}/ne_10m_geography_regions_polys.geojson",
    ),
    "ne_10m_reefs.geojson": (
        "4dcfb7cb57e7c04108df66ca0ac1bb4125b2b40b6bb45d7d2aa589bd4e46dc57",
        f"{NE_BASE}/ne_10m_reefs.geojson",
    ),
}

SCALE_BY_ZOOM = {
    0: "110m",
    1: "110m",
    2: "110m",
    3: "50m",
    4: "50m",
    5: "10m",
    6: "10m",
}

# At world scale only the most important features survive. Ranks are Natural
# Earth's scalerank/labelrank (0 is most important).
LAKE_RANK_BY_ZOOM = {0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7}
RIVER_RANK_BY_ZOOM = {0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7}
COUNTRY_LABEL_RANK_BY_ZOOM = {0: 2, 1: 2, 2: 3, 3: 3, 4: 4, 5: 4, 6: 5}

# Optional 1:10m detail. Natural Earth's own minimum-zoom hints keep these
# sparse enough for a z4-z6 basemap; the whole 10m dataset is never emitted.
# At z4 only the highest-ranked regions survive, so the world view gains a few
# continental-scale subdivisions without turning into a county map.
ADMIN1_MIN_ZOOM = 4
ADMIN1_BOUNDARY_MIN_ZOOM = 4
ADMIN1_LABEL_MIN_ZOOM = 4
ADMIN1_LABEL_RANK_BY_ZOOM = {4: 0, 5: 2, 6: 5}
ADMIN1_LABEL_MAX_MIN_LABEL = 9
ADMIN1_LABEL_MAX_RANK = 5
ROAD_MIN_ZOOM = 5
ROAD_CLASSES_BY_ZOOM = {
    5: frozenset({"major", "secondary"}),
    6: frozenset({"major", "secondary", "minor"}),
}
RAILWAY_RANK_BY_ZOOM = {5: 5, 6: 7}

URBAN_RANK_BY_ZOOM = {5: 5, 6: 7}
PARK_MIN_ZOOM = 5
AIRPORT_RANK_BY_ZOOM = {5: 4, 6: 6}
PORT_RANK_BY_ZOOM = {5: 4, 6: 5}
GLACIER_RANK_BY_ZOOM = {0: 0, 1: 0, 2: 1, 3: 3, 4: 4, 5: 5, 6: 6}
MARINE_RANK_BY_ZOOM = {0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8}
PHYSIO_RANK_BY_ZOOM = {0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6}
PHYSIO_CLASS_BY_FEATURECLA = {
    "Range/mtn": "range",
    "Desert": "desert",
    "Plain": "plain",
    "Plateau": "plateau",
    "Basin": "basin",
    "Valley": "valley",
}
REEF_MIN_ZOOM = 5
WETLAND_MIN_ZOOM = 0
PEAK_MIN_ZOOM = 5
PEAK_RANK_BY_ZOOM = {5: 2, 6: 3}

LAYER_ORDER = (
    "land",
    "glacier",
    "water",
    "wetland",
    "reef",
    "urban",
    "park",
    "boundary",
    "waterway",
    "road",
    "railway",
    "airport",
    "port",
    "marine",
    "physio",
    "peak",
    "place",
)


@dataclass
class Feature:
    geometry: BaseGeometry
    properties: dict[str, Any]
    kind: str = ""
    rank: int = 99
    min_zoom: float = 0.0


@dataclass
class PreparedSource:
    layer: str
    scale: str
    variant: str = ""
    features: list[Feature] = field(default_factory=list)
    tree: STRtree | None = None
    skipped: int = 0


def display_project(coords: np.ndarray) -> np.ndarray:
    """lon/lat -> z6 display pixel coordinates (y down, latitude negated)."""
    x = (coords[:, 0] + 180.0) / 360.0 * WORLD_PIXELS
    latitude = np.clip(-coords[:, 1], -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)
    y = (
        1.0
        - np.arcsinh(np.tan(np.radians(latitude))) / math.pi
    ) / 2.0 * WORLD_PIXELS
    return np.column_stack([x, y])


def fetch_sources(cache_dir: Path) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    for name, (expected_hash, url) in SOURCES.items():
        path = cache_dir / name
        if not path.exists():
            LOG.info("Downloading %s", name)
            request = urllib.request.Request(url, headers={"User-Agent": "south-up-map/1"})
            with urllib.request.urlopen(request, timeout=120) as response:
                path.write_bytes(response.read())
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != expected_hash:
            raise RuntimeError(
                f"{name}: expected sha256 {expected_hash}, got {digest}. "
                "Delete the cached file and retry."
            )
        LOG.info("Using %s (%s)", name, human_size(path.stat().st_size))


def human_size(size: float) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1000 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1000
    return f"{size} B"


def load_geojson(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        document = json.load(handle)
    features = document.get("features")
    if not isinstance(features, list):
        raise RuntimeError(f"{path} has no features array")
    return features


WORLD_CLIP = box(
    0.0,
    1e-6,
    float(WORLD_PIXELS),
    float(WORLD_PIXELS) - 1e-6,
)


def normalise_geometry(geometry: BaseGeometry) -> BaseGeometry | None:
    if geometry.is_empty:
        return None
    # Web Mercator cannot show the poles. Clipping to the display world also
    # removes the degenerate ring that Antarctica produces at the projection
    # limit, which would otherwise make the global land multipolygon invalid.
    geometry = geometry.intersection(WORLD_CLIP)
    if geometry.is_empty:
        return None
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    geometry = reduce_to_supported_types(geometry)
    if geometry is None or geometry.is_empty:
        return None
    return geometry


def reduce_to_supported_types(geometry: BaseGeometry) -> BaseGeometry | None:
    if geometry.geom_type in ("Polygon", "MultiPolygon", "LineString", "MultiLineString", "Point", "MultiPoint"):
        return geometry
    if geometry.geom_type == "GeometryCollection":
        parts = [
            part
            for part in geometry.geoms
            if part.geom_type
            in ("Polygon", "MultiPolygon", "LineString", "MultiLineString", "Point", "MultiPoint")
            and not part.is_empty
        ]
        if not parts:
            return None
        from shapely.ops import unary_union

        return unary_union(parts)
    return None


def simplify_for_display(geometry: BaseGeometry, layer: str) -> BaseGeometry:
    tolerance = 0.35 if layer in ("boundary", "waterway", "road", "railway") else 0.5
    simplified = geometry.simplify(tolerance, preserve_topology=True)
    return simplified if simplified.is_valid and not simplified.is_empty else geometry


def explode_parts(geometry: BaseGeometry) -> list[BaseGeometry]:
    """Split multi-geometries so the spatial index stores small bounding boxes.

    Natural Earth ships the whole land layer as one MultiPolygon. Indexing that
    as one feature makes every coastal tile a candidate for a world-sized
    clip. Individual polygon parts keep tile queries local.
    """
    if geometry.geom_type in ("MultiPolygon", "MultiLineString", "MultiPoint"):
        return [part for part in geometry.geoms if not part.is_empty]
    return [geometry]


def load_layer(
    cache_dir: Path,
    layer: str,
    dataset_name: str,
    scale: str,
    *,
    variant: str = "",
) -> PreparedSource:
    path = cache_dir / f"{dataset_name}.geojson"
    prepared = PreparedSource(layer=layer, scale=scale, variant=variant)
    skipped = 0

    for raw in load_geojson(path):
        geometry_data = raw.get("geometry")
        if not isinstance(geometry_data, dict):
            skipped += 1
            continue
        try:
            source_geometry = shape(geometry_data)
            projected = transform(source_geometry, display_project)
            projected = normalise_geometry(projected)
            if projected is None:
                skipped += 1
                continue
            projected = simplify_for_display(projected, layer)
            if projected is None or projected.is_empty:
                skipped += 1
                continue
        except Exception as error:  # noqa: BLE001 - report malformed source features
            LOG.warning("Skipping invalid %s feature: %s", layer, error)
            skipped += 1
            continue

        props = raw.get("properties") or {}
        for part in explode_parts(projected):
            prepared.features.append(build_feature(prepared, part, props))

    prepared.skipped = skipped
    prepared.tree = STRtree([feature.geometry for feature in prepared.features])
    LOG.info(
        "%s %s: %s features (%s skipped)",
        layer,
        scale,
        len(prepared.features),
        skipped,
    )
    return prepared


def build_feature(prepared: PreparedSource, geometry: BaseGeometry, props: dict[str, Any]) -> Feature:
    layer = prepared.layer
    if layer == "urban":
        rank = number_value(props.get("scalerank"), 99)
        return Feature(
            geometry=geometry,
            properties={"class": "urban", "rank": rank},
            rank=rank,
            min_zoom=number_value(props.get("min_zoom"), 99),
        )
    if layer == "park":
        rank = number_value(props.get("scalerank"), 99)
        return Feature(
            geometry=geometry,
            properties={
                "name": string_value(props.get("name")),
                "type": string_value(props.get("unit_type")) or string_value(props.get("featurecla")),
                "rank": rank,
            },
            rank=rank,
            min_zoom=PARK_MIN_ZOOM,
        )
    if layer == "airport":
        rank = number_value(props.get("scalerank"), 99)
        return Feature(
            geometry=geometry,
            properties={
                "name": string_value(props.get("name")),
                "type": string_value(props.get("type")),
                "iata": string_value(props.get("iata_code")),
                "rank": rank,
            },
            rank=rank,
            min_zoom=number_value(props.get("min_zoom"), 99),
        )
    if layer == "port":
        rank = number_value(props.get("scalerank"), 99)
        return Feature(
            geometry=geometry,
            properties={
                "name": string_value(props.get("name")),
                "rank": rank,
            },
            rank=rank,
            min_zoom=number_value(props.get("min_zoom"), 99),
        )
    if layer == "reef":
        rank = number_value(props.get("scalerank"), 99)
        return Feature(
            geometry=geometry,
            properties={"class": "reef", "rank": rank},
            rank=rank,
            min_zoom=REEF_MIN_ZOOM,
        )
    if layer == "wetland":
        return Feature(
            geometry=geometry,
            properties={
                "name": display_name(props.get("NAME_EN")) or display_name(props.get("NAME")),
                "class": "wetland",
                "rank": number_value(props.get("SCALERANK"), 99),
            },
            rank=number_value(props.get("SCALERANK"), 99),
            min_zoom=WETLAND_MIN_ZOOM,
        )
    if layer == "glacier":
        rank = number_value(props.get("scalerank"), 99)
        return Feature(
            geometry=geometry,
            properties={"class": "glacier", "rank": rank},
            rank=rank,
            min_zoom=number_value(props.get("min_zoom"), 0),
        )
    if layer == "peak":
        rank = number_value(props.get("scalerank"), 99)
        return Feature(
            geometry=geometry,
            properties={
                "name": string_value(props.get("name")) or string_value(props.get("name_en")),
                "class": (string_value(props.get("featurecla")) or "mountain").lower(),
                "elevation": number_value(props.get("elevation"), 0),
                "rank": rank,
                "country": string_value(props.get("nation1")),
            },
            rank=rank,
            min_zoom=number_value(props.get("min_zoom"), PEAK_MIN_ZOOM),
        )
    if layer == "place":
        return build_place(geometry, props)
    if layer == "water":
        return Feature(
            geometry=geometry,
            properties={
                "name": string_value(props.get("name")),
                "class": "lake",
                "rank": number_value(props.get("scalerank"), 99),
            },
            rank=number_value(props.get("scalerank"), 99),
            min_zoom=number_value(props.get("min_zoom"), 0),
        )
    if layer == "waterway":
        return Feature(
            geometry=geometry,
            properties={
                "name": string_value(props.get("name")),
                "class": (string_value(props.get("featurecla")) or "river").lower(),
                "rank": number_value(props.get("scalerank"), 99),
            },
            rank=number_value(props.get("scalerank"), 99),
            min_zoom=number_value(props.get("min_zoom"), 0),
        )
    if layer == "boundary":
        if prepared.variant == "admin1":
            return Feature(
                geometry=geometry,
                properties={
                    "name": string_value(props.get("NAME")),
                    "kind": "admin1",
                    "disputed": False,
                    "admin0": string_value(props.get("ADM0_NAME")),
                },
                min_zoom=number_value(props.get("MIN_ZOOM"), 0),
                rank=number_value(props.get("SCALERANK"), 99),
            )
        return Feature(
            geometry=geometry,
            properties={
                "name": string_value(props.get("NAME")),
                "kind": "country",
                "disputed": bool(props.get("FEATURECLA") and "Disputed" in props.get("FEATURECLA", "")),
                "admin0": "",
            },
            min_zoom=number_value(props.get("MIN_ZOOM"), 0),
            rank=number_value(props.get("SCALERANK"), 99),
        )
    if layer == "road":
        road_type = string_value(props.get("type")) or "Road"
        rank = number_value(props.get("scalerank"), 99)
        return Feature(
            geometry=geometry,
            properties={
                "name": string_value(props.get("name")),
                "class": road_class(road_type),
                "type": road_type,
                "rank": rank,
            },
            rank=rank,
            min_zoom=number_value(props.get("min_zoom"), 99),
        )
    if layer == "railway":
        rank = number_value(props.get("scalerank"), 99)
        return Feature(
            geometry=geometry,
            properties={
                "name": string_value(props.get("name")),
                "class": "rail",
                "rank": rank,
            },
            rank=rank,
        )
    return Feature(geometry=geometry, properties={"class": "land"})


def road_class(road_type: str) -> str:
    if road_type in ("Major Highway", "Beltway"):
        return "major"
    if road_type == "Secondary Highway":
        return "secondary"
    if road_type in ("Road", "Bypass"):
        return "minor"
    return "other"


def property_value(props: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in props and props[name] is not None:
            return props[name]
    return None


def build_place(geometry: BaseGeometry, props: dict[str, Any]) -> Feature:
    featurecla = string_value(property_value(props, "featurecla", "FEATURECLA"))
    capital = bool(property_value(props, "adm0cap", "ADM0CAP")) or "capital" in featurecla.lower()
    population = number_value(property_value(props, "pop_max", "POP_MAX"), 0)
    rank = number_value(property_value(props, "labelrank", "LABELRANK"), 9)
    min_zoom = number_value(property_value(props, "min_zoom", "MIN_ZOOM"), 99)
    name = string_value(property_value(props, "name", "NAME")) or string_value(
        property_value(props, "nameascii", "NAMEASCII")
    )
    name_en = string_value(property_value(props, "name_en", "NAME_EN")) or name
    country = string_value(property_value(props, "adm0name", "ADM0NAME"))
    worldcity = bool(property_value(props, "worldcity", "WORLDCITY"))
    megacity = bool(property_value(props, "megacity", "MEGACITY"))
    if population >= 10_000_000 or megacity or (capital and worldcity):
        kind = "capital" if capital else "city"
    elif capital:
        kind = "capital"
    elif population >= 500_000:
        kind = "city"
    else:
        kind = "town"
    return Feature(
        geometry=geometry,
        properties={
            "name": name,
            "name_en": name_en,
            "kind": kind,
            "rank": rank,
            "population": population,
            "country": country,
            "capital": capital,
        },
        kind=kind,
        rank=rank,
        min_zoom=min_zoom,
    )


def string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def display_name(value: Any) -> str:
    """Normalise Natural Earth's occasional all-caps names for labels."""
    name = string_value(value)
    if not name.isupper():
        return name
    small_words = {"of", "the", "and", "de", "del", "la", "le", "du", "des"}
    return " ".join(
        word if index > 0 and word in small_words else word.capitalize()
        for index, word in enumerate(name.lower().split())
    )


def number_value(value: Any, default: float) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def country_labels(cache_dir: Path) -> list[Feature]:
    features: list[Feature] = []
    for raw in load_geojson(cache_dir / "ne_110m_admin_0_countries.geojson"):
        props = raw.get("properties") or {}
        label_x = props.get("LABEL_X")
        label_y = props.get("LABEL_Y")
        if not isinstance(label_x, (int, float)) or not isinstance(label_y, (int, float)):
            continue
        name = string_value(props.get("NAME_EN")) or string_value(props.get("NAME"))
        if not name:
            continue
        lon, lat = float(label_x), float(label_y)
        point = shape({"type": "Point", "coordinates": [lon, lat]})
        projected = transform(point, display_project)
        features.append(
            Feature(
                geometry=projected,
                properties={
                    "name": name,
                    "name_en": name,
                    "kind": "country",
                    "rank": number_value(props.get("LABELRANK"), 9),
                    "population": 0,
                    "country": name,
                    "capital": False,
                },
                kind="country",
                rank=number_value(props.get("LABELRANK"), 9),
            )
        )
    return features


def marine_labels(cache_dir: Path) -> PreparedSource:
    """Turn marine polygons into one label anchor each.

    An ocean polygon can span half the world, so the label is placed at a
    representative interior point rather than at a bounding-box centre (which
    could fall on land). Natural Earth's ``min_label`` threshold doubles as
    the minimum zoom for the feature.
    """
    prepared = PreparedSource(layer="marine", scale="10m")
    skipped = 0
    for raw in load_geojson(cache_dir / "ne_10m_geography_marine_polys.geojson"):
        geometry_data = raw.get("geometry")
        if not isinstance(geometry_data, dict):
            skipped += 1
            continue
        props = raw.get("properties") or {}
        name = display_name(props.get("name")) or display_name(props.get("name_en"))
        if not name:
            skipped += 1
            continue
        try:
            source_geometry = shape(geometry_data)
            projected = transform(source_geometry, display_project)
            projected = normalise_geometry(projected)
            if projected is None:
                skipped += 1
                continue
            anchor = projected.representative_point()
        except Exception as error:  # noqa: BLE001 - report malformed source features
            LOG.warning("Skipping invalid marine feature: %s", error)
            skipped += 1
            continue

        rank = number_value(props.get("scalerank"), 99)
        prepared.features.append(
            Feature(
                geometry=anchor,
                properties={
                    "name": name,
                    "class": (string_value(props.get("featurecla")) or "sea").lower(),
                    "rank": rank,
                },
                rank=rank,
                # Natural Earth's min_label is one zoom later than the first
                # zoom where the label is useful on this map.
                min_zoom=max(0.0, number_value(props.get("min_label"), 99) - 1.0),
            )
        )

    prepared.skipped = skipped
    prepared.tree = STRtree([feature.geometry for feature in prepared.features])
    LOG.info(
        "marine 10m: %s features (%s skipped)",
        len(prepared.features),
        skipped,
    )
    return prepared


def physical_region_labels(cache_dir: Path) -> PreparedSource:
    """Place labels for deserts, mountain ranges and plains.

    Natural Earth stores these as polygons. A representative interior point
    gives a stable label anchor without adding the full polygon geometry to
    every tile. ``NE_ID`` removes split duplicates of the same range.
    """
    prepared = PreparedSource(layer="physio", scale="10m")
    seen: set[Any] = set()
    skipped = 0
    for raw in load_geojson(cache_dir / "ne_10m_geography_regions_polys.geojson"):
        props = raw.get("properties") or {}
        kind = PHYSIO_CLASS_BY_FEATURECLA.get(string_value(props.get("FEATURECLA")))
        if kind is None:
            continue
        ne_id = props.get("NE_ID")
        if ne_id is not None:
            if ne_id in seen:
                continue
            seen.add(ne_id)

        geometry_data = raw.get("geometry")
        if not isinstance(geometry_data, dict):
            skipped += 1
            continue
        name = display_name(props.get("NAME_EN")) or display_name(props.get("NAME"))
        if not name:
            skipped += 1
            continue
        try:
            source_geometry = shape(geometry_data)
            projected = transform(source_geometry, display_project)
            projected = normalise_geometry(projected)
            if projected is None:
                skipped += 1
                continue
            anchor = projected.representative_point()
        except Exception as error:  # noqa: BLE001 - report malformed source features
            LOG.warning("Skipping invalid physical region feature: %s", error)
            skipped += 1
            continue

        rank = number_value(props.get("SCALERANK"), 99)
        prepared.features.append(
            Feature(
                geometry=anchor,
                properties={"name": name, "class": kind, "rank": rank},
                rank=rank,
                min_zoom=max(0.0, number_value(props.get("MIN_LABEL"), 99) - 1.0),
            )
        )

    prepared.skipped = skipped
    prepared.tree = STRtree([feature.geometry for feature in prepared.features])
    LOG.info(
        "physio 10m: %s features (%s skipped)",
        len(prepared.features),
        skipped,
    )
    return prepared


def wetland_areas(cache_dir: Path) -> PreparedSource:
    """Keep Natural Earth's named wetland polygons as filled areas."""
    prepared = PreparedSource(layer="wetland", scale="10m")
    seen: set[Any] = set()
    skipped = 0
    for raw in load_geojson(cache_dir / "ne_10m_geography_regions_polys.geojson"):
        props = raw.get("properties") or {}
        if string_value(props.get("FEATURECLA")) != "Wetlands":
            continue
        ne_id = props.get("NE_ID")
        if ne_id is not None:
            if ne_id in seen:
                continue
            seen.add(ne_id)

        geometry_data = raw.get("geometry")
        if not isinstance(geometry_data, dict):
            skipped += 1
            continue
        try:
            source_geometry = shape(geometry_data)
            projected = transform(source_geometry, display_project)
            projected = normalise_geometry(projected)
            if projected is None:
                skipped += 1
                continue
            projected = simplify_for_display(projected, "wetland")
        except Exception as error:  # noqa: BLE001 - report malformed source features
            LOG.warning("Skipping invalid wetland feature: %s", error)
            skipped += 1
            continue

        for part in explode_parts(projected):
            prepared.features.append(build_feature(prepared, part, props))

    prepared.skipped = skipped
    prepared.tree = STRtree([feature.geometry for feature in prepared.features])
    LOG.info(
        "wetland 10m: %s features (%s skipped)",
        len(prepared.features),
        skipped,
    )
    return prepared


def admin1_label_min_zoom(rank: float) -> int:
    """Return the first zoom at which an Admin 1 label earns its place.

    Rank 0 regions are the handful that make sense at z4; rank 1-2 regions join
    at z5, and the broader z6 set waits until the map is detailed enough to
    separate them.
    """
    if rank <= ADMIN1_LABEL_RANK_BY_ZOOM[4]:
        return 4
    if rank <= ADMIN1_LABEL_RANK_BY_ZOOM[5]:
        return 5
    return 6


def admin1_labels(cache_dir: Path) -> list[Feature]:
    """Pick a small, globally distributed set of Admin 1 label anchors.

    Natural Earth's ``min_label``/``labelrank`` are cartographic hints. At z4
    only the largest regions qualify, with more joining at z5 and the full
    selected set at z6, so the map does not fill up with counties and
    départements. Label glyphs are never transformed; only the anchor
    coordinate is negated into display space.
    """
    features: list[Feature] = []
    for raw in load_geojson(cache_dir / "ne_10m_admin_1_states_provinces.geojson"):
        props = raw.get("properties") or {}
        min_label = number_value(props.get("min_label"), 99)
        rank = number_value(props.get("labelrank"), 99)
        if min_label > ADMIN1_LABEL_MAX_MIN_LABEL or rank > ADMIN1_LABEL_MAX_RANK:
            continue
        longitude = props.get("longitude")
        latitude = props.get("latitude")
        if not isinstance(longitude, (int, float)) or not isinstance(latitude, (int, float)):
            continue
        name = string_value(props.get("name_en")) or string_value(props.get("name"))
        if not name:
            continue
        point = shape({"type": "Point", "coordinates": [float(longitude), float(latitude)]})
        projected = transform(point, display_project)
        features.append(
            Feature(
                geometry=projected,
                properties={
                    "name": name,
                    "name_en": name,
                    "kind": "region",
                    "rank": rank,
                    "population": 0,
                    "country": string_value(props.get("admin")),
                    "capital": False,
                },
                kind="region",
                rank=rank,
                min_zoom=admin1_label_min_zoom(rank),
            )
        )
    return features


def place_visible(feature: Feature, zoom: int) -> bool:
    props = feature.properties
    capital = bool(props.get("capital"))
    population = float(props.get("population") or 0)
    rank = feature.rank
    min_zoom = feature.min_zoom

    if zoom <= 1:
        return capital and (population >= (5_000_000 if zoom == 0 else 3_000_000) or rank <= 1)
    if zoom == 2:
        return (capital and (population >= 1_000_000 or rank <= 3)) or population >= 5_000_000
    if zoom == 3:
        return min_zoom <= 3 or (capital and population >= 1_000_000) or population >= 3_000_000
    if zoom == 4:
        return min_zoom <= 4 or (capital and population >= 500_000) or population >= 1_500_000
    if zoom == 5:
        return min_zoom <= 5 or capital or population >= 300_000
    return min_zoom <= zoom or capital or population >= 50_000


def filtered_features(source: PreparedSource, zoom: int) -> list[Feature]:
    if source.layer == "land":
        return source.features
    if source.layer == "boundary" and source.variant == "admin1":
        if zoom <= ADMIN1_BOUNDARY_MIN_ZOOM:
            return [feature for feature in source.features if feature.min_zoom <= zoom]
        return source.features
    if source.layer == "boundary":
        return [feature for feature in source.features if feature.min_zoom <= zoom]
    if source.layer == "water":
        limit = LAKE_RANK_BY_ZOOM.get(zoom, 7)
        return [feature for feature in source.features if feature.rank <= limit or feature.min_zoom <= zoom]
    if source.layer == "waterway":
        limit = RIVER_RANK_BY_ZOOM.get(zoom, 7)
        return [feature for feature in source.features if feature.rank <= limit or feature.min_zoom <= zoom]
    if source.layer == "place":
        return [feature for feature in source.features if place_visible(feature, zoom)]
    if source.layer == "urban":
        limit = URBAN_RANK_BY_ZOOM.get(zoom, -1)
        return [feature for feature in source.features if feature.rank <= limit]
    if source.layer == "park":
        return source.features if zoom >= PARK_MIN_ZOOM else []
    if source.layer == "airport":
        limit = AIRPORT_RANK_BY_ZOOM.get(zoom, -1)
        return [feature for feature in source.features if feature.rank <= limit]
    if source.layer == "port":
        limit = PORT_RANK_BY_ZOOM.get(zoom, -1)
        return [feature for feature in source.features if feature.rank <= limit]
    if source.layer == "road":
        allowed = ROAD_CLASSES_BY_ZOOM.get(zoom, frozenset())
        return [
            feature
            for feature in source.features
            if feature.min_zoom <= zoom and feature.properties.get("class") in allowed
        ]
    if source.layer == "railway":
        limit = RAILWAY_RANK_BY_ZOOM.get(zoom, -1)
        return [feature for feature in source.features if feature.rank <= limit]
    if source.layer == "glacier":
        limit = GLACIER_RANK_BY_ZOOM.get(zoom, -1)
        return [
            feature
            for feature in source.features
            if feature.rank <= limit and feature.min_zoom <= zoom
        ]
    if source.layer == "marine":
        limit = MARINE_RANK_BY_ZOOM.get(zoom, -1)
        return [
            feature
            for feature in source.features
            if feature.rank <= limit and feature.min_zoom <= zoom
        ]
    if source.layer == "reef":
        return source.features if zoom >= REEF_MIN_ZOOM else []
    if source.layer == "wetland":
        return source.features if zoom >= WETLAND_MIN_ZOOM else []
    if source.layer == "physio":
        limit = PHYSIO_RANK_BY_ZOOM.get(zoom, -1)
        return [
            feature
            for feature in source.features
            if feature.rank <= limit and feature.min_zoom <= zoom
        ]
    if source.layer == "peak":
        limit = PEAK_RANK_BY_ZOOM.get(zoom, -1)
        return [
            feature
            for feature in source.features
            if feature.rank <= limit and feature.min_zoom <= zoom
        ]
    return source.features


def dataset_for(layer: str, scale: str) -> str:
    if layer == "place":
        return f"ne_{scale}_populated_places_simple"
    if layer == "water":
        return f"ne_{scale}_lakes"
    if layer == "waterway":
        return f"ne_{scale}_rivers_lake_centerlines"
    if layer == "boundary":
        return f"ne_{scale}_admin_0_boundary_lines_land"
    return f"ne_{scale}_land"


def prepare_zoom_sources(
    cache_dir: Path,
    loaded: dict[tuple[str, str], PreparedSource],
    zoom: int,
) -> dict[str, tuple[list[Feature], STRtree | None]]:
    scale = SCALE_BY_ZOOM[zoom]
    result: dict[str, tuple[list[Feature], STRtree | None]] = {}

    for layer in ("land", "glacier", "water", "boundary", "waterway"):
        source = loaded[(layer, "10m" if layer == "glacier" else scale)]
        features = filtered_features(source, zoom)
        result[layer] = (features, STRtree([feature.geometry for feature in features]))

    if zoom >= WETLAND_MIN_ZOOM:
        features = filtered_features(loaded[("wetland", "10m")], zoom)
        result["wetland"] = (features, STRtree([feature.geometry for feature in features]))
    else:
        result["wetland"] = ([], None)

    if zoom >= ADMIN1_MIN_ZOOM:
        boundary, _ = result["boundary"]
        boundary.extend(filtered_features(loaded[("admin1", "10m")], zoom))
        result["boundary"] = (
            boundary,
            STRtree([feature.geometry for feature in boundary]),
        )

    for layer in ("road", "railway"):
        if zoom < ROAD_MIN_ZOOM:
            result[layer] = ([], None)
            continue
        features = filtered_features(loaded[(layer, "10m")], zoom)
        result[layer] = (features, STRtree([feature.geometry for feature in features]))

    for layer in ("urban", "park", "airport", "port"):
        if zoom < ROAD_MIN_ZOOM:
            result[layer] = ([], None)
            continue
        features = filtered_features(loaded[(layer, "10m")], zoom)
        result[layer] = (features, STRtree([feature.geometry for feature in features]))

    if zoom >= REEF_MIN_ZOOM:
        features = filtered_features(loaded[("reef", "10m")], zoom)
        result["reef"] = (features, STRtree([feature.geometry for feature in features]))
    else:
        result["reef"] = ([], None)

    for layer in ("marine", "physio", "peak"):
        features = filtered_features(loaded[(layer, "10m")], zoom)
        result[layer] = (features, STRtree([feature.geometry for feature in features]))

    places: list[Feature] = []
    place_source = loaded[("place", scale)]
    places.extend(filtered_features(place_source, zoom))
    label_limit = COUNTRY_LABEL_RANK_BY_ZOOM[zoom]
    places.extend(
        feature for feature in loaded[("country-labels", "110m")].features
        if feature.rank <= label_limit
    )
    if zoom >= ADMIN1_LABEL_MIN_ZOOM:
        places.extend(
            feature
            for feature in loaded[("admin1-labels", "10m")].features
            if feature.min_zoom <= zoom
        )
    result["place"] = (places, STRtree([feature.geometry for feature in places]))
    return result


def extract_geometry(geometry: BaseGeometry, layer: str) -> BaseGeometry | None:
    if layer in ("land", "glacier", "water", "wetland", "urban", "park"):
        allowed = ("Polygon", "MultiPolygon")
    elif layer in ("boundary", "waterway", "road", "railway", "reef"):
        allowed = ("LineString", "MultiLineString")
    else:
        allowed = ("Point", "MultiPoint")
    if geometry.geom_type in allowed:
        return geometry
    if geometry.geom_type == "GeometryCollection":
        candidates = [part for part in geometry.geoms if part.geom_type in allowed and not part.is_empty]
        if not candidates:
            return None
        from shapely.ops import unary_union

        merged = unary_union(candidates)
        return merged if merged.geom_type in allowed else None
    return None


def tile_bounds(
    zoom: int, x: int, y: int
) -> tuple[float, float, float, float, float, float, float]:
    """Return the tile origin, its buffered clip box and its size.

    The buffer only extends the clip box so features just outside the tile
    still contribute geometry to the MVT buffer. Coordinates must stay
    relative to the tile origin (not to the buffered box), otherwise every
    feature is shifted by the buffer size inside its tile.
    """
    tile_size = TILE_SIZE * (2 ** (MAX_NATIVE_ZOOM - zoom))
    origin_x = x * tile_size
    origin_y = y * tile_size
    buffer = 4.0 * (2 ** (MAX_NATIVE_ZOOM - zoom))
    return (
        origin_x,
        origin_y,
        origin_x - buffer,
        origin_y - buffer,
        origin_x + tile_size + buffer,
        origin_y + tile_size + buffer,
        tile_size,
    )


def encode_tile(
    sources: dict[str, tuple[list[Feature], STRtree | None]],
    zoom: int,
    x: int,
    y: int,
) -> tuple[bytes | None, dict[str, int]]:
    origin_x, origin_y, west, north, east, south, tile_size = tile_bounds(
        zoom, x, y
    )
    from shapely.geometry import box

    clip_box = box(west, north, east, south)
    scale = EXTENT / tile_size
    output_layers: list[dict[str, Any]] = []
    counts: dict[str, int] = {}

    for layer in LAYER_ORDER:
        features, tree = sources[layer]
        if tree is None:
            continue
        encoded_features: list[dict[str, Any]] = []
        for index in tree.query(clip_box):
            feature = features[int(index)]
            geometry = feature.geometry
            if layer in ("place", "airport", "port", "marine", "physio", "peak"):
                if not clip_box.covers(geometry):
                    continue
                clipped = geometry
            else:
                try:
                    clipped = geometry.intersection(clip_box)
                except Exception:  # noqa: BLE001 - malformed source geometry
                    continue
                clipped = extract_geometry(clipped, layer)
                if clipped is None or clipped.is_empty:
                    continue
            try:
                tile_geometry = affine_transform(
                    clipped,
                    [scale, 0, 0, scale, -origin_x * scale, -origin_y * scale],
                )
                if layer in ("land", "glacier", "water", "wetland", "urban", "park"):
                    tile_geometry = tile_geometry.simplify(2.0, preserve_topology=True)
                elif layer in ("boundary", "waterway", "road", "railway", "reef"):
                    tile_geometry = tile_geometry.simplify(1.0, preserve_topology=False)
                if tile_geometry.is_empty:
                    continue
                tile_geometry = extract_geometry(tile_geometry, layer)
                if tile_geometry is None or tile_geometry.is_empty:
                    continue
            except Exception:  # noqa: BLE001
                continue
            encoded_features.append(
                {
                    "geometry": tile_geometry.__geo_interface__,
                    "properties": feature.properties,
                }
            )

        if encoded_features:
            output_layers.append(
                {"name": layer, "features": encoded_features, "extent": EXTENT}
            )
            counts[layer] = len(encoded_features)

    if not output_layers:
        return None, {}

    try:
        encoded = encode(
            output_layers,
            default_options={
                "y_coord_down": True,
                "extents": EXTENT,
                "check_winding_order": True,
                "on_invalid_geometry": on_invalid_geometry_make_valid,
            },
        )
    except Exception as error:  # noqa: BLE001
        LOG.warning("Could not encode tile z=%s x=%s y=%s: %s", zoom, x, y, error)
        return None, {}

    if not encoded:
        return None, {}
    return gzip.compress(encoded, mtime=0, compresslevel=6), counts


def build(
    cache_dir: Path,
    output: Path,
    *,
    minzoom: int = 0,
    maxzoom: int = MAX_NATIVE_ZOOM,
    force: bool = False,
) -> dict[str, Any]:
    if output.exists():
        if not force:
            raise SystemExit(f"{output} already exists; pass --force to replace it")
        output.unlink()

    started = time.monotonic()
    fetch_sources(cache_dir)

    loaded: dict[tuple[str, str], PreparedSource] = {}
    for scale in ("110m", "50m", "10m"):
        for layer in ("land", "water", "boundary", "waterway", "place"):
            loaded[(layer, scale)] = load_layer(
                cache_dir, layer, dataset_for(layer, scale), scale
            )
    loaded[("admin1", "10m")] = load_layer(
        cache_dir,
        "boundary",
        "ne_10m_admin_1_states_provinces_lines",
        "10m",
        variant="admin1",
    )
    loaded[("admin1-labels", "10m")] = PreparedSource(
        layer="admin1-labels",
        scale="10m",
        features=admin1_labels(cache_dir),
    )
    loaded[("road", "10m")] = load_layer(
        cache_dir, "road", "ne_10m_roads", "10m"
    )
    loaded[("railway", "10m")] = load_layer(
        cache_dir, "railway", "ne_10m_railroads", "10m"
    )
    loaded[("urban", "10m")] = load_layer(
        cache_dir, "urban", "ne_10m_urban_areas", "10m"
    )
    loaded[("park", "10m")] = load_layer(
        cache_dir, "park", "ne_10m_parks_and_protected_lands_area", "10m"
    )
    loaded[("airport", "10m")] = load_layer(
        cache_dir, "airport", "ne_10m_airports", "10m"
    )
    loaded[("port", "10m")] = load_layer(
        cache_dir, "port", "ne_10m_ports", "10m"
    )
    loaded[("glacier", "10m")] = load_layer(
        cache_dir, "glacier", "ne_10m_glaciated_areas", "10m"
    )
    loaded[("reef", "10m")] = load_layer(
        cache_dir, "reef", "ne_10m_reefs", "10m"
    )
    loaded[("wetland", "10m")] = wetland_areas(cache_dir)
    loaded[("marine", "10m")] = marine_labels(cache_dir)
    loaded[("physio", "10m")] = physical_region_labels(cache_dir)
    loaded[("peak", "10m")] = load_layer(
        cache_dir,
        "peak",
        "ne_10m_geography_regions_elevation_points",
        "10m",
    )
    loaded[("country-labels", "110m")] = PreparedSource(
        layer="country-labels", scale="110m", features=country_labels(cache_dir)
    )

    sources_by_zoom = {
        zoom: prepare_zoom_sources(cache_dir, loaded, zoom)
        for zoom in range(minzoom, maxzoom + 1)
    }

    tiles: list[tuple[int, bytes]] = []
    layer_feature_counts: dict[str, int] = {layer: 0 for layer in LAYER_ORDER}
    for zoom in range(minzoom, maxzoom + 1):
        zoom_sources = sources_by_zoom[zoom]
        for x in range(2**zoom):
            for y in range(2**zoom):
                data, counts = encode_tile(zoom_sources, zoom, x, y)
                if data is None:
                    continue
                tiles.append((zxy_to_tileid(zoom, x, y), data))
                for layer, count in counts.items():
                    layer_feature_counts[layer] += count
        LOG.info("z%s: %s non-empty tiles so far", zoom, len(tiles))

    tiles.sort(key=lambda item: item[0])
    output.parent.mkdir(parents=True, exist_ok=True)
    header: dict[str, Any] = {
        "min_zoom": minzoom,
        "max_zoom": maxzoom,
        "min_lon_e7": -1_800_000_000,
        "min_lat_e7": -850_511_288,
        "max_lon_e7": 1_800_000_000,
        "max_lat_e7": 850_511_288,
        "center_zoom": 1,
        "center_lon_e7": 0,
        "center_lat_e7": 0,
        "tile_type": TileType.MVT,
        "tile_compression": Compression.GZIP,
        "addressed_tiles_count": 0,
        "tile_entries_count": 0,
        "tile_contents_count": 0,
    }
    metadata = build_metadata(minzoom, maxzoom, layer_feature_counts)

    with output.open("wb") as handle:
        writer = Writer(handle)
        for tile_id, data in tiles:
            writer.write_tile(tile_id, data)
        writer.finalize(header, metadata)

    size = output.stat().st_size
    deployment_budget = 900_000_000
    budget_path = (
        Path(__file__).resolve().parent.parent
        / "configuration"
        / "size-budget.json"
    )
    if budget_path.exists():
        deployment_budget = int(
            json.loads(budget_path.read_text(encoding="utf-8"))["maxDeployBytes"]
        )
    report = {
        "sources": {
            "natural_earth_vector": NE_COMMIT,
            "datasets": sorted(SOURCES),
        },
        "layers": list(LAYER_ORDER),
        "native_zoom": [minzoom, maxzoom],
        "tiles": len(tiles),
        "features": layer_feature_counts,
        "skipped_features": {
            f"{key[0]}/{key[1]}": source.skipped
            for key, source in loaded.items()
            if source.skipped
        },
        "archive_bytes": size,
        "archive_human": human_size(size),
        "deployment_budget_bytes": deployment_budget,
        "budget_remaining_bytes": deployment_budget - size,
        "elapsed_seconds": round(time.monotonic() - started, 1),
    }
    return report


def build_metadata(minzoom: int, maxzoom: int, counts: dict[str, int]) -> dict[str, Any]:
    fields = {
        "land": {"class": "String"},
        "water": {"name": "String", "class": "String", "rank": "Number"},
        "wetland": {"name": "String", "class": "String", "rank": "Number"},
        "glacier": {"class": "String", "rank": "Number"},
        "reef": {"class": "String", "rank": "Number"},
        "urban": {"class": "String", "rank": "Number"},
        "park": {"name": "String", "type": "String", "rank": "Number"},
        "marine": {"name": "String", "class": "String", "rank": "Number"},
        "physio": {"name": "String", "class": "String", "rank": "Number"},
        "peak": {
            "name": "String",
            "class": "String",
            "elevation": "Number",
            "rank": "Number",
            "country": "String",
        },
        "airport": {
            "name": "String",
            "type": "String",
            "iata": "String",
            "rank": "Number",
        },
        "port": {"name": "String", "rank": "Number"},
        "boundary": {
            "name": "String",
            "kind": "String",
            "disputed": "Boolean",
            "admin0": "String",
        },
        "waterway": {"name": "String", "class": "String", "rank": "Number"},
        "road": {
            "name": "String",
            "class": "String",
            "type": "String",
            "rank": "Number",
        },
        "railway": {"name": "String", "class": "String", "rank": "Number"},
        "place": {
            "name": "String",
            "name_en": "String",
            "kind": "String",
            "rank": "Number",
            "population": "Number",
            "country": "String",
            "capital": "Boolean",
        },
    }
    return {
        "name": "Reversed Earth — Natural Earth",
        "description": (
            "A south-up Natural Earth basemap. Display latitude is the negation "
            "of real geographic latitude; longitude is unchanged."
        ),
        "attribution": ATTRIBUTION,
        "version": "1.0.0",
        "type": "baselayer",
        "format": "pbf",
        "minzoom": minzoom,
        "maxzoom": maxzoom,
        "bounds": "-180,-85.051129,180,85.051129",
        "center": "0,0,1",
        "south_up": True,
        "transform": "display_latitude = -latitude; display_longitude = longitude",
        "generator": "map-build/natural-earth/build_natural_earth.py",
        "vector_layers": [
            {
                "id": layer,
                "description": layer,
                "minzoom": minzoom,
                "maxzoom": maxzoom,
                "fields": fields[layer],
            }
            for layer in LAYER_ORDER
            if layer in counts
        ],
    }


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache",
        type=Path,
        default=Path(__file__).resolve().parent.parent / ".cache" / "ne",
        help="Natural Earth download cache",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("public/data/world.pmtiles"),
        help="output PMTiles path",
    )
    parser.add_argument("--minzoom", type=int, default=0)
    parser.add_argument("--maxzoom", type=int, default=MAX_NATIVE_ZOOM)
    parser.add_argument("--force", action="store_true", help="replace the output")
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(message)s",
    )
    if args.minzoom < 0 or args.maxzoom > MAX_NATIVE_ZOOM or args.minzoom > args.maxzoom:
        raise SystemExit(f"zoom range must be within 0-{MAX_NATIVE_ZOOM}")
    report = build(
        args.cache,
        args.output,
        minzoom=args.minzoom,
        maxzoom=args.maxzoom,
        force=args.force,
    )
    report_path = args.report or (
        Path(__file__).resolve().parent.parent / ".work" / "natural-earth-report.json"
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print()
    print("NATURAL EARTH BUILD")
    print(f"  sources:        Natural Earth @ {NE_COMMIT[:12]}")
    print(f"  layers:         {', '.join(report['layers'])}")
    print(f"  native zoom:    {report['native_zoom'][0]}-{report['native_zoom'][1]}")
    print(f"  tiles:          {report['tiles']}")
    print(f"  features:       {sum(report['features'].values())}")
    print(f"  skipped:        {sum(report['skipped_features'].values())}")
    print(f"  world.pmtiles:  {report['archive_human']}")
    print(
        "  budget left:    "
        f"{human_size(report['budget_remaining_bytes'])} "
        f"of {human_size(report['deployment_budget_bytes'])}"
    )
    print(f"  report:         {report_path}")
    print(f"  elapsed:        {report['elapsed_seconds']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
