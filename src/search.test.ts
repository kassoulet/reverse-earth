import { describe, expect, it } from "vitest";
import {
  buildSearchResults,
  formatCoordinates,
  loadPlaces,
  normalizeText,
  parseCoordinateQuery,
  parsePlaceIndex,
  searchPlaces,
  type Place,
} from "./search";

const PLACES: Place[] = [
  {
    name: "Paris",
    country: "France",
    latitude: 48.8566,
    longitude: 2.3522,
    population: 11_000_000,
  },
  {
    name: "Paris",
    country: "United States of America",
    latitude: 33.6609,
    longitude: -95.5555,
    population: 25_000,
  },
  {
    name: "Toulouse",
    country: "France",
    latitude: 43.6045,
    longitude: 1.4442,
    population: 500_000,
  },
  {
    name: "São Paulo",
    ascii: "Sao Paulo",
    country: "Brazil",
    latitude: -23.5505,
    longitude: -46.6333,
    population: 22_000_000,
  },
  {
    name: "Sydney",
    country: "Australia",
    latitude: -33.8688,
    longitude: 151.2093,
    population: 5_000_000,
  },
  {
    name: "Tokyo",
    country: "Japan",
    latitude: 35.6895,
    longitude: 139.6917,
    population: 35_000_000,
  },
];

describe("parseCoordinateQuery", () => {
  it("parses latitude, longitude in decimal degrees", () => {
    expect(parseCoordinateQuery("48.8566, 2.3522")).toEqual({
      latitude: 48.8566,
      longitude: 2.3522,
    });
    expect(parseCoordinateQuery("48.8566 2.3522")).toEqual({
      latitude: 48.8566,
      longitude: 2.3522,
    });
  });

  it("accepts negative coordinates and degree signs", () => {
    expect(parseCoordinateQuery("-33.8688, 151.2093")).toEqual({
      latitude: -33.8688,
      longitude: 151.2093,
    });
    expect(parseCoordinateQuery("48.8566° 2.3522°")).toEqual({
      latitude: 48.8566,
      longitude: 2.3522,
    });
    expect(parseCoordinateQuery("-23.5505, -46.6333")).toEqual({
      latitude: -23.5505,
      longitude: -46.6333,
    });
  });

  it("uses hemisphere letters to decide the axes", () => {
    expect(parseCoordinateQuery("48.8566 N, 2.3522 E")).toEqual({
      latitude: 48.8566,
      longitude: 2.3522,
    });
    expect(parseCoordinateQuery("2.3522 E 48.8566 N")).toEqual({
      latitude: 48.8566,
      longitude: 2.3522,
    });
    expect(parseCoordinateQuery("33.8688 S, 151.2093 E")).toEqual({
      latitude: -33.8688,
      longitude: 151.2093,
    });
    expect(parseCoordinateQuery("N48.8566 E2.3522")).toEqual({
      latitude: 48.8566,
      longitude: 2.3522,
    });
  });

  it("rejects non-coordinate and out-of-range input", () => {
    expect(parseCoordinateQuery("Paris")).toBeNull();
    expect(parseCoordinateQuery("")).toBeNull();
    expect(parseCoordinateQuery("91, 0")).toBeNull();
    expect(parseCoordinateQuery("0, 181")).toBeNull();
    expect(parseCoordinateQuery("48.8 N, 2.3 N")).toBeNull();
    expect(parseCoordinateQuery("48°51′24″N 2°21′03″E")).toBeNull();
  });
});

describe("searchPlaces", () => {
  it("ranks an exact name first and breaks ties by population", () => {
    const results = searchPlaces("paris", PLACES);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: "Paris",
      detail: "France",
      latitude: 48.8566,
      longitude: 2.3522,
    });
    expect(results[1]?.detail).toBe("United States of America");
  });

  it("matches accented names and their Latin spelling", () => {
    expect(searchPlaces("sao", PLACES)[0]?.title).toBe("São Paulo");
    expect(searchPlaces("são", PLACES)[0]?.title).toBe("São Paulo");
  });

  it("matches a country when no place name does", () => {
    const results = searchPlaces("france", PLACES);
    expect(results.map((result) => result.title)).toEqual(["Paris", "Toulouse"]);
  });

  it("requires every token to match", () => {
    expect(searchPlaces("paris france", PLACES).map((r) => r.title)).toEqual([
      "Paris",
    ]);
  });

  it("honours the result limit and ignores empty queries", () => {
    expect(searchPlaces("a", PLACES, 2)).toHaveLength(2);
    expect(searchPlaces("   ", PLACES)).toEqual([]);
  });
});

describe("buildSearchResults", () => {
  it("puts a coordinate hit before place matches", () => {
    const results = buildSearchResults("48.8566, 2.3522", PLACES);
    expect(results[0]).toMatchObject({
      kind: "coordinate",
      latitude: 48.8566,
      longitude: 2.3522,
    });
    expect(results[0]?.title).toBe("48.8566, 2.3522");
  });

  it("returns place results for a name", () => {
    expect(buildSearchResults("tokyo", PLACES)[0]).toMatchObject({
      kind: "place",
      title: "Tokyo",
      detail: "Japan",
    });
  });
});

describe("place index", () => {
  it("drops malformed and out-of-range rows", () => {
    const places = parsePlaceIndex({
      places: [
        ["Valid", "Country", 10, 20, 100],
        ["No population", "Country", 10, 20],
        ["Bad latitude", "Country", 91, 20, 100],
        ["Bad longitude", "Country", 10, 181, 100],
        [42, "Country", 10, 20, 100],
        ["Ascii", "Country", 10, 20, 100, "Ascii Name"],
      ],
    });
    expect(places.map((place) => place.name)).toEqual(["Valid", "Ascii"]);
    expect(places[1]?.ascii).toBe("Ascii Name");
  });

  it("rejects an index without a places array", () => {
    expect(() => parsePlaceIndex({})).toThrow(/Malformed/);
    expect(() => parsePlaceIndex(null)).toThrow(/Malformed/);
  });

  it("normalizes accents, case and punctuation", () => {
    expect(normalizeText("  São   Paulo! ")).toBe("sao paulo");
    expect(normalizeText("Zürich")).toBe("zurich");
  });

  it("exposes a loader for the bundled index", () => {
    expect(typeof loadPlaces).toBe("function");
    expect(formatCoordinates(2.3522, 48.8566)).toBe("48.8566, 2.3522");
  });
});
