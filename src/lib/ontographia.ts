// Thin typed wrapper over the published @edgesentry/ontographia-wasm package.
// The WASM asset URL is resolved by Vite (`?url`) and served from the same origin.
import {
  loadOntographia as loadWasmEngine,
  type Dialect as WasmDialect,
  type OntographiaWasm,
  type WasmSource,
} from '@edgesentry/ontographia-wasm';
import wasmUrl from '@edgesentry/ontographia-wasm/ontographia_wasm.wasm?url';
import { assertAbiVersion } from './abi';

export type Dialect = WasmDialect;

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

/** Same-origin WASM asset emitted by Vite from @edgesentry/ontographia-wasm. */
export const WASM_URL = wasmUrl;
const DEFAULT_OPTIONS: BuildOptions = { dialect: 'cypher25', ontologyPathHint: 'plm.native.yaml' };

export async function loadOntographia(source: WasmSource = wasmUrl): Promise<Ontographia> {
  const raw: OntographiaWasm = await loadWasmEngine(source);
  const abi = raw.abiVersion;
  assertAbiVersion(abi);
  return {
    abiVersion: abi,
    buildCypher(ontology, intent, options) {
      return raw.buildCypher(ontology, intent, { ...DEFAULT_OPTIONS, ...options });
    },
  };
}
