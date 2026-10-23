import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/app.css";
import { Map as MapLibreMap } from "maplibre-gl";
import { ArchiveProblem, openArchive } from "./archive";
import { formatBytes, resolvePmtilesUrl } from "./config";
import { createMap, loadStyle } from "./map";

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

let map: MapLibreMap | undefined;

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
  if (error instanceof ArchiveProblem) {
    if (error.code === "not-south-up") {
      showDataState(
        "Archive geometry is not south-up",
        "The viewer refuses to label a north-up archive as south-up. Rebuild it through the latitude-flip step, or test another archive with ?pmtiles=<url>.",
        url,
        "python3 map-build/transformations/flip_world.py --input world.mbtiles --output world.pmtiles",
      );
      return;
    }
    if (error.code === "not-vector") {
      showDataState(
        "This is not a vector tileset",
        "The viewer needs a PMTiles archive containing Mapbox Vector Tiles (MVT), such as the archive produced by the Planetiler pipeline.",
        url,
      );
      return;
    }
    showDataState(
      "Map data not built yet",
      "This static site expects a world.pmtiles archive next to the application. It was not found or its header could not be read.",
      url,
      "npm run map:build -- --pbf /path/to/planet-latest.osm.pbf",
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

async function boot(): Promise<void> {
  hideDataState();
  delete mapContainer.dataset.ready;
  setLoading(true);
  const url = resolvePmtilesUrl();

  try {
    const archive = await openArchive(url);
    const style = await loadStyle(archive);

    if (map) {
      map.remove();
      map = undefined;
    }

    map = createMap(mapContainer, archive, style);

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

    const size = formatBytes(archive.header.tileDataLength ?? 0);
    console.info(
      `South-up archive ready: zooms ${archive.header.minZoom}-${archive.header.maxZoom}, ` +
        `native tile data ${size}, ${url}`,
    );
  } catch (error) {
    console.error(error);
    setLoading(false);
    showFailure(error, url);
  }
}

retryButton.addEventListener("click", () => {
  void boot();
});

zoomInButton.addEventListener("click", () => {
  map?.zoomIn({ duration: 250 });
});
zoomOutButton.addEventListener("click", () => {
  map?.zoomOut({ duration: 250 });
});

void boot();
