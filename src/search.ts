import { isValidGeo } from "./coordinates";
import { resolveAppUrl } from "./config";

/**
 * Offline place search plus decimal-degree coordinate search.
 *
 * Places come from the bundled Natural Earth populated-places index, so the
 * application still makes no request to a geocoding service at runtime.
 */

export interface Place {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
  population: number;
  /** Latin transliteration, when it differs from the display name. */
  ascii?: string;
}

export interface Coordinate {
  longitude: number;
  latitude: number;
}

export interface SearchResult {
  id: string;
  kind: "place" | "coordinate";
  title: string;
  detail: string;
  longitude: number;
  latitude: number;
}

interface IndexedPlace extends Place {
  searchName: string;
  searchAscii: string;
  searchCountry: string;
}

const DIACRITICS = /[\u0300-\u036f]/g;
const NUMBER_PATTERN = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
const NUMERIC_QUERY = /^[\s\d.,;+\-NSEWnsew]+$/;
const COORDINATE_TOKEN = new RegExp(
  `^([NSEWnsew])?(${NUMBER_PATTERN})([NSEWnsew])?$`,
);

let placeIndexPromise: Promise<readonly Place[]> | undefined;
let indexCache: { source: readonly Place[]; indexed: IndexedPlace[] } | undefined;

/** Fold case and strip accents/punctuation for tolerant matching. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Parse decimal-degree coordinates. The documented order is `latitude,
 * longitude`; hemisphere letters make the axes explicit and allow either order.
 */
export function parseCoordinateQuery(query: string): Coordinate | null {
  const cleaned = query
    .replace(/^geo:\s*/i, "")
    .replace(/[°º]/g, " ")
    .trim();
  if (!cleaned || !NUMERIC_QUERY.test(cleaned)) return null;

  // Join a number and a hemisphere letter that were separated by spaces, so
  // both "48.8N 2.3E" and "48.8 N 2.3 E" become two coordinate tokens.
  const parts = cleaned.split(/[\s,;]+/).filter(Boolean);
  const tokens: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (/^[NSEWnsew]$/.test(part) && next && /^[+-]?[\d.]/.test(next)) {
      tokens.push(part + next);
      i += 1;
    } else if (next && /^[NSEWnsew]$/.test(next) && /^[+-]?[\d.]/.test(part)) {
      tokens.push(part + next);
      i += 1;
    } else {
      tokens.push(part);
    }
  }
  if (tokens.length !== 2) return null;

  const first = parseCoordinateToken(tokens[0]!);
  const second = parseCoordinateToken(tokens[1]!);
  if (!first || !second) return null;
  if (first.axis && second.axis && first.axis === second.axis) return null;

  let latitude: number;
  let longitude: number;

  if (first.axis === "lat" || second.axis === "lon") {
    latitude = first.value;
    longitude = second.value;
  } else if (first.axis === "lon" || second.axis === "lat") {
    longitude = first.value;
    latitude = second.value;
  } else {
    latitude = first.value;
    longitude = second.value;
  }

  if (!isValidGeo(longitude, latitude)) return null;
  return { longitude, latitude };
}

interface ParsedToken {
  value: number;
  axis?: "lat" | "lon";
}

function parseCoordinateToken(token: string): ParsedToken | null {
  const match = COORDINATE_TOKEN.exec(token);
  if (!match) return null;

  const prefix = match[1]?.toUpperCase();
  const suffix = match[3]?.toUpperCase();
  if (prefix && suffix && prefix !== suffix) return null;
  const direction = prefix ?? suffix;

  let value = Number(match[2]);
  if (!Number.isFinite(value)) return null;
  if (direction === "S" || direction === "W") value = -Math.abs(value);
  else if (direction === "N" || direction === "E") value = Math.abs(value);

  return {
    value,
    axis:
      direction === "N" || direction === "S"
        ? "lat"
        : direction === "E" || direction === "W"
          ? "lon"
          : undefined,
  };
}

export function formatCoordinateNumber(value: number): string {
  return Number(value.toFixed(5)).toString();
}

export function formatCoordinates(longitude: number, latitude: number): string {
  return `${formatCoordinateNumber(latitude)}, ${formatCoordinateNumber(longitude)}`;
}

/** Rank places for a query. Names beat country matches; population breaks ties. */
export function searchPlaces(
  query: string,
  places: readonly Place[],
  limit = 8,
): SearchResult[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  const tokens = normalizedQuery.split(" ");
  const indexed = indexPlaces(places);
  const matches: Array<{ place: IndexedPlace; score: number }> = [];

  for (const place of indexed) {
    const haystack = `${place.searchName} ${place.searchAscii} ${place.searchCountry}`;
    if (!tokens.every((token) => haystack.includes(token))) continue;

    const names = [place.searchName, place.searchAscii].filter(Boolean);
    let score: number;
    if (names.some((name) => name === normalizedQuery)) score = 1000;
    else if (names.some((name) => name.startsWith(normalizedQuery))) score = 850;
    else if (
      names.some((name) =>
        name.split(" ").some((word) => word.startsWith(normalizedQuery)),
      )
    ) {
      score = 750;
    } else if (names.some((name) => name.includes(normalizedQuery))) score = 650;
    else score = 500;

    score += Math.min(60, Math.log10(place.population + 1) * 8);
    matches.push({ place, score });
  }

  matches.sort(
    (a, b) => b.score - a.score || b.place.population - a.place.population,
  );

  return matches.slice(0, limit).map(({ place }) => ({
    id: `place:${place.name}:${place.latitude}:${place.longitude}`,
    kind: "place",
    title: place.name,
    detail: place.country,
    longitude: place.longitude,
    latitude: place.latitude,
  }));
}

/** Coordinate hits come first, then ranked place matches. */
export function buildSearchResults(
  query: string,
  places: readonly Place[],
  limit = 8,
): SearchResult[] {
  const results: SearchResult[] = [];
  const coordinate = parseCoordinateQuery(query);
  if (coordinate) {
    results.push({
      id: "coordinate",
      kind: "coordinate",
      title: formatCoordinates(coordinate.longitude, coordinate.latitude),
      detail: "Coordinates · latitude, longitude",
      longitude: coordinate.longitude,
      latitude: coordinate.latitude,
    });
  }
  results.push(...searchPlaces(query, places, limit));
  return results;
}

function indexPlaces(places: readonly Place[]): IndexedPlace[] {
  if (indexCache?.source === places) return indexCache.indexed;
  const indexed = places.map((place) => ({
    ...place,
    searchName: normalizeText(place.name),
    searchAscii: place.ascii ? normalizeText(place.ascii) : "",
    searchCountry: normalizeText(place.country),
  }));
  indexCache = { source: places, indexed };
  return indexed;
}

/** Fetch and validate the bundled Natural Earth place index once. */
export async function loadPlaces(): Promise<readonly Place[]> {
  if (!placeIndexPromise) {
    placeIndexPromise = fetch(resolveAppUrl("data/places.json"), {
      cache: "force-cache",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Place index request failed (${response.status} ${response.statusText})`,
          );
        }
        return parsePlaceIndex(await response.json());
      })
      .catch((error: unknown) => {
        placeIndexPromise = undefined;
        throw error;
      });
  }
  return placeIndexPromise;
}

export function parsePlaceIndex(raw: unknown): Place[] {
  const rows = (raw as { places?: unknown } | null)?.places;
  if (!Array.isArray(rows)) throw new Error("Malformed place index");

  const places: Place[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [name, country, latitude, longitude, population, ascii] = row;
    if (typeof name !== "string" || !name.trim()) continue;
    if (typeof country !== "string") continue;
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      typeof population !== "number"
    ) {
      continue;
    }
    if (!isValidGeo(longitude, latitude)) continue;

    places.push({
      name,
      country,
      latitude,
      longitude,
      population: Math.max(0, population),
      ...(typeof ascii === "string" && ascii.trim() ? { ascii } : {}),
    });
  }
  return places;
}
