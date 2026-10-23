import { describe, expect, it } from "vitest";
import {
  MAX_MERCATOR_LATITUDE,
  displayToGeo,
  flipLatitude,
  geoToDisplay,
  isValidGeo,
  wrapLongitude,
} from "./coordinates";

describe("geoToDisplay", () => {
  it("negates latitude and preserves longitude", () => {
    expect(geoToDisplay(1.44, 43.6)).toEqual([1.44, -43.6]);
    expect(geoToDisplay(151.21, -33.87)).toEqual([151.21, 33.87]);
    expect(geoToDisplay(-122.42, 37.77)).toEqual([-122.42, -37.77]);
  });

  it("puts the south pole at the top and the north pole at the bottom", () => {
    expect(geoToDisplay(0, 90)).toEqual([0, -90]);
    expect(geoToDisplay(0, -90)).toEqual([0, 90]);
  });

  it("leaves the equator and the antimeridian in place", () => {
    expect(geoToDisplay(0, 0)).toEqual([0, 0]);
    expect(geoToDisplay(180, 12.5)).toEqual([180, -12.5]);
    expect(geoToDisplay(-180, -12.5)).toEqual([-180, 12.5]);
  });

  it("keeps the Web Mercator limit symmetric", () => {
    expect(geoToDisplay(0, MAX_MERCATOR_LATITUDE)).toEqual([
      0,
      -MAX_MERCATOR_LATITUDE,
    ]);
  });

  it("rejects impossible latitudes and non-finite values", () => {
    expect(() => geoToDisplay(0, 90.0001)).toThrow(RangeError);
    expect(() => geoToDisplay(Number.NaN, 0)).toThrow(RangeError);
  });
});

describe("displayToGeo", () => {
  it("negates latitude and preserves longitude", () => {
    expect(displayToGeo(1.44, -43.6)).toEqual([1.44, 43.6]);
    expect(displayToGeo(-73.98, 40.75)).toEqual([-73.98, -40.75]);
  });

  it("round-trips with geoToDisplay", () => {
    const samples: Array<[number, number]> = [
      [0, 0],
      [1.44, 43.6],
      [151.21, -33.87],
      [-180, -85.0511287798066],
      [180, 85.0511287798066],
    ];
    for (const [lon, lat] of samples) {
      expect(displayToGeo(...geoToDisplay(lon, lat))).toEqual([lon, lat]);
    }
  });
});

describe("helpers", () => {
  it("flips latitudes without touching longitude", () => {
    expect(flipLatitude(43.6)).toBe(-43.6);
  });

  it("wraps longitudes without swapping hemispheres", () => {
    expect(wrapLongitude(190)).toBe(-170);
    expect(wrapLongitude(-190)).toBe(170);
    expect(wrapLongitude(180)).toBe(-180);
    expect(wrapLongitude(-180)).toBe(-180);
  });

  it("validates conventional geographic coordinates", () => {
    expect(isValidGeo(1.44, 43.6)).toBe(true);
    expect(isValidGeo(181, 0)).toBe(false);
    expect(isValidGeo(0, 91)).toBe(false);
  });
});
