// Fetch the committed FarmBot seed and verify its digest before use.
//
// The seed is served as a static same-origin file copied from
// farmbot/dist/farmbot.seed.json by scripts/vite-plugin-farmbot-seed.mjs. It is
// never imported through the bundler: Vite may rewrite imported JSON bytes and
// the digest would stop matching. JSON parsing happens only after the SHA-256
// check passes.

import { checkSeedDigest, formatSeedDigest } from './seed-digest.mjs';
import type { Seed } from './types';

/** File name served next to the FarmBot entry, at `/farmbot/farmbot.seed.json`. */
export const SEED_FILE_NAME = 'farmbot.seed.json';

export class SeedFetchError extends Error {
  constructor(readonly status: string) {
    super(`seed fetch failed: ${status}`);
    this.name = 'SeedFetchError';
  }
}

export class SeedRejectedError extends Error {
  constructor(readonly actualHex: string) {
    super(`seed digest mismatch: ${actualHex}`);
    this.name = 'SeedRejectedError';
  }
}

export interface VerifiedSeed {
  seed: Seed;
  digest: string;
  byteLength: number;
}

/** Absolute, same-origin seed URL for the current page (`/farmbot/`). */
export function seedUrl(): URL {
  return new URL(SEED_FILE_NAME, document.baseURI);
}

/**
 * Fetch the seed bytes, verify the digest with Web Crypto, and only then parse.
 * A mismatch throws before any JSON is decoded and before Relate is loaded.
 */
export async function fetchVerifiedSeed(): Promise<VerifiedSeed> {
  let response: Response;
  try {
    response = await fetch(seedUrl(), { cache: 'no-store' });
  } catch (error) {
    throw new SeedFetchError(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw new SeedFetchError(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const { ok, hex } = await checkSeedDigest(bytes);
  if (!ok) throw new SeedRejectedError(hex);
  return {
    seed: JSON.parse(new TextDecoder().decode(bytes)) as Seed,
    digest: formatSeedDigest(hex),
    byteLength: bytes.length,
  };
}
