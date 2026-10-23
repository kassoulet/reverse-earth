import { describe, expect, it } from "vitest";
import {
  buildFeatureCard,
  categoryForLayer,
  formatCoordinates,
} from "./feature-card";

const toulouse = { longitude: 1.4442, latitude: 43.6047 };

describe("categoryForLayer", () => {
  it("maps every inspectable layer group and rejects other layers", () => {
    expect(categoryForLayer("place-capital")).toBe("place");
    expect(categoryForLayer("airport-label")).toBe("airport");
    expect(categoryForLayer("port-dot")).toBe("port");
    expect(categoryForLayer("park")).toBe("park");
    expect(categoryForLayer("wetland")).toBe("wetland");
    expect(categoryForLayer("marine-label")).toBe("marine");
    expect(categoryForLayer("physio-label")).toBe("physio");
    expect(categoryForLayer("peak-dot")).toBe("peak");
    expect(categoryForLayer("peak-label")).toBe("peak");
    expect(categoryForLayer("road-major")).toBeNull();
  });
});

describe("buildFeatureCard", () => {
  it("formats a capital city with its country and population", () => {
    const card = buildFeatureCard(
      "place-capital",
      {
        name: "Paris",
        kind: "capital",
        country: "France",
        population: 2161000,
      },
      { longitude: 2.3522, latitude: 48.8566 },
    );

    expect(card).toEqual({
      eyebrow: "Place",
      title: "Paris",
      subtitle: "Capital city · France",
      facts: [
        { label: "Population", value: "2,161,000" },
        { label: "Coordinates", value: "48.86° N, 2.35° E" },
      ],
    });
  });

  it("formats an Admin 1 region without a population row", () => {
    const card = buildFeatureCard(
      "place-region",
      {
        name: "Occitanie",
        kind: "region",
        country: "France",
        population: 0,
      },
      toulouse,
    );

    expect(card?.subtitle).toBe("Admin 1 region · France");
    expect(card?.facts).toEqual([
      { label: "Coordinates", value: "43.60° N, 1.44° E" },
    ]);
  });

  it("formats an airport with its type and IATA code", () => {
    const card = buildFeatureCard(
      "airport-dot",
      {
        name: "Toulouse-Blagnac Airport",
        type: "major",
        iata: "TLS",
      },
      toulouse,
    );

    expect(card).toEqual({
      eyebrow: "Airport",
      title: "Toulouse-Blagnac Airport",
      subtitle: "Major airport",
      facts: [
        { label: "IATA code", value: "TLS" },
        { label: "Coordinates", value: "43.60° N, 1.44° E" },
      ],
    });
  });

  it("expands Natural Earth's military airport types", () => {
    const card = buildFeatureCard(
      "airport-label",
      { name: "Joint Base", type: "mid and military" },
      toulouse,
    );
    expect(card?.subtitle).toBe("Regional military airport");
  });

  it("formats ports and parks with fallback subtitles", () => {
    const port = buildFeatureCard(
      "port-label",
      { name: "Port of Rotterdam" },
      { longitude: 4.4, latitude: 51.9 },
    );
    expect(port?.subtitle).toBe("Seaport");
    expect(port?.facts[0]).toEqual({
      label: "Coordinates",
      value: "51.90° N, 4.40° E",
    });

    const park = buildFeatureCard(
      "park",
      { name: "Yellowstone", type: "National Park" },
      { longitude: -110.6, latitude: 44.4 },
    );
    expect(park?.eyebrow).toBe("Park");
    expect(park?.subtitle).toBe("National Park");
  });

  it("formats a named wetland", () => {
    const card = buildFeatureCard(
      "wetland",
      { name: "Pantanal", class: "wetland" },
      { longitude: -57.5, latitude: -17.5 },
    );

    expect(card).toEqual({
      eyebrow: "Wetland",
      title: "Pantanal",
      subtitle: "Wetland",
      facts: [
        { label: "Coordinates", value: "17.50° S, 57.50° W" },
      ],
    });
  });

  it("formats a water body with its Natural Earth class", () => {
    const card = buildFeatureCard(
      "marine-label",
      { name: "North Atlantic Ocean", class: "ocean" },
      { longitude: -30, latitude: 40 },
    );

    expect(card).toEqual({
      eyebrow: "Water body",
      title: "North Atlantic Ocean",
      subtitle: "Ocean",
      facts: [
        { label: "Coordinates", value: "40.00° N, 30.00° W" },
      ],
    });
  });

  it("formats a desert, range or plain", () => {
    const card = buildFeatureCard(
      "physio-label",
      { name: "Sahara", class: "desert" },
      { longitude: 13, latitude: 23 },
    );

    expect(card).toEqual({
      eyebrow: "Physical region",
      title: "Sahara",
      subtitle: "Desert",
      facts: [
        { label: "Coordinates", value: "23.00° N, 13.00° E" },
      ],
    });
  });

  it("formats a peak with its elevation and country", () => {
    const card = buildFeatureCard(
      "peak-label",
      {
        name: "Mont Blanc",
        class: "mountain",
        elevation: 4807,
        country: "France",
      },
      { longitude: 6.865, latitude: 45.8326 },
    );

    expect(card).toEqual({
      eyebrow: "Elevation",
      title: "Mont Blanc",
      subtitle: "Mountain",
      facts: [
        { label: "Elevation", value: "4,807 m" },
        { label: "Country", value: "France" },
        { label: "Coordinates", value: "45.83° N, 6.87° E" },
      ],
    });
  });

  it("describes depressions below sea level", () => {
    const card = buildFeatureCard(
      "peak-dot",
      { name: "Death Valley", class: "depression", elevation: -86 },
      { longitude: -116.8, latitude: 36.2 },
    );

    expect(card?.subtitle).toBe("Depression");
    expect(card?.facts[0]).toEqual({
      label: "Elevation",
      value: "86 m below sea level",
    });
  });

  it("falls back when a feature has no name and omits invalid coordinates", () => {
    const card = buildFeatureCard(
      "place-town",
      { kind: "town" },
      { longitude: Number.NaN, latitude: 0 },
    );

    expect(card?.title).toBe("Unnamed place");
    expect(card?.subtitle).toBe("Town");
    expect(card?.facts).toEqual([]);
  });

  it("rejects layers that are not inspectable", () => {
    expect(buildFeatureCard("road-major", { name: "A1" }, toulouse)).toBeNull();
  });
});

describe("formatCoordinates", () => {
  it("uses hemispheres and rejects out-of-range values", () => {
    expect(formatCoordinates(-122.42, 37.77)).toBe("37.77° N, 122.42° W");
    expect(formatCoordinates(151.21, -33.87)).toBe("33.87° S, 151.21° E");
    expect(formatCoordinates(181, 0)).toBeNull();
    expect(formatCoordinates(0, Number.NaN)).toBeNull();
  });
});
