// Tests for the two cleanup paths the /farmbot/ screen relies on:
//
// - releasing a failed or trapped Relate database must never mask the original
//   failure, and a trap must still be recorded when close() throws;
// - a rejected WASM initialisation must not stay cached, so a later Run can
//   retry it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInitCache } from '../../src/farmbot/init-cache.mjs';
import {
  closeTrappedSession,
  freeRelateDb,
  rethrowSeedLoadFailure,
} from '../../src/farmbot/session-cleanup.mjs';

class FakeTrapError extends Error {
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'FakeTrapError';
    this.cause = cause;
  }
}

function throwingDb(message = 'free failed') {
  return {
    free() {
      throw new Error(message);
    },
  };
}

test('freeRelateDb swallows a secondary free() failure', () => {
  assert.doesNotThrow(() => freeRelateDb(throwingDb()));
});

test('a trapped seed load still raises the trap when free() throws', () => {
  const original = new Error('wasm trap');
  assert.throws(
    () =>
      rethrowSeedLoadFailure(
        throwingDb(),
        original,
        () => true,
        (cause) => new FakeTrapError(cause),
      ),
    (error) =>
      error instanceof FakeTrapError &&
      error.message === 'wasm trap' &&
      error.cause === original,
  );
});

test('a non-trap seed load error is rethrown unchanged when free() throws', () => {
  const original = new Error('seed load failed');
  assert.throws(
    () =>
      rethrowSeedLoadFailure(
        throwingDb(),
        original,
        () => false,
        () => new FakeTrapError('must not be used'),
      ),
    (error) => error === original,
  );
});

test('a trapped session still records the trap when close() throws', () => {
  const applied = [];
  const session = {
    close() {
      throw new Error('close failed');
    },
  };
  assert.doesNotThrow(() =>
    closeTrappedSession(session, new Error('wasm trap'), (trap) => applied.push(trap)),
  );
  assert.deepEqual(applied, [{ kind: 'wasm-trap', detail: 'wasm trap' }]);
});

test('a trapped session records a non-Error trap without throwing', () => {
  const applied = [];
  closeTrappedSession({ close() {} }, 'trap text', (trap) => applied.push(trap));
  assert.deepEqual(applied, [{ kind: 'wasm-trap', detail: 'trap text' }]);
});

test('a rejected initialisation is retried by the next call', async () => {
  let attempts = 0;
  const init = createInitCache(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient fetch failure');
  });

  await assert.rejects(init(), /transient fetch failure/);
  await init();
  assert.equal(attempts, 2);
});

test('a successful initialisation is cached', async () => {
  let attempts = 0;
  const init = createInitCache(async () => {
    attempts += 1;
  });

  await init();
  await init();
  assert.equal(attempts, 1);
});

test('concurrent calls share one initialisation attempt', async () => {
  let attempts = 0;
  const init = createInitCache(async () => {
    attempts += 1;
    await Promise.resolve();
  });

  await Promise.all([init(), init(), init()]);
  assert.equal(attempts, 1);
});
