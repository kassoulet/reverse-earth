import { describe, expect, it } from "vitest";
import {
  shareCaptionForFeatures,
  shareTextForCaption,
} from "./share-caption";

describe("shareCaptionForFeatures", () => {
  it("prefers a city and appends its country", () => {
    expect(
      shareCaptionForFeatures([
        {
          layerId: "place-country",
          properties: { name: "United States of America" },
        },
        {
          layerId: "place-city",
          properties: { name: "Denver", country: "United States of America" },
        },
      ]),
    ).toBe("Denver, United States of America");
  });

  it("uses a region when no city label is present", () => {
    expect(
      shareCaptionForFeatures([
        {
          layerId: "place-region",
          properties: { name: "Colorado", country: "United States of America" },
        },
      ]),
    ).toBe("Colorado, United States of America");
  });

  it("does not duplicate a country's own name", () => {
    expect(
      shareCaptionForFeatures([
        {
          layerId: "place-country",
          properties: { name: "France", country: "France" },
        },
      ]),
    ).toBe("France");
  });

  it("ignores unknown layers, empty names and missing labels", () => {
    expect(
      shareCaptionForFeatures([
        {
          layerId: "airport-dot",
          properties: { name: "Denver International" },
        },
        { layerId: "place-city", properties: { name: "  " } },
      ]),
    ).toBeNull();
  });
});

describe("shareTextForCaption", () => {
  it("formats a caption and a generic fallback", () => {
    expect(shareTextForCaption("Denver")).toBe("South is up over Denver.");
    expect(shareTextForCaption(null)).toBe("A south-up world map.");
  });

  it("matches the north-up comparison", () => {
    expect(shareTextForCaption("Denver", "north")).toBe(
      "North is up over Denver.",
    );
    expect(shareTextForCaption(null, "north")).toBe(
      "A north-up world map.",
    );
  });
});
