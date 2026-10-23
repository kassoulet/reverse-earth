import {
  AttributionControl,
  Map as MapLibreMap,
  addProtocol,
  setWorkerUrl,
  type StyleSpecification,
} from "maplibre-gl";
// MapLibre 6 ships its worker as a separate ES module. Vite must emit it as an
// asset and MapLibre must be told where it is, otherwise it requests a path the
// static host does not serve (and the map never finishes loading).
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { PMTiles, Protocol } from "pmtiles";
import type { MapArchive } from "./archive";
import { glyphUrlTemplate, resolveAppUrl } from "./config";
import { displayToGeo, geoToDisplay } from "./coordinates";
import { NORTH_UP_SCHEME, registerNorthUpProtocol } from "./north-up";

export const SOURCE_ID = "world";

/** Raster overlays bundled beside the vector archive. */
const OVERLAY_SOURCE_IDS = ["hillshade", "forest"] as const;
const OVERLAY_ORIENTATIONS = ["south", "north"] as const;

/** MapLibre extra zoom levels on top of the archive's native maximum. */
const VIEW_MAX_ZOOM = 14;

/** The south-up plan view is the default; north-up is a derived comparison. */
export type Orientation = "south" | "north";

interface VectorSourceSpec {
  type: "vector";
  url?: string;
  tiles?: string[];
  minzoom?: number;
  maxzoom?: number;
  bounds?: [number, number, number, number];
}

interface RasterSourceSpec {
  type: "raster";
  url?: string;
  tiles?: string[];
}

setWorkerUrl(maplibreWorkerUrl);

let protocol: Protocol | undefined;
let northUpProtocolRegistered = false;
const registeredOverlays = new Set<string>();

function registerArchive(archive: MapArchive): void {
  if (!protocol) {
    protocol = new Protocol();
    addProtocol("pmtiles", protocol.tile);
  }
  protocol.add(archive.pmtiles);
}

function overlayUrl(kind: (typeof OVERLAY_SOURCE_IDS)[number], orientation: Orientation): string {
  return `pmtiles://${resolveAppUrl(`data/${kind}-${orientation}.pmtiles`)}`;
}

function registerOverlayArchives(): void {
  if (!protocol) return;
  for (const kind of OVERLAY_SOURCE_IDS) {
    for (const orientation of OVERLAY_ORIENTATIONS) {
      const path = `data/${kind}-${orientation}.pmtiles`;
      if (registeredOverlays.has(path)) continue;
      protocol.add(new PMTiles(resolveAppUrl(path)));
      registeredOverlays.add(path);
    }
  }
}

function setOverlayUrls(style: StyleSpecification, orientation: Orientation): void {
  for (const kind of OVERLAY_SOURCE_IDS) {
    const source = style.sources[kind] as RasterSourceSpec | undefined;
    if (source?.type === "raster") {
      source.url = overlayUrl(kind, orientation);
    }
  }
}

export async function loadStyle(archive: MapArchive): Promise<StyleSpecification> {
  const response = await fetch(resolveAppUrl("style.json"), { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(
      `Could not load the map style (${response.status} ${response.statusText}).`,
    );
  }

  const style = (await response.json()) as StyleSpecification;
  const source = style.sources[SOURCE_ID] as VectorSourceSpec | undefined;
  if (!source || source.type !== "vector") {
    throw new Error(`style.json has no vector source named "${SOURCE_ID}".`);
  }

  style.glyphs = glyphUrlTemplate();
  setOverlayUrls(style, "south");
  source.url = `pmtiles://${archive.url}`;
  source.minzoom = archive.header.minZoom;
  source.maxzoom = archive.header.maxZoom;
  source.bounds = [
    archive.header.minLon,
    archive.header.minLat,
    archive.header.maxLon,
    archive.header.maxLat,
  ];

  return style;
}

function isWorldArchive(archive: MapArchive): boolean {
  return (
    archive.header.maxLon - archive.header.minLon >= 300 &&
    archive.header.maxLat - archive.header.minLat >= 120
  );
}

function initialZoomForViewport(width: number, height: number): number {
  // Fit the whole Web Mercator world inside the smaller viewport dimension so
  // Antarctica at the top and the Arctic at the bottom are both visible on
  // first load, including on portrait phones.
  const usable = Math.max(240, Math.min(width, height) - 64);
  return Math.max(0, Math.min(2.3, Math.log2(usable / 256)));
}

/**
 * Return the style for an orientation. South-up uses the archive as built;
 * north-up rewrites the tile template so tiles are read from the
 * complementary row and inverted client-side.
 */
export function styleForOrientation(
  baseStyle: StyleSpecification,
  archive: MapArchive,
  orientation: Orientation,
): StyleSpecification {
  if (orientation === "south") return baseStyle;

  const style = structuredClone(baseStyle);
  const source = style.sources[SOURCE_ID] as VectorSourceSpec | undefined;
  if (!source) {
    throw new Error(`style.json has no source named "${SOURCE_ID}".`);
  }

  setOverlayUrls(style, "north");
  delete source.url;
  source.tiles = [`${NORTH_UP_SCHEME}://${archive.url}/{z}/{x}/{y}`];
  source.bounds = [
    archive.header.minLon,
    -archive.header.maxLat,
    archive.header.maxLon,
    -archive.header.minLat,
  ];
  return style;
}

function centerFor(archive: MapArchive, orientation: Orientation): [number, number] {
  if (isWorldArchive(archive)) return [0, 0];
  const longitude = archive.header.centerLon;
  const latitude = archive.header.centerLat;
  return orientation === "south"
    ? [longitude, latitude]
    : displayToGeo(longitude, latitude);
}

function boundsFor(
  archive: MapArchive,
  orientation: Orientation,
): [[number, number], [number, number]] {
  const { minLon, minLat, maxLon, maxLat } = archive.header;
  return orientation === "south"
    ? [
        [minLon, minLat],
        [maxLon, maxLat],
      ]
    : [
        [minLon, -maxLat],
        [maxLon, -minLat],
      ];
}

/**
 * Create the viewer. The archive is registered with the same PMTiles instance
 * that was preflighted, so the map does not re-read the header.
 *
 * Rotation and pitch are disabled: this is a plan-view map and a tilted
 * camera would make the "east/west unchanged" contract harder to read.
 */
export function createMap(
  container: HTMLElement,
  archive: MapArchive,
  baseStyle: StyleSpecification,
  orientation: Orientation = "south",
): MapLibreMap {
  registerArchive(archive);
  registerOverlayArchives();
  if (!northUpProtocolRegistered && protocol) {
    registerNorthUpProtocol(protocol);
    northUpProtocolRegistered = true;
  }

  const world = isWorldArchive(archive);
  const map = new MapLibreMap({
    container,
    style: styleForOrientation(baseStyle, archive, orientation),
    center: centerFor(archive, orientation),
    zoom: world
      ? initialZoomForViewport(
          container.clientWidth || window.innerWidth,
          container.clientHeight || window.innerHeight,
        )
      : Math.max(2, Math.min(6, archive.header.centerZoom)),
    minZoom: 0,
    maxZoom: Math.max(VIEW_MAX_ZOOM, archive.header.maxZoom),
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    renderWorldCopies: true,
    fadeDuration: 200,
  });

  // Keep the OpenStreetMap/OpenMapTiles credit visible at all times; a
  // collapsed (i) control would hide it on a static, attribution-required map.
  map.addControl(new AttributionControl({ compact: false }), "bottom-right");

  // Mouse drag rotation is already off; turn off the remaining touch and
  // keyboard rotation gestures so the south-up plan view cannot be twisted
  // into a misleading north-up orientation by accident.
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();

  if (!world) {
    map.fitBounds(boundsFor(archive, orientation), {
      padding: 32,
      animate: false,
      maxZoom: 12,
    });
  }

  return map;
}

/**
 * Switch orientation without losing the place at the center of the viewport.
 * The camera latitude is converted through the same geographic coordinate
 * boundary used everywhere else, then re-expressed in the target space.
 */
export function setMapOrientation(
  map: MapLibreMap,
  archive: MapArchive,
  baseStyle: StyleSpecification,
  from: Orientation,
  to: Orientation,
): void {
  if (from === to) return;

  const center = map.getCenter();
  const [longitude, latitude] =
    from === "north"
      ? [center.lng, center.lat]
      : displayToGeo(center.lng, center.lat);
  const target: [number, number] =
    to === "north" ? [longitude, latitude] : geoToDisplay(longitude, latitude);

  map.setStyle(styleForOrientation(baseStyle, archive, to), { diff: true });
  map.jumpTo({ center: target });
}
