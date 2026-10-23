import { PMTiles, TileType, type Header } from "pmtiles";

/**
 * Metadata written by map-build/transformations/flip_world.py.
 * `south_up` is a contract: tiles must already contain lat -> -lat geometry.
 */
export interface ArchiveMetadata {
  south_up?: boolean;
  attribution?: string;
  name?: string;
  description?: string;
  vector_layers?: unknown;
  [key: string]: unknown;
}

export type ArchiveProblemCode =
  | "missing"
  | "unreadable"
  | "not-vector"
  | "not-south-up";

export class ArchiveProblem extends Error {
  readonly code: ArchiveProblemCode;

  constructor(code: ArchiveProblemCode, message: string) {
    super(message);
    this.name = "ArchiveProblem";
    this.code = code;
  }
}

export interface MapArchive {
  url: string;
  pmtiles: PMTiles;
  header: Header;
  metadata: ArchiveMetadata;
}

/**
 * Read just the PMTiles header and metadata before creating the map. This gives
 * a clear failure state for a site deployed without its archive, and lets the
 * source use the archive's real native maxzoom (overzoom is handled by MapLibre).
 */
export async function openArchive(url: string): Promise<MapArchive> {
  const pmtiles = new PMTiles(url);

  let header: Header;
  try {
    header = await pmtiles.getHeader();
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new ArchiveProblem(
      "missing",
      `Could not read a PMTiles archive at ${url}.${detail}`,
    );
  }

  if (header.tileType !== TileType.Mvt) {
    throw new ArchiveProblem(
      "not-vector",
      `The archive at ${url} does not contain vector tiles (tile type ${header.tileType}).`,
    );
  }

  let metadata: ArchiveMetadata;
  try {
    const raw = await pmtiles.getMetadata();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("metadata is not a JSON object");
    }
    metadata = raw as ArchiveMetadata;
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new ArchiveProblem(
      "unreadable",
      `Could not read metadata from ${url}.${detail}`,
    );
  }

  if (metadata.south_up !== true) {
    throw new ArchiveProblem(
      "not-south-up",
      `The archive at ${url} is not marked as south-up. Rebuild it with the latitude ` +
        `transform in map-build/, or add {"south_up": true} to its PMTiles metadata ` +
        `only if the geometry really is inverted.`,
    );
  }

  return { url, pmtiles, header, metadata };
}
