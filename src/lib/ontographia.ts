// Thin typed wrapper over the vendored binding. WASM is same-origin (public/assets).
import * as binding from '../../vendor/ontographia/binding/ontographia-wasm.js';

export type Dialect = 'cypher25';

export interface BuildOptions {
  dialect: Dialect;
  ontologyPathHint: string;
}

export interface CypherResult {
  query: string;
  params: Record<string, unknown>;
}

export interface Ontographia {
  abiVersion: number;
  buildCypher(ontology: string, intent: object | string, options?: Partial<BuildOptions>): CypherResult;
}

/** Same-origin WASM produced by `npm run prepare:wasm`. */
export const WASM_URL = `${import.meta.env.BASE_URL}assets/ontographia/ontographia_wasm.wasm`;
const DEFAULT_OPTIONS: BuildOptions = { dialect: 'cypher25', ontologyPathHint: 'plm.native.yaml' };

type RawInstance = {
  abiVersion: number;
  buildCypher(
    ontology: string | Uint8Array | ArrayBuffer,
    intent: object | string,
    options?: { dialect?: string; ontologyPathHint?: string | null },
  ): CypherResult;
};

type BindingModule = {
  loadOntographia: (source?: string | URL | Uint8Array | ArrayBuffer) => Promise<RawInstance>;
};

export async function loadOntographia(wasmUrl: string = WASM_URL): Promise<Ontographia> {
  const raw = await (binding as BindingModule).loadOntographia(wasmUrl);
  const abi = raw.abiVersion;
  if (abi !== 1) throw new Error(`Unsupported Ontographia ABI version: ${String(abi)} (expected 1)`);
  return {
    abiVersion: abi,
    buildCypher(ontology, intent, options) {
      return raw.buildCypher(ontology, intent, { ...DEFAULT_OPTIONS, ...options });
    },
  };
}
