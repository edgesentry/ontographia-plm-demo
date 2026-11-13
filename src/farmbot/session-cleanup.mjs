// Cleanup for a failed or trapped Relate session.
//
// Releasing a database is best-effort. When the seed load or a statement has
// already failed, that first failure is the one the screen must act on, so a
// secondary throw from `free()` / `close()` is discarded rather than allowed to
// replace it.

/**
 * Free a database without letting a secondary failure escape.
 *
 * @param {{ free: () => void }} db
 */
export function freeRelateDb(db) {
  try {
    db.free();
  } catch {
    // The database is being discarded either way.
  }
}

/**
 * Rethrow the original seed-load failure after best-effort cleanup. A trap is
 * wrapped with `toTrapError`; any other failure is rethrown unchanged, even if
 * `db.free()` throws.
 *
 * @param {{ free: () => void }} db
 * @param {unknown} loadError
 * @param {(error: unknown) => boolean} isTrap
 * @param {(cause: unknown) => Error} toTrapError
 * @returns {never}
 */
export function rethrowSeedLoadFailure(db, loadError, isTrap, toTrapError) {
  freeRelateDb(db);
  if (isTrap(loadError)) throw toTrapError(loadError);
  throw loadError;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function detailText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Discard a trapped session. `close()` is best-effort: the trap state is
 * handed to `apply` from a `finally` block so a throwing `close()` cannot stop
 * the caller from recording the trap and disabling further Runs.
 *
 * @param {{ close: () => void }} session
 * @param {unknown} trapError
 * @param {(trap: { kind: 'wasm-trap'; detail: string }) => void} apply
 */
export function closeTrappedSession(session, trapError, apply) {
  try {
    session.close();
  } catch {
    // The trap is the failure to report; the close error is not interesting.
  } finally {
    apply({ kind: 'wasm-trap', detail: detailText(trapError) });
  }
}
