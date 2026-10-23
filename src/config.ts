const DEFAULT_ARCHIVE_PATH = "data/world.pmtiles";

/** Absolute URL of the deployed application root (works under /<repo>/ on Pages). */
export function appBaseUrl(): string {
  const base = import.meta.env.BASE_URL || "/";
  return new URL(base, window.location.origin).href;
}

/** Resolve a static asset relative to the deployed base path. */
export function resolveAppUrl(path: string): string {
  return new URL(path, appBaseUrl()).href;
}

/**
 * PMTiles archive URL, in priority order:
 *   1. ?pmtiles=<url> query parameter (useful for testing another archive),
 *   2. VITE_PMTILES_URL at build time,
 *   3. data/world.pmtiles inside the deployment.
 */
export function resolvePmtilesUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search)
    .get("pmtiles")
    ?.trim();
  const configured =
    fromQuery || import.meta.env.VITE_PMTILES_URL?.trim() || DEFAULT_ARCHIVE_PATH;
  return new URL(configured, appBaseUrl()).href;
}

/** MapLibre glyph URL template for the self-hosted font files. */
export function glyphUrlTemplate(): string {
  return `${appBaseUrl()}fonts/{fontstack}/{range}.pbf`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index++;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
