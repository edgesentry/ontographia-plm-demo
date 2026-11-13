// Lazy boundary for @relate/relate-wasm on the FarmBot screen.
//
// This module is only ever reached through `import('./relate-loader')`, after
// first paint and after the seed digest has been verified. It statically
// imports the package and the same-origin `?url` asset, so both land in a chunk
// that the entry HTML does not reference. Nothing here runs before the first
// user Run.

import initRelate, { RelateDb } from '@relate/relate-wasm';
import { isWasmTrap } from '@relate/relate-wasm/trap.js';
import relateWasmUrl from '@relate/relate-wasm/relate_bg.wasm?url';
import type { RelateEnvelope } from './types';

let initPromise: Promise<void> | null = null;

/**
 * Initialise the WASM module with the same-origin asset URL emitted by Vite.
 * The URL is passed explicitly so no call can fall back to a bare `init()` that
 * would fetch `relate_bg.wasm` from a non-same-origin path.
 */
export async function initRelateWasm(): Promise<void> {
  if (!initPromise) {
    initPromise = initRelate({ module_or_path: relateWasmUrl }).then(() => undefined);
  }
  return initPromise;
}

/** A writable `:memory:` database. No OPFS, no persisted store. */
export function openRelateDb(): RelateDb {
  return new RelateDb();
}

/** Run one statement and parse its wire envelope. */
export function executeWire(
  db: RelateDb,
  query: string,
  params: Record<string, unknown> | null,
): RelateEnvelope {
  return JSON.parse(
    db.execute(query, params === null ? null : JSON.stringify(params)),
  ) as RelateEnvelope;
}

/** True when the error means the WASM instance trapped and must not be reused. */
export function isRelateWasmTrap(error: unknown): boolean {
  return isWasmTrap(error);
}

/** Same-origin URL of the Relate WASM asset, for diagnostics. */
export const RELATE_WASM_URL = relateWasmUrl;
