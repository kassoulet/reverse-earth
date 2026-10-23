/** Layers that can open a click-to-inspect card. */
export const INSPECT_LAYER_IDS: string[] = [
  "place-country",
  "place-capital-dot",
  "place-capital",
  "place-city-dot",
  "place-city",
  "place-town",
  "place-region",
  "airport-dot",
  "airport-label",
  "port-dot",
  "port-label",
  "park",
];

export type FeatureCategory = "place" | "airport" | "port" | "park";

export interface FeatureCardFact {
  label: string;
  value: string;
}

export interface FeatureCardModel {
  eyebrow: string;
  title: string;
  subtitle: string;
  facts: FeatureCardFact[];
}

export interface RealCoordinate {
  longitude: number;
  latitude: number;
}

const CATEGORY_LABELS: Record<FeatureCategory, string> = {
  place: "Place",
  airport: "Airport",
  port: "Port",
  park: "Park",
};

const PLACE_KIND_LABELS: Record<string, string> = {
  capital: "Capital city",
  city: "City",
  town: "Town",
  region: "Admin 1 region",
  country: "Country",
};

const FALLBACK_TITLES: Record<FeatureCategory, string> = {
  place: "Unnamed place",
  airport: "Unnamed airport",
  port: "Unnamed port",
  park: "Unnamed park",
};

export function categoryForLayer(layerId: string): FeatureCategory | null {
  if (layerId.startsWith("place-")) return "place";
  if (layerId.startsWith("airport-")) return "airport";
  if (layerId.startsWith("port-")) return "port";
  if (layerId === "park") return "park";
  return null;
}

function textProperty(
  properties: Record<string, unknown>,
  key: string,
): string {
  const value = properties[key];
  return typeof value === "string" ? value.trim() : "";
}

function numberProperty(
  properties: Record<string, unknown>,
  key: string,
): number {
  const value = Number(properties[key]);
  return Number.isFinite(value) ? value : 0;
}

export function formatCoordinates(
  longitude: number,
  latitude: number,
): string | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return null;

  const latitudeDirection = latitude >= 0 ? "N" : "S";
  const longitudeDirection = longitude >= 0 ? "E" : "W";
  const latitudeText = Math.abs(latitude).toFixed(2);
  const longitudeText = Math.abs(longitude).toFixed(2);
  return `${latitudeText}° ${latitudeDirection}, ${longitudeText}° ${longitudeDirection}`;
}

function formatPopulation(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function airportTypeLabel(value: string): string {
  switch (value.toLowerCase()) {
    case "major":
      return "Major airport";
    case "mid":
      return "Regional airport";
    case "small":
      return "Small airport";
    case "military":
      return "Military airport";
    case "major and military":
    case "military major":
      return "Major military airport";
    case "mid and military":
    case "military mid":
      return "Regional military airport";
    case "spaceport":
      return "Spaceport";
    default:
      return value || "Airport";
  }
}

export function buildFeatureCard(
  layerId: string,
  properties: Record<string, unknown>,
  coordinate: RealCoordinate,
): FeatureCardModel | null {
  const category = categoryForLayer(layerId);
  if (!category) return null;

  const name =
    textProperty(properties, "name") || textProperty(properties, "name_en");
  const title = name || FALLBACK_TITLES[category];
  const facts: FeatureCardFact[] = [];

  let subtitle: string;
  switch (category) {
    case "place": {
      const kind = textProperty(properties, "kind");
      const kindLabel = PLACE_KIND_LABELS[kind] ?? "Place";
      const country = textProperty(properties, "country");
      subtitle = country ? `${kindLabel} · ${country}` : kindLabel;
      const population = formatPopulation(
        numberProperty(properties, "population"),
      );
      if (population) facts.push({ label: "Population", value: population });
      break;
    }
    case "airport": {
      subtitle = airportTypeLabel(textProperty(properties, "type"));
      const iata = textProperty(properties, "iata");
      if (iata) facts.push({ label: "IATA code", value: iata });
      break;
    }
    case "port":
      subtitle = "Seaport";
      break;
    case "park":
      subtitle = textProperty(properties, "type") || "Protected area";
      break;
  }

  const coordinates = formatCoordinates(
    coordinate.longitude,
    coordinate.latitude,
  );
  if (coordinates) facts.push({ label: "Coordinates", value: coordinates });

  return {
    eyebrow: CATEGORY_LABELS[category],
    title,
    subtitle,
    facts,
  };
}
