import { describe, expect, it } from "vitest";
import { metersPerPixel, scaleBarForView } from "./scale";

describe("metersPerPixel", () => {
  it("matches the Web Mercator equator at z0", () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(78_271.5168, 3);
  });

  it("halves with each zoom level and shrinks with latitude", () => {
    expect(metersPerPixel(0, 1)).toBeCloseTo(metersPerPixel(0, 0) / 2, 6);
    expect(metersPerPixel(60, 6)).toBeLessThan(metersPerPixel(0, 6));
    expect(metersPerPixel(-60, 6)).toBeCloseTo(metersPerPixel(60, 6), 6);
  });

  it("clamps beyond the Web Mercator limit", () => {
    expect(metersPerPixel(90, 0)).toBeCloseTo(metersPerPixel(85.0511287798066, 0), 6);
  });
});

describe("scaleBarForView", () => {
  it("chooses a round world-scale distance", () => {
    const scale = scaleBarForView(0, 0);
    expect(scale.distanceMeters).toBe(5_000_000);
    expect(scale.label).toBe("5,000 km");
    expect(scale.pixels).toBeCloseTo(63.88, 1);
  });

  it("scales down for regional and local zooms", () => {
    expect(scaleBarForView(0, 6).label).toBe("100 km");
    expect(scaleBarForView(0, 10).label).toBe("5 km");
    expect(scaleBarForView(0, 14).label).toBe("200 m");
  });

  it("uses latitude-adjusted distances near the poles", () => {
    expect(scaleBarForView(60, 6).label).toBe("50 km");
    expect(scaleBarForView(85, 6).label).toBe("10 km");
  });

  it("never exceeds the requested width and stays positive", () => {
    for (const zoom of [0, 3, 6, 10, 14]) {
      const scale = scaleBarForView(45, zoom, 80);
      expect(scale.pixels).toBeGreaterThan(0);
      expect(scale.pixels).toBeLessThanOrEqual(80);
    }
  });
});
