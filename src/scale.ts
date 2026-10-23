/** Web Mercator scale estimates for the on-map scale bar. */

export interface ScaleBar {
  /** A "nice" round distance, in meters. */
  distanceMeters: number;
  /** Bar width in CSS pixels. */
  pixels: number;
  /** Human-readable distance, e.g. "100 km" or "500 m". */
  label: string;
}

const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;
const MAX_MERCATOR_LATITUDE = 85.0511287798066;
const METERS_PER_PIXEL_AT_EQUATOR_Z0 = EARTH_CIRCUMFERENCE_METERS / 512;
const DEFAULT_MAX_PIXELS = 96;
const WHOLE_NUMBER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const DECIMAL_NUMBER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

/**
 * Ground meters represented by one CSS pixel in Web Mercator.
 *
 * The map's display latitude is negated in south-up mode, but the scale is
 * symmetric around the equator, so the absolute value is what matters.
 */
export function metersPerPixel(latitude: number, zoom: number): number {
  const clampedLatitude = Math.min(
    MAX_MERCATOR_LATITUDE,
    Math.max(-MAX_MERCATOR_LATITUDE, latitude),
  );
  return (
    METERS_PER_PIXEL_AT_EQUATOR_Z0 *
    Math.cos((clampedLatitude * Math.PI) / 180) /
    2 ** zoom
  );
}

/** Choose the largest 1/2/5 × 10ⁿ distance that fits the available width. */
export function scaleBarForView(
  latitude: number,
  zoom: number,
  maxPixels = DEFAULT_MAX_PIXELS,
): ScaleBar {
  const width = Math.max(1, maxPixels);
  const metersPerCssPixel = Math.max(1e-9, metersPerPixel(latitude, zoom));
  const maxMeters = metersPerCssPixel * width;
  const magnitude = 10 ** Math.floor(Math.log10(maxMeters));
  const distanceMeters =
    [5, 2, 1]
      .map((factor) => factor * magnitude)
      .find((distance) => distance <= maxMeters) ?? magnitude;
  const pixels = Math.min(width, Math.max(1, distanceMeters / metersPerCssPixel));

  return {
    distanceMeters,
    pixels,
    label: formatDistance(distanceMeters),
  };
}

function formatDistance(meters: number): string {
  if (meters < 1) {
    return `${formatNumber(meters * 100, 1)} cm`;
  }
  if (meters < 1_000) {
    return `${formatNumber(meters, 0)} m`;
  }
  return `${formatNumber(meters / 1_000, 0)} km`;
}

function formatNumber(value: number, maximumFractionDigits: number): string {
  return (maximumFractionDigits > 0 ? DECIMAL_NUMBER : WHOLE_NUMBER).format(
    value,
  );
}
