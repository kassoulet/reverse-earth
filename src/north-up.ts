import { VectorTile } from "@mapbox/vector-tile";
import { addProtocol, type RequestParameters } from "maplibre-gl";
import { PbfReader, PbfWriter } from "pbf";
import type { Protocol } from "pmtiles";

/**
 * North-up comparison mode.
 *
 * The deployed archive only contains south-up geometry, so a north-up view is
 * derived by reading the complementary tile row of the pyramid and inverting
 * the feature geometry back inside that tile. This is a data-level transform,
 * not a camera rotation or a CSS mirror: labels stay upright and MapLibre's
 * interaction model is untouched.
 */

export const NORTH_UP_SCHEME = "south-up-north";

const PROTOCOL_PREFIX = `${NORTH_UP_SCHEME}://`;

interface EncodedFeature {
  id: number | undefined;
  type: number;
  tags: number[];
  geometry: number[];
}

interface EncodedLayer {
  name: string;
  version: number;
  extent: number;
  keys: string[];
  values: (string | number | boolean)[];
  features: EncodedFeature[];
}

type MvtValue = string | number | boolean;

/**
 * Invert a south-up MVT tile in place (conceptually) so it can be drawn as
 * north-up: every Y coordinate becomes extent - Y and polygon rings are
 * reversed to keep the winding required by the vector tile spec.
 */
export function invertTileGeometry(data: Uint8Array): Uint8Array {
  const tile = new VectorTile(new PbfReader(data));
  const layers: EncodedLayer[] = [];

  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name];
    if (!layer) continue;

    const keys: string[] = [];
    const values: MvtValue[] = [];
    const keyIndex = new Map<string, number>();
    const valueIndex = new Map<string, number>();
    const features: EncodedFeature[] = [];

    for (let i = 0; i < layer.length; i += 1) {
      const feature = layer.feature(i);
      const tags: number[] = [];

      for (const [key, value] of Object.entries(feature.properties)) {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          continue;
        }
        let keyId = keyIndex.get(key);
        if (keyId === undefined) {
          keyId = keys.length;
          keys.push(key);
          keyIndex.set(key, keyId);
        }
        const valueKey = `${typeof value}:${String(value)}`;
        let valueId = valueIndex.get(valueKey);
        if (valueId === undefined) {
          valueId = values.length;
          values.push(value);
          valueIndex.set(valueKey, valueId);
        }
        tags.push(keyId, valueId);
      }

      features.push({
        id: feature.id,
        type: feature.type,
        tags,
        geometry: invertGeometry(feature.loadGeometry(), feature.type, layer.extent),
      });
    }

    layers.push({
      name,
      version: layer.version,
      extent: layer.extent,
      keys,
      values,
      features,
    });
  }

  const writer = new PbfWriter();
  for (const layer of layers) {
    writer.writeMessage(3, writeLayer, layer);
  }
  return writer.finish();
}

function invertGeometry(
  rings: Array<Array<{ x: number; y: number }>>,
  type: number,
  extent: number,
): number[] {
  const geometry: number[] = [];
  let cursorX = 0;
  let cursorY = 0;

  for (const originalRing of rings) {
    if (originalRing.length === 0) continue;

    let ring = originalRing;
    if (type === 3) {
      // loadGeometry() appends the first point again on closePath. Drop that
      // duplicate so the ring is stored once and closed by the command stream.
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (ring.length > 1 && first && last && first.x === last.x && first.y === last.y) {
        ring = ring.slice(0, -1);
      }
      if (ring.length < 3) continue;
      // Inverting Y reverses signed area; reversing the ring restores the
      // exterior-clockwise / interior-counter-clockwise convention.
      ring = [...ring].reverse();
    }

    const points = ring.map((point) => ({ x: point.x, y: extent - point.y }));
    const first = points[0];
    if (!first) continue;

    if (type === 1) {
      // loadGeometry() gives one ring per point. Emitting one MoveTo per point
      // is valid and keeps this branch simple.
      for (const point of points) {
        geometry.push(command(1, 1), zigzag(point.x - cursorX), zigzag(point.y - cursorY));
        cursorX = point.x;
        cursorY = point.y;
      }
      continue;
    }

    geometry.push(command(1, 1), zigzag(first.x - cursorX), zigzag(first.y - cursorY));
    cursorX = first.x;
    cursorY = first.y;

    if (points.length > 1) {
      geometry.push(command(2, points.length - 1));
      for (let i = 1; i < points.length; i += 1) {
        const point = points[i];
        if (!point) continue;
        geometry.push(zigzag(point.x - cursorX), zigzag(point.y - cursorY));
        cursorX = point.x;
        cursorY = point.y;
      }
    }

    if (type === 3) {
      geometry.push(command(7, 1));
    }
  }

  return geometry;
}

function command(id: number, count: number): number {
  return (count << 3) | id;
}

function zigzag(value: number): number {
  return (value << 1) ^ (value >> 31);
}

function writeLayer(layer: EncodedLayer, writer: PbfWriter): void {
  writer.writeVarintField(15, layer.version || 2);
  writer.writeStringField(1, layer.name);
  for (const key of layer.keys) writer.writeStringField(3, key);
  for (const value of layer.values) writer.writeMessage(4, writeValue, value);
  writer.writeVarintField(5, layer.extent);
  for (const feature of layer.features) writer.writeMessage(2, writeFeature, feature);
}

function writeFeature(feature: EncodedFeature, writer: PbfWriter): void {
  if (feature.id !== undefined && Number.isSafeInteger(feature.id) && feature.id >= 0) {
    writer.writeVarintField(1, feature.id);
  }
  if (feature.tags.length > 0) writer.writePackedVarint(2, feature.tags);
  writer.writeVarintField(3, feature.type);
  if (feature.geometry.length > 0) writer.writePackedVarint(4, feature.geometry);
}

function writeValue(value: MvtValue, writer: PbfWriter): void {
  if (typeof value === "string") {
    writer.writeStringField(1, value);
  } else if (typeof value === "boolean") {
    writer.writeBooleanField(7, value);
  } else if (Number.isSafeInteger(value)) {
    if (value >= 0) writer.writeVarintField(5, value);
    else writer.writeSVarintField(6, value);
  } else {
    writer.writeDoubleField(3, value);
  }
}

/**
 * Register the protocol used by the north-up style source. The source URL is
 * `<scheme>://<archive URL>/{z}/{x}/{y}` and maps each requested display tile
 * to the complementary south-up tile in the archive.
 */
export function registerNorthUpProtocol(protocol: Protocol): void {
  addProtocol(
    NORTH_UP_SCHEME,
    async (
      params: RequestParameters,
      abortController: AbortController,
    ): Promise<{ data: Uint8Array; cacheControl?: string; expires?: string }> => {
      const match = /^(.*)\/(\d+)\/(\d+)\/(\d+)$/.exec(
        params.url.slice(PROTOCOL_PREFIX.length),
      );
      if (!match) throw new Error("Invalid north-up tile URL");

      const archiveUrl = match[1];
      const z = Number(match[2]);
      const x = Number(match[3]);
      const y = Number(match[4]);
      if (!archiveUrl) throw new Error("Invalid north-up tile URL");

      const archive = protocol.get(archiveUrl);
      if (!archive) {
        throw new Error(`No PMTiles archive registered for ${archiveUrl}`);
      }

      const rows = 2 ** z;
      const southUpRow = rows - 1 - y;
      const tile = await archive.getZxy(z, x, southUpRow, abortController.signal);
      abortController.signal.throwIfAborted();

      if (!tile) return { data: new Uint8Array() };

      return {
        data: invertTileGeometry(new Uint8Array(tile.data)),
        cacheControl: tile.cacheControl,
        expires: tile.expires,
      };
    },
  );
}
