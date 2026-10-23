/** Place-label layers considered when naming the current view. */
export const SHARE_CAPTION_LAYER_IDS: string[] = [
  "place-capital",
  "place-city",
  "place-town",
  "place-region",
  "place-country",
];

export interface ShareCaptionFeature {
  layerId: string;
  properties: Record<string, unknown>;
}

const PLACE_PRIORITY: Record<string, number> = {
  "place-capital": 0,
  "place-city": 1,
  "place-town": 2,
  "place-region": 3,
  "place-country": 4,
};

function textProperty(
  properties: Record<string, unknown>,
  key: string,
): string {
  const value = properties[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Choose the most specific place label near the viewport center. Cities and
 * towns carry a country, so the caption reads "Denver, United States of
 * America" rather than just a bare name.
 */
export function shareCaptionForFeatures(
  features: readonly ShareCaptionFeature[],
): string | null {
  let best: { priority: number; name: string; country: string } | undefined;

  for (const feature of features) {
    const priority = PLACE_PRIORITY[feature.layerId];
    if (priority === undefined) continue;
    const name =
      textProperty(feature.properties, "name") ||
      textProperty(feature.properties, "name_en");
    if (!name) continue;
    if (best && priority >= best.priority) continue;
    best = {
      priority,
      name,
      country: textProperty(feature.properties, "country"),
    };
  }

  if (!best) return null;
  return best.country && best.country !== best.name
    ? `${best.name}, ${best.country}`
    : best.name;
}

export function shareTextForCaption(
  caption: string | null,
  orientation: "south" | "north" = "south",
): string {
  if (caption) {
    return `${orientation === "north" ? "North" : "South"} is up over ${caption}.`;
  }
  return orientation === "north"
    ? "A north-up world map."
    : "A south-up world map.";
}
