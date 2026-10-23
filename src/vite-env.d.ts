/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute or relative PMTiles URL. Overridden by ?pmtiles=... at runtime. */
  readonly VITE_PMTILES_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
