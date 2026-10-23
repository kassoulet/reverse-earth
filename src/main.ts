import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/app.css";
import {
  Map as MapLibreMap,
  type MapMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import { ArchiveProblem, openArchive, type MapArchive } from "./archive";
import { formatBytes, resolvePmtilesUrl } from "./config";
import { displayToGeo, geoToDisplay, wrapLongitude } from "./coordinates";
import {
  INSPECT_LAYER_IDS,
  buildFeatureCard,
  formatCoordinates,
  type FeatureCardModel,
} from "./feature-card";
import {
  createMap,
  loadStyle,
  setMapOrientation,
  type Orientation,
} from "./map";
import { scaleBarForView } from "./scale";
import type { SearchResult } from "./search";
import { SearchControl } from "./search-control";
import {
  SHARE_CAPTION_LAYER_IDS,
  shareCaptionForFeatures,
  shareTextForCaption,
} from "./share-caption";
import {
  readUrlState,
  updateUrl,
  viewCenter,
  viewFromMap,
} from "./url-state";

const loading = requireElement<HTMLElement>("loading");
const dataState = requireElement<HTMLElement>("data-state");
const stateTitle = requireElement<HTMLElement>("data-state-title");
const stateMessage = requireElement<HTMLElement>("data-state-message");
const stateCommand = requireElement<HTMLElement>("data-state-command");
const stateUrl = requireElement<HTMLElement>("data-state-url");
const retryButton = requireElement<HTMLButtonElement>("retry");
const zoomInButton = requireElement<HTMLButtonElement>("zoom-in");
const zoomOutButton = requireElement<HTMLButtonElement>("zoom-out");
const shareButton = requireElement<HTMLButtonElement>("share-view");
const shareStatus = requireElement<HTMLElement>("share-status");
const mapContainer = requireElement<HTMLElement>("map");
const orientationSouth = requireElement<HTMLButtonElement>("orientation-south");
const orientationNorth = requireElement<HTMLButtonElement>("orientation-north");
const searchForm = requireElement<HTMLFormElement>("search-form");
const searchInput = requireElement<HTMLInputElement>("search-input");
const searchResults = requireElement<HTMLUListElement>("search-results");
const searchStatus = requireElement<HTMLElement>("search-status");
const infoButton = requireElement<HTMLButtonElement>("info-button");
const infoPanel = requireElement<HTMLElement>("info-panel");
const infoClose = requireElement<HTMLButtonElement>("info-close");
const legendButton = requireElement<HTMLButtonElement>("legend-button");
const legendPanel = requireElement<HTMLElement>("legend-panel");
const legendClose = requireElement<HTMLButtonElement>("legend-close");

const OVERLAY_LAYER_IDS = ["hillshade", "forest", "wetland"] as const;
type OverlayLayerId = (typeof OVERLAY_LAYER_IDS)[number];

const overlayToggles: Record<OverlayLayerId, HTMLInputElement> = {
  hillshade: requireElement<HTMLInputElement>("overlay-hillshade"),
  forest: requireElement<HTMLInputElement>("overlay-forest"),
  wetland: requireElement<HTMLInputElement>("overlay-wetland"),
};
const featureCard = requireElement<HTMLElement>("feature-card");
const featureCardClose = requireElement<HTMLButtonElement>("feature-card-close");
const featureCardEyebrow = requireElement<HTMLElement>("feature-card-eyebrow");
const featureCardTitle = requireElement<HTMLElement>("feature-card-title");
const featureCardSubtitle = requireElement<HTMLElement>("feature-card-subtitle");
const featureCardFacts = requireElement<HTMLDListElement>("feature-card-facts");
const mapReadout = requireElement<HTMLElement>("map-readout");
const mapCoordinates = requireElement<HTMLElement>("map-coordinates");
const mapScaleBar = requireElement<HTMLElement>("map-scale-bar");
const mapScaleLabel = requireElement<HTMLElement>("map-scale-label");
const splash = document.getElementById("splash");

const SPLASH_MIN_MS = 2_000;
const SPLASH_MAX_MS = 4_000;
const SPLASH_FADE_MS = 650;
const splashStart = performance.now();
let splashDismissed = false;
let firstMapFrameReady = false;
let splashMinTimer: number | undefined;
let shareStatusTimer: number | undefined;
let readoutFrame: number | undefined;
let readoutEnabled = false;

const initialState = readUrlState(window.location.search, window.location.hash);

let map: MapLibreMap | undefined;
let archive: MapArchive | undefined;
let baseStyle: StyleSpecification | undefined;
let orientation: Orientation = initialState.orientation ?? "south";

const search = new SearchControl({
  form: searchForm,
  input: searchInput,
  list: searchResults,
  status: searchStatus,
  onSelect: flyToResult,
});

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in index.html`);
  return element as T;
}

function setLoading(visible: boolean): void {
  loading.hidden = !visible;
}

function dismissSplash(): void {
  if (!splash || splashDismissed) return;
  splashDismissed = true;
  if (splashMinTimer !== undefined) {
    window.clearTimeout(splashMinTimer);
    splashMinTimer = undefined;
  }

  const element = splash;
  element.classList.add("splash--hidden");
  const remove = (): void => element.remove();
  element.addEventListener("transitionend", remove, { once: true });
  window.setTimeout(remove, SPLASH_FADE_MS + 150);
}

function markFirstMapFrameReady(): void {
  if (firstMapFrameReady) return;
  firstMapFrameReady = true;

  const remaining = Math.max(
    0,
    SPLASH_MIN_MS - (performance.now() - splashStart),
  );
  if (remaining > 0) {
    splashMinTimer = window.setTimeout(dismissSplash, remaining);
  } else {
    dismissSplash();
  }
}

// Never let a slow or failed map hold the opening indefinitely.
window.setTimeout(dismissSplash, SPLASH_MAX_MS);

function hideDataState(): void {
  dataState.hidden = true;
}

function setControlsEnabled(enabled: boolean): void {
  orientationSouth.disabled = !enabled;
  orientationNorth.disabled = !enabled;
  shareButton.disabled = !enabled;
  search.setEnabled(enabled);
}

function updateOrientationUI(): void {
  const south = orientation === "south";
  mapContainer.dataset.orientation = orientation;
  orientationSouth.setAttribute("aria-pressed", String(south));
  orientationNorth.setAttribute("aria-pressed", String(!south));
  mapContainer.setAttribute(
    "aria-label",
    south
      ? "World map with south at the top and north at the bottom"
      : "World map with north at the top and south at the bottom",
  );
}

function applyOverlayVisibility(): void {
  if (!map) return;
  for (const layerId of OVERLAY_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(
      layerId,
      "visibility",
      overlayToggles[layerId].checked ? "visible" : "none",
    );
  }
}

function showDataState(
  title: string,
  message: string,
  url: string,
  command?: string,
): void {
  stateTitle.textContent = title;
  stateMessage.textContent = message;
  stateUrl.textContent = url;
  if (command) {
    stateCommand.textContent = command;
    stateCommand.hidden = false;
  } else {
    stateCommand.hidden = true;
  }
  dataState.hidden = false;
  retryButton.focus({ preventScroll: true });
}

function showFailure(error: unknown, url: string): void {
  dismissSplash();
  readoutEnabled = false;
  mapReadout.hidden = true;
  setControlsEnabled(false);

  if (error instanceof ArchiveProblem) {
    if (error.code === "not-south-up") {
      showDataState(
        "Archive geometry is not south-up",
        "The viewer refuses to label a north-up archive as south-up. Rebuild it with the Natural Earth builder (or the optional latitude-flip transform), or test another archive with ?pmtiles=<url>.",
        url,
        "python3 map-build/natural-earth/build_natural_earth.py --force",
      );
      return;
    }
    if (error.code === "not-vector") {
      showDataState(
        "This is not a vector tileset",
        "The viewer needs a PMTiles archive containing Mapbox Vector Tiles (MVT), such as the Natural Earth archive produced by map-build/natural-earth/.",
        url,
      );
      return;
    }
    showDataState(
      "Map data not built yet",
      "This static site expects a world.pmtiles archive next to the application. It was not found or its header could not be read.",
      url,
      "python3 map-build/natural-earth/build_natural_earth.py --force",
    );
    return;
  }

  const detail = error instanceof Error ? error.message : String(error);
  showDataState(
    "The map could not start",
    `${detail} Check that the archive and style are deployed and that WebGL is available.`,
    url,
  );
}

function exposeDebugMap(mapInstance: MapLibreMap): void {
  // Opt-in test hook for the browser smoke test; normal visitors never get a
  // global MapLibre handle.
  if (!new URLSearchParams(window.location.search).has("debug-map")) return;
  (window as Window & { __southUpMap?: MapLibreMap }).__southUpMap = mapInstance;
}

function syncUrl(): void {
  if (!map) return;
  const center = map.getCenter();
  const view = viewFromMap(
    center.lng,
    center.lat,
    map.getZoom(),
    orientation,
  );
  history.replaceState(
    history.state,
    "",
    updateUrl(window.location.href, view, orientation),
  );
}

function updateMapReadout(): void {
  if (!map) {
    mapReadout.hidden = true;
    return;
  }

  const center = map.getCenter();
  let latitude: number;
  try {
    latitude =
      orientation === "north"
        ? center.lat
        : displayToGeo(center.lng, center.lat)[1];
  } catch {
    mapReadout.hidden = true;
    return;
  }

  const coordinates = formatCoordinates(
    wrapLongitude(center.lng),
    latitude,
  );
  if (!coordinates) {
    mapReadout.hidden = true;
    return;
  }

  const scale = scaleBarForView(latitude, map.getZoom());
  mapCoordinates.textContent = coordinates;
  mapScaleLabel.textContent = scale.label;
  mapScaleBar.style.width = `${scale.pixels.toFixed(1)}px`;
  mapReadout.setAttribute(
    "aria-label",
    `Map center ${coordinates}, scale ${scale.label}`,
  );
  if (readoutEnabled && featureCard.hidden) mapReadout.hidden = false;
}

function scheduleMapReadout(): void {
  if (!readoutEnabled || readoutFrame !== undefined) return;
  readoutFrame = window.requestAnimationFrame(() => {
    readoutFrame = undefined;
    updateMapReadout();
  });
}

function showShareStatus(message: string): void {
  if (shareStatusTimer !== undefined) window.clearTimeout(shareStatusTimer);
  shareStatus.textContent = message;
  shareStatus.hidden = false;
  shareStatusTimer = window.setTimeout(() => {
    shareStatus.hidden = true;
    shareStatus.textContent = "";
    shareStatusTimer = undefined;
  }, 2400);
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy clipboard path when permission is denied.
    }
  }

  const active = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "-9999px";
  document.body.append(area);
  area.focus({ preventScroll: true });
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  return copied;
}

function currentShareCaption(): string | null {
  if (!map) return null;
  const center = map.project(map.getCenter());
  const radius = 120;
  const features = map.queryRenderedFeatures(
    [
      [center.x - radius, center.y - radius],
      [center.x + radius, center.y + radius],
    ],
    { layers: SHARE_CAPTION_LAYER_IDS },
  );
  return shareCaptionForFeatures(
    features.map((feature) => ({
      layerId: feature.layer?.id ?? "",
      properties: feature.properties ?? {},
    })),
  );
}

async function shareCurrentView(): Promise<void> {
  if (!map) return;
  // Keep the address bar in step before handing the URL to the share sheet or
  // clipboard, so both always describe the view the visitor is looking at.
  syncUrl();
  const url = window.location.href;
  const text = shareTextForCaption(currentShareCaption(), orientation);

  if (typeof navigator.share === "function") {
    try {
      await navigator.share({
        title: "Reversed Earth",
        text,
        url,
      });
      showShareStatus("Link shared");
      return;
    } catch (error) {
      // A dismissed share sheet is not an error worth reporting.
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }

  showShareStatus(
    (await copyText(url)) ? "Link copied" : "Could not copy the link",
  );
}

function hideFeatureCard(restoreFocus = false): void {
  if (featureCard.hidden) return;
  featureCard.hidden = true;
  if (readoutEnabled) {
    mapReadout.hidden = false;
    updateMapReadout();
  }
  if (restoreFocus) map?.getCanvas().focus({ preventScroll: true });
}

function showFeatureCard(card: FeatureCardModel): void {
  featureCardEyebrow.textContent = card.eyebrow;
  featureCardTitle.textContent = card.title;
  featureCardSubtitle.textContent = card.subtitle;
  featureCardFacts.replaceChildren();
  for (const fact of card.facts) {
    const term = document.createElement("dt");
    term.textContent = fact.label;
    const value = document.createElement("dd");
    value.textContent = fact.value;
    featureCardFacts.append(term, value);
  }
  featureCard.hidden = false;
  mapReadout.hidden = true;
  featureCardClose.focus({ preventScroll: true });
}

function inspectMapFeature(event: MapMouseEvent): void {
  if (!map) return;

  const point = map.project(event.lngLat);
  const query = { layers: INSPECT_LAYER_IDS };
  let features = map.queryRenderedFeatures(point, query);
  if (features.length === 0) {
    // Dots and labels are small; give the click a little forgiveness.
    features = map.queryRenderedFeatures(
      [
        [point.x - 6, point.y - 6],
        [point.x + 6, point.y + 6],
      ],
      query,
    );
  }

  const feature = features[0];
  const layerId = feature?.layer?.id;
  if (!feature || !layerId) {
    hideFeatureCard(true);
    return;
  }

  const longitude = wrapLongitude(event.lngLat.lng);
  const latitude = event.lngLat.lat;
  let coordinate: { longitude: number; latitude: number };
  try {
    if (orientation === "north") {
      coordinate = { longitude, latitude };
    } else {
      const [realLongitude, realLatitude] = displayToGeo(longitude, latitude);
      coordinate = { longitude: realLongitude, latitude: realLatitude };
    }
  } catch {
    hideFeatureCard(true);
    return;
  }

  const card = buildFeatureCard(
    layerId,
    feature.properties ?? {},
    coordinate,
  );
  if (card) {
    showFeatureCard(card);
  } else {
    hideFeatureCard(true);
  }
}

function chooseOrientation(next: Orientation): void {
  if (!map || !archive || !baseStyle || next === orientation) return;
  hideFeatureCard();
  setMapOrientation(map, archive, baseStyle, orientation, next);
  orientation = next;
  updateOrientationUI();
  syncUrl();
  updateMapReadout();
}

function flyToResult(result: SearchResult): void {
  if (!map) return;
  hideFeatureCard();
  const center: [number, number] =
    orientation === "north"
      ? [result.longitude, result.latitude]
      : geoToDisplay(result.longitude, result.latitude);
  map.flyTo({
    center,
    zoom: result.kind === "coordinate" ? 10 : 9,
    essential: true,
  });
}

async function boot(): Promise<void> {
  hideDataState();
  hideFeatureCard();
  readoutEnabled = false;
  mapReadout.hidden = true;
  delete mapContainer.dataset.ready;
  setLoading(true);
  setControlsEnabled(false);
  const url = resolvePmtilesUrl();

  try {
    const opened = await openArchive(url);
    const style = await loadStyle(opened);

    if (map) {
      map.remove();
      map = undefined;
    }

    archive = opened;
    baseStyle = style;
    map = createMap(mapContainer, opened, style, orientation);
    exposeDebugMap(map);
    map.on("style.load", applyOverlayVisibility);
    applyOverlayVisibility();
    if (initialState.view) {
      map.jumpTo({
        center: viewCenter(initialState.view, orientation),
        zoom: initialState.view.zoom,
      });
    }
    map.on("moveend", syncUrl);
    map.on("move", scheduleMapReadout);
    map.on("click", inspectMapFeature);
    updateOrientationUI();
    syncUrl();
    setControlsEnabled(true);

    let settled = false;
    const finishLoading = (): void => {
      if (settled) return;
      settled = true;
      setLoading(false);
    };
    const markReady = (): void => {
      mapContainer.dataset.ready = "true";
      readoutEnabled = true;
      mapReadout.hidden = false;
      updateMapReadout();
      finishLoading();
      markFirstMapFrameReady();
    };
    // `load` is not guaranteed to fire after this listener is attached when the
    // style is an in-memory object and the first frame is already rendered, so
    // also watch `idle` and poll the documented loaded() state.
    map.once("load", markReady);
    map.once("idle", markReady);
    const readyPoll = window.setInterval(() => {
      if (map?.loaded()) {
        window.clearInterval(readyPoll);
        markReady();
      }
    }, 250);
    // The style and first tiles are local; this prevents a spinner from sticking
    // forever if a glyph range or a single tile is slow.
    window.setTimeout(() => {
      window.clearInterval(readyPoll);
      finishLoading();
    }, 6000);

    map.on("error", (event) => {
      console.error("MapLibre error", event.error);
    });

    const size = formatBytes(opened.header.tileDataLength ?? 0);
    console.info(
      `South-up archive ready: zooms ${opened.header.minZoom}-${opened.header.maxZoom}, ` +
        `native tile data ${size}, ${url}`,
    );
  } catch (error) {
    console.error(error);
    setLoading(false);
    archive = undefined;
    baseStyle = undefined;
    showFailure(error, url);
  }
}

retryButton.addEventListener("click", () => {
  void boot();
});

orientationSouth.addEventListener("click", () => {
  chooseOrientation("south");
});
orientationNorth.addEventListener("click", () => {
  chooseOrientation("north");
});

zoomInButton.addEventListener("click", () => {
  map?.zoomIn({ duration: 250 });
});
zoomOutButton.addEventListener("click", () => {
  map?.zoomOut({ duration: 250 });
});

shareButton.addEventListener("click", () => {
  void shareCurrentView();
});

function setInfoOpen(open: boolean, restoreFocus = false): void {
  if (open) {
    hideFeatureCard();
    if (!legendPanel.hidden) setLegendOpen(false);
  }
  infoPanel.hidden = !open;
  infoButton.setAttribute("aria-expanded", String(open));
  if (open) {
    infoClose.focus({ preventScroll: true });
  } else if (restoreFocus) {
    infoButton.focus({ preventScroll: true });
  }
}

function setLegendOpen(open: boolean, restoreFocus = false): void {
  if (open) {
    hideFeatureCard();
    if (!infoPanel.hidden) setInfoOpen(false);
  }
  legendPanel.hidden = !open;
  legendButton.setAttribute("aria-expanded", String(open));
  if (open) {
    legendClose.focus({ preventScroll: true });
  } else if (restoreFocus) {
    legendButton.focus({ preventScroll: true });
  }
}

for (const layerId of OVERLAY_LAYER_IDS) {
  overlayToggles[layerId].addEventListener("change", applyOverlayVisibility);
}

infoButton.addEventListener("click", () => {
  setInfoOpen(infoPanel.hidden === true);
});
infoClose.addEventListener("click", () => {
  setInfoOpen(false, true);
});
legendButton.addEventListener("click", () => {
  setLegendOpen(legendPanel.hidden === true);
});
legendClose.addEventListener("click", () => {
  setLegendOpen(false, true);
});
featureCardClose.addEventListener("click", () => {
  hideFeatureCard(true);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!featureCard.hidden) {
    hideFeatureCard(true);
  } else if (!legendPanel.hidden) {
    setLegendOpen(false, true);
  } else if (!infoPanel.hidden) {
    setInfoOpen(false, true);
  }
});
document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (
    !legendPanel.hidden &&
    !legendPanel.contains(target) &&
    !legendButton.contains(target)
  ) {
    setLegendOpen(false);
  }
  if (
    !infoPanel.hidden &&
    !infoPanel.contains(target) &&
    !infoButton.contains(target)
  ) {
    setInfoOpen(false);
  }
});

void boot();
