// Open the FarmBot Relate session: fetch and verify the seed, then lazy-load
// Relate and load the seed into an in-memory database.
//
// Order matters. The seed is fetched and digest-checked first; only then is the
// Relate chunk imported, so a rejected seed never touches the engine.

import { farmbotOntology } from './data';
import { parseRelationshipEndpoints } from './ontology-relationships.mjs';
import { buildSeedStatements, loadSeed } from './seed-load.mjs';
import { fetchVerifiedSeed } from './seed';
import type { RelateSession } from './types';

export type SessionStep = 'seed' | 'wasm' | 'seeding';

/** A trap while loading the seed; the WASM instance must not be reused. */
export class RelateTrapError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RelateTrapError';
  }
}

/**
 * Resolve, verify, and load everything a Run needs. The returned session owns
 * one writable `:memory:` database; no OPFS and no persisted store.
 */
export async function openRelateSession(
  onStep: (step: SessionStep) => void,
): Promise<RelateSession> {
  onStep('seed');
  const { seed, digest, byteLength } = await fetchVerifiedSeed();

  onStep('wasm');
  const loader = await import('./relate-loader');
  await loader.initRelateWasm();

  onStep('seeding');
  const db = loader.openRelateDb();
  const relationships = parseRelationshipEndpoints(farmbotOntology);
  const statements = buildSeedStatements(seed, relationships);
  let statementCount: number;
  try {
    ({ statements: statementCount } = loadSeed(db, statements));
  } catch (loadError) {
    db.free();
    if (loader.isRelateWasmTrap(loadError)) throw new RelateTrapError(loadError);
    throw loadError;
  }

  return {
    digest,
    byteLength,
    statements: statementCount,
    execute(query, params) {
      return loader.executeWire(db, query, params);
    },
    isTrap(error) {
      return loader.isRelateWasmTrap(error);
    },
    close() {
      db.free();
    },
  };
}
