/**
 * Shareable view state.
 *
 * The URL stores *real* geographic coordinates: latitude is north-positive even
 * while the map is displayed south-up. A copied URL is therefore meaningful
 * outside this viewer and the display inversion stays a rendering concern.
 *
 * Canonical form:
 *
 *     #map=6/43.60/1.44
 *
 * Zoom / real latitude / real longitude. The query string is reserved for
 * options such as `?pmtiles=` and `?orientation=north`.
 */

import {
  MAX_MERCATOR_LATITUDE,
  displayToGeo,
  geoToDisplay,
  wrapLongitude,
} from "./coordinates";

export type Orientation = "south" | "north";

export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
}

export interface UrlState {
  view?: ViewState;
  orientation?: Orientation;
}

const DEFAULT_ZOOM = 2;
const MIN_ZOOM = 0;
const MAX_ZOOM = 14;
const HASH_PREFIX = "#map=";

function parseNumber(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function validView(
  longitude: number | undefined,
  latitude: number | undefined,
  zoom: number | undefined,
): ViewState | undefined {
  if (longitude === undefined || latitude === undefined) return undefined;
  if (longitude < -180 || longitude > 180) return undefined;
  if (latitude < -MAX_MERCATOR_LATITUDE || latitude > MAX_MERCATOR_LATITUDE) {
    return undefined;
  }
  return {
    longitude,
    latitude,
    zoom: clamp(zoom ?? DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

function parseHash(hash: string): ViewState | undefined {
  if (!hash.startsWith(HASH_PREFIX)) return undefined;
  const parts = hash.slice(HASH_PREFIX.length).split("/");
  if (parts.length !== 3) return undefined;
  return validView(
    parseNumber(parts[2]),
    parseNumber(parts[1]),
    parseNumber(parts[0]),
  );
}

function parseQuery(search: string): ViewState | undefined {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  return validView(
    parseNumber(params.get("lon") ?? params.get("lng") ?? params.get("longitude")),
    parseNumber(params.get("lat") ?? params.get("latitude")),
    parseNumber(params.get("z") ?? params.get("zoom")),
  );
}

export function readUrlState(search: string, hash = ""): UrlState {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const orientation = params.get("orientation");
  const state: UrlState = {};
  if (orientation === "north" || orientation === "south") {
    state.orientation = orientation;
  }

  // The hash is canonical; query lat/lon/z remain readable for old links.
  state.view = parseHash(hash) ?? parseQuery(search);
  return state;
}

/** Map center in the current display space. */
export function viewCenter(
  view: ViewState,
  orientation: Orientation,
): [number, number] {
  return orientation === "north"
    ? [view.longitude, view.latitude]
    : geoToDisplay(view.longitude, view.latitude);
}

/** Current map center converted back to real geographic coordinates. */
export function viewFromMap(
  longitude: number,
  latitude: number,
  zoom: number,
  orientation: Orientation,
): ViewState {
  const [realLongitude, realLatitude] =
    orientation === "north"
      ? [longitude, latitude]
      : displayToGeo(longitude, latitude);
  return {
    longitude:
      realLongitude >= -180 && realLongitude <= 180
        ? realLongitude
        : wrapLongitude(realLongitude),
    latitude: clamp(realLatitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE),
    zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM),
  };
}

/**
 * Return a same-origin URL carrying the view while preserving unrelated
 * parameters such as `?pmtiles=` and the orientation option.
 */
export function updateUrl(
  href: string,
  view: ViewState,
  orientation: Orientation,
): string {
  const url = new URL(href);
  for (const key of [
    "lat",
    "latitude",
    "lon",
    "lng",
    "longitude",
    "z",
    "zoom",
  ]) {
    url.searchParams.delete(key);
  }
  if (orientation === "north") {
    url.searchParams.set("orientation", "north");
  } else {
    url.searchParams.delete("orientation");
  }

  const zoom = formatNumber(view.zoom, 2);
  const latitude = formatNumber(view.latitude, 5);
  const longitude = formatNumber(view.longitude, 5);
  url.hash = `map=${zoom}/${latitude}/${longitude}`;
  return `${url.pathname}${url.search}${url.hash}`;
}
