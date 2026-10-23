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
import { Protocol } from "pmtiles";
import type { MapArchive } from "./archive";
import { glyphUrlTemplate, resolveAppUrl } from "./config";
import { geoToDisplay } from "./coordinates";

export const SOURCE_ID = "world";

/** MapLibre extra zoom levels on top of the archive's native maximum. */
const VIEW_MAX_ZOOM = 14;

interface VectorSourceSpec {
  type: "vector";
  url: string;
  minzoom?: number;
  maxzoom?: number;
  bounds?: [number, number, number, number];
}

setWorkerUrl(maplibreWorkerUrl);

let protocol: Protocol | undefined;

function registerArchive(archive: MapArchive): void {
  if (!protocol) {
    protocol = new Protocol();
    addProtocol("pmtiles", protocol.tile);
  }
  protocol.add(archive.pmtiles);
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

function initialZoomForWidth(width: number): number {
  return Math.max(1.1, Math.min(2.3, Math.log2(Math.max(width, 320) / 320)));
}

/**
 * Create the viewer. The archive is registered with the same PMTiles instance
 * that was preflighted, so the map does not re-read the header.
 *
 * Rotation and pitch are disabled: this is a plan-view, south-up map and a
 * tilted camera would make the "east/west unchanged" contract harder to read.
 */
export function createMap(
  container: HTMLElement,
  archive: MapArchive,
  style: StyleSpecification,
): MapLibreMap {
  registerArchive(archive);

  const world = isWorldArchive(archive);
  const map = new MapLibreMap({
    container,
    style,
    center: world
      ? geoToDisplay(0, 0)
      : [archive.header.centerLon, archive.header.centerLat],
    zoom: world
      ? initialZoomForWidth(container.clientWidth || window.innerWidth)
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
    map.fitBounds(
      [
        [archive.header.minLon, archive.header.minLat],
        [archive.header.maxLon, archive.header.maxLat],
      ],
      { padding: 32, animate: false, maxZoom: 12 },
    );
  }

  return map;
}
