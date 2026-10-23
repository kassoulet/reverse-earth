import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/app.css";
import { Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import { ArchiveProblem, openArchive, type MapArchive } from "./archive";
import { formatBytes, resolvePmtilesUrl } from "./config";
import { geoToDisplay } from "./coordinates";
import {
  createMap,
  loadStyle,
  setMapOrientation,
  type Orientation,
} from "./map";
import type { SearchResult } from "./search";
import { SearchControl } from "./search-control";
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

function hideDataState(): void {
  dataState.hidden = true;
}

function setControlsEnabled(enabled: boolean): void {
  orientationSouth.disabled = !enabled;
  orientationNorth.disabled = !enabled;
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

function chooseOrientation(next: Orientation): void {
  if (!map || !archive || !baseStyle || next === orientation) return;
  setMapOrientation(map, archive, baseStyle, orientation, next);
  orientation = next;
  updateOrientationUI();
  syncUrl();
}

function flyToResult(result: SearchResult): void {
  if (!map) return;
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
    if (initialState.view) {
      map.jumpTo({
        center: viewCenter(initialState.view, orientation),
        zoom: initialState.view.zoom,
      });
    }
    map.on("moveend", syncUrl);
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
      finishLoading();
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

function setInfoOpen(open: boolean, restoreFocus = false): void {
  infoPanel.hidden = !open;
  infoButton.setAttribute("aria-expanded", String(open));
  if (open) {
    infoClose.focus({ preventScroll: true });
  } else if (restoreFocus) {
    infoButton.focus({ preventScroll: true });
  }
}

infoButton.addEventListener("click", () => {
  setInfoOpen(infoPanel.hidden === true);
});
infoClose.addEventListener("click", () => {
  setInfoOpen(false, true);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !infoPanel.hidden) {
    setInfoOpen(false, true);
  }
});
document.addEventListener("pointerdown", (event) => {
  if (
    !infoPanel.hidden &&
    event.target instanceof Node &&
    !infoPanel.contains(event.target) &&
    !infoButton.contains(event.target)
  ) {
    setInfoOpen(false);
  }
});

void boot();
