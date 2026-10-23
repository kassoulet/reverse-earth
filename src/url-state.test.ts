import { describe, expect, it } from "vitest";
import {
  readUrlState,
  updateUrl,
  viewCenter,
  viewFromMap,
} from "./url-state";

describe("readUrlState", () => {
  it("reads the canonical #map=zoom/latitude/longitude hash", () => {
    const state = readUrlState("?orientation=north", "#map=5.5/48.8566/2.3522");
    expect(state.view).toEqual({
      longitude: 2.3522,
      latitude: 48.8566,
      zoom: 5.5,
    });
    expect(state.orientation).toBe("north");
  });

  it("accepts query parameters for older links", () => {
    const state = readUrlState("?latitude=-33.9&lng=151.2&zoom=3");
    expect(state.view).toEqual({
      longitude: 151.2,
      latitude: -33.9,
      zoom: 3,
    });
    expect(state.orientation).toBeUndefined();
  });

  it("prefers the hash over query coordinates", () => {
    const state = readUrlState(
      "?lat=0&lon=0&z=2",
      "#map=6/43.6/1.44",
    );
    expect(state.view).toEqual({
      longitude: 1.44,
      latitude: 43.6,
      zoom: 6,
    });
  });

  it("defaults and clamps the zoom", () => {
    expect(readUrlState("", "#map=/0/0").view?.zoom).toBe(2);
    expect(readUrlState("?lat=0&lon=0").view?.zoom).toBe(2);
    expect(readUrlState("?lat=0&lon=0&z=-5").view?.zoom).toBe(0);
    expect(readUrlState("?lat=0&lon=0&z=99").view?.zoom).toBe(14);
  });

  it("rejects an incomplete or out-of-range view", () => {
    expect(readUrlState("?lat=10").view).toBeUndefined();
    expect(readUrlState("?lat=89&lon=0").view).toBeUndefined();
    expect(readUrlState("?lat=0&lon=181").view).toBeUndefined();
    expect(readUrlState("?lat=nope&lon=0").view).toBeUndefined();
    expect(readUrlState("", "#map=6/89/0").view).toBeUndefined();
    expect(readUrlState("", "#map=6/0").view).toBeUndefined();
  });
});

describe("coordinate conversion", () => {
  const paris = { longitude: 2.3522, latitude: 48.8566, zoom: 6 };

  it("places a real coordinate in display space", () => {
    expect(viewCenter(paris, "south")).toEqual([2.3522, -48.8566]);
    expect(viewCenter(paris, "north")).toEqual([2.3522, 48.8566]);
  });

  it("returns the same real coordinate from either orientation", () => {
    expect(viewFromMap(2.3522, -48.8566, 6, "south")).toEqual(paris);
    expect(viewFromMap(2.3522, 48.8566, 6, "north")).toEqual(paris);
  });

  it("wraps longitudes from repeated world copies", () => {
    const state = viewFromMap(190, 0, 4, "north");
    expect(state.longitude).toBe(-170);
  });
});

describe("updateUrl", () => {
  it("writes real coordinates in the #map hash and preserves options", () => {
    const url = updateUrl(
      "https://example.test/repo/?pmtiles=https%3A%2F%2Fexample.test%2Fworld.pmtiles&lat=0&z=1",
      { longitude: -0.1276, latitude: 51.5072, zoom: 7.25 },
      "north",
    );
    const parsed = new URL(url, "https://example.test");
    expect(parsed.hash).toBe("#map=7.25/51.5072/-0.1276");
    expect(parsed.searchParams.get("lat")).toBeNull();
    expect(parsed.searchParams.get("z")).toBeNull();
    expect(parsed.searchParams.get("orientation")).toBe("north");
    expect(parsed.searchParams.get("pmtiles")).toBe(
      "https://example.test/world.pmtiles",
    );
  });

  it("removes the orientation parameter for the default south-up view", () => {
    const url = updateUrl(
      "https://example.test/?orientation=north",
      { longitude: 0, latitude: 0, zoom: 2 },
      "south",
    );
    const parsed = new URL(url, "https://example.test");
    expect(parsed.searchParams.has("orientation")).toBe(false);
    expect(parsed.hash).toBe("#map=2/0/0");
  });
});
