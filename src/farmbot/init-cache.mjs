// Memoised one-shot initialiser with retry-on-failure.
//
// A successful initialisation is cached for the lifetime of the module. A
// rejected one is forgotten, so a transient failure (for example a failed
// fetch of the WASM asset) can be retried by the next call.

/**
 * @param {() => Promise<unknown>} factory
 * @returns {() => Promise<void>}
 */
export function createInitCache(factory) {
  /** @type {Promise<void> | null} */
  let pending = null;
  return () => {
    if (!pending) {
      pending = Promise.resolve()
        .then(factory)
        .then(() => undefined)
        .catch((error) => {
          pending = null;
          throw error;
        });
    }
    return pending;
  };
}
