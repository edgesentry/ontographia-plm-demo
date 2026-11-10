/**
 * The npm WASM binding exposes a numeric ABI version. Anything other than 1 is
 * rejected before the app uses the engine, so a mismatched package fails loudly
 * instead of producing partial results.
 */
export const SUPPORTED_ABI_VERSION = 1;

export function assertAbiVersion(abi: unknown): asserts abi is number {
  if (!Number.isInteger(abi) || abi !== SUPPORTED_ABI_VERSION) {
    throw new Error(`Unsupported Ontographia ABI version: ${String(abi)} (expected ${SUPPORTED_ABI_VERSION})`);
  }
}
