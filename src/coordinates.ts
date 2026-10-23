/**
 * Coordinate boundary between the real world and this map.
 *
 * Real geographic coordinates are conventional WGS84 longitude/latitude.
 * Display coordinates are what this viewer (and its tiles) use:
 *
 *   display_latitude  = -latitude
 *   display_longitude = longitude
 *
 * The tiles are physically generated with that inversion. This module is the
 * only place where application code should cross between the two spaces.
 */

/** Web Mercator cannot represent latitudes beyond this value. */
export const MAX_MERCATOR_LATITUDE = 85.0511287798066;

/** A longitude/latitude pair, in degrees, in a named coordinate space. */
export type Coordinate = readonly [longitude: number, latitude: number];

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number`);
  }
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function assertLatitude(latitude: number): void {
  assertFinite(latitude, "Latitude");
  if (latitude < -90 || latitude > 90) {
    throw new RangeError(`Latitude must be between -90 and 90, got ${latitude}`);
  }
}

/**
 * Convert a real geographic coordinate to display coordinates.
 *
 * South-up convention: latitude is negated, longitude is untouched.
 *
 * @example geoToDisplay(1.44, 43.6) // [1.44, -43.6]  (Toulouse)
 */
export function geoToDisplay(longitude: number, latitude: number): [number, number] {
  assertFinite(longitude, "Longitude");
  assertLatitude(latitude);
  return [longitude, normalizeZero(-latitude)];
}

/**
 * Convert a display coordinate back to a real geographic coordinate.
 *
 * The transformation is its own inverse.
 *
 * @example displayToGeo(1.44, -43.6) // [1.44, 43.6]  (Toulouse)
 */
export function displayToGeo(longitude: number, latitude: number): [number, number] {
  assertFinite(longitude, "Longitude");
  assertLatitude(latitude);
  return [longitude, normalizeZero(-latitude)];
}

/** Flip a latitude without validating the longitude. */
export function flipLatitude(latitude: number): number {
  assertLatitude(latitude);
  return normalizeZero(-latitude);
}

/** Wrap a longitude into [-180, 180) without changing the coordinate space. */
export function wrapLongitude(longitude: number): number {
  assertFinite(longitude, "Longitude");
  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/** True when the coordinate is a valid WGS84 geographic coordinate. */
export function isValidGeo(longitude: number, latitude: number): boolean {
  return (
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90
  );
}
