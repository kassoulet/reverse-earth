import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader, PbfWriter } from "pbf";
import { describe, expect, it } from "vitest";
import { invertTileGeometry } from "./north-up";

const EXTENT = 4096;

type Point = { x: number; y: number };

interface FixtureFeature {
  type: 1 | 2 | 3;
  rings: Point[][];
  properties?: Record<string, string | number | boolean>;
}

interface FixtureLayer {
  name: string;
  features: FixtureFeature[];
}

/**
 * Minimal MVT encoder used only to build fixtures. The production decoder in
 * north-up.ts is exercised against @mapbox/vector-tile, the same parser
 * MapLibre uses.
 */
function makeTile(layers: FixtureLayer[], extent = EXTENT): Uint8Array {
  const writer = new PbfWriter();
  for (const layer of layers) {
    const keys: string[] = [];
    const values: Array<string | number | boolean> = [];
    const keyIds = new Map<string, number>();
    const valueIds = new Map<string, number>();
    const features = layer.features.map((feature) => {
      const tags: number[] = [];
      for (const [key, value] of Object.entries(feature.properties ?? {})) {
        let keyId = keyIds.get(key);
        if (keyId === undefined) {
          keyId = keys.length;
          keys.push(key);
          keyIds.set(key, keyId);
        }
        const valueKey = `${typeof value}:${String(value)}`;
        let valueId = valueIds.get(valueKey);
        if (valueId === undefined) {
          valueId = values.length;
          values.push(value);
          valueIds.set(valueKey, valueId);
        }
        tags.push(keyId, valueId);
      }
      return { ...feature, tags };
    });

    writer.writeMessage(3, (_, pbf) => {
      pbf.writeVarintField(15, 2);
      pbf.writeStringField(1, layer.name);
      for (const feature of features) {
        pbf.writeMessage(2, (_, featureWriter) => {
          featureWriter.writePackedVarint(2, feature.tags);
          featureWriter.writeVarintField(3, feature.type);
          featureWriter.writePackedVarint(4, encodeGeometry(feature.rings, feature.type));
        }, null);
      }
      for (const key of keys) pbf.writeStringField(3, key);
      for (const value of values) {
        pbf.writeMessage(4, (_, valueWriter) => {
          if (typeof value === "string") valueWriter.writeStringField(1, value);
          else if (typeof value === "boolean") valueWriter.writeBooleanField(7, value);
          else if (Number.isSafeInteger(value)) valueWriter.writeVarintField(5, value);
          else valueWriter.writeDoubleField(3, value);
        }, null);
      }
      pbf.writeVarintField(5, extent);
    }, null);
  }
  return writer.finish();
}

function encodeGeometry(rings: Point[][], type: number): number[] {
  const out: number[] = [];
  let cursorX = 0;
  let cursorY = 0;
  for (const ring of rings) {
    const first = ring[0];
    if (!first) continue;
    out.push(command(1, 1), zigzag(first.x - cursorX), zigzag(first.y - cursorY));
    cursorX = first.x;
    cursorY = first.y;
    if (ring.length > 1) {
      out.push(command(2, ring.length - 1));
      for (let i = 1; i < ring.length; i += 1) {
        const point = ring[i]!;
        out.push(zigzag(point.x - cursorX), zigzag(point.y - cursorY));
        cursorX = point.x;
        cursorY = point.y;
      }
    }
    if (type === 3) out.push(command(7, 1));
  }
  return out;
}

function command(id: number, count: number): number {
  return (count << 3) | id;
}

function zigzag(value: number): number {
  return (value << 1) ^ (value >> 31);
}

function decode(data: Uint8Array): VectorTile {
  return new VectorTile(new PbfReader(data));
}

const SOURCE = makeTile([
  {
    name: "water",
    features: [
      {
        type: 3,
        rings: [
          [
            { x: 100, y: 100 },
            { x: 300, y: 100 },
            { x: 300, y: 300 },
            { x: 100, y: 300 },
          ],
        ],
        properties: { class: "ocean", rank: 1 },
      },
    ],
  },
  {
    name: "roads",
    features: [
      {
        type: 2,
        rings: [
          [
            { x: 0, y: 0 },
            { x: 100, y: 50 },
            { x: 200, y: 0 },
          ],
        ],
        properties: { name: "Main Street", oneway: true },
      },
    ],
  },
  {
    name: "places",
    features: [
      {
        type: 1,
        rings: [[{ x: 4000, y: 2000 }]],
        properties: { name: "Example", population: 1234567, elevation: 12.5 },
      },
    ],
  },
]);

describe("invertTileGeometry", () => {
  it("flips Y coordinates inside the tile", () => {
    const tile = decode(invertTileGeometry(SOURCE));
    const point = tile.layers.places!.feature(0).loadGeometry()[0]![0]!;
    expect(point).toEqual({ x: 4000, y: 4096 - 2000 });

    const line = tile.layers.roads!.feature(0).loadGeometry()[0]!;
    expect(line.map((p) => [p.x, p.y])).toEqual([
      [0, 4096],
      [100, 4046],
      [200, 4096],
    ]);
  });

  it("reverses polygon rings so winding stays valid after the flip", () => {
    const tile = decode(invertTileGeometry(SOURCE));
    const ring = tile.layers.water!.feature(0).loadGeometry()[0]!;
    expect(ring.map((p) => [p.x, p.y])).toEqual([
      [100, 4096 - 300],
      [300, 4096 - 300],
      [300, 4096 - 100],
      [100, 4096 - 100],
      [100, 4096 - 300],
    ]);
  });

  it("keeps layer names, extents, properties and property types", () => {
    const tile = decode(invertTileGeometry(SOURCE));
    expect(Object.keys(tile.layers).sort()).toEqual(["places", "roads", "water"]);
    expect(tile.layers.places!.extent).toBe(EXTENT);

    const place = tile.layers.places!.feature(0);
    expect(place.properties).toEqual({
      name: "Example",
      population: 1234567,
      elevation: 12.5,
    });

    const road = tile.layers.roads!.feature(0);
    expect(road.properties).toEqual({ name: "Main Street", oneway: true });
  });

  it("round-trips, because the inversion is its own inverse", () => {
    const sourceTile = decode(SOURCE);
    const restored = decode(invertTileGeometry(invertTileGeometry(SOURCE)));

    const sourceRing = sourceTile.layers.water!.feature(0).loadGeometry()[0]!;
    const restoredRing = restored.layers.water!.feature(0).loadGeometry()[0]!;
    expect(restoredRing.map((p) => [p.x, p.y])).toEqual(
      sourceRing.map((p) => [p.x, p.y]),
    );

    const sourceLine = sourceTile.layers.roads!.feature(0).loadGeometry()[0]!;
    const restoredLine = restored.layers.roads!.feature(0).loadGeometry()[0]!;
    expect(restoredLine.map((p) => [p.x, p.y])).toEqual(
      sourceLine.map((p) => [p.x, p.y]),
    );
  });
});
