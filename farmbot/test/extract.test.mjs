import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { canonicalDigest } from '../scripts/extract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const EXTRACT = resolve(ROOT, 'farmbot/scripts/extract.mjs');
const DB_PATH = resolve(ROOT, 'farmbot/dist/farmbot.duckdb');
const HASH_PATH = `${DB_PATH}.sha256`;
const EXPECTED_PIN = '44e0fa24d4a538dfa1255a4e89308ccabf3abaeb';

function runExtract(args = [], overrides = {}) {
  return spawnSync(process.execPath, [EXTRACT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FARMBOT_GENESIS_DIR: '', FARMBOT_OUT_DIR: '', ...overrides },
  });
}

async function withConnection(callback) {
  const instance = await DuckDBInstance.create(DB_PATH);
  const connection = await instance.connect();
  try {
    return await callback(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function rows(sql) {
  return withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjectsJS();
  });
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('extract builds the pinned DuckDB with 149 parts', async () => {
  const result = runExtract();
  assert.equal(result.status, 0, `extract failed:\n${result.stderr}\n${result.stdout}`);

  const [{ part_count: partCount }] = await rows('SELECT count(*) AS part_count FROM part');
  assert.equal(Number(partCount), 149);

  const [{ value: pin }] = await rows(
    "SELECT value FROM extract_metadata WHERE key = 'source_pin'",
  );
  assert.equal(pin, EXPECTED_PIN);

  const m5 = await rows(
    "SELECT quantity_standard, quantity_xl FROM part WHERE name = 'M5 x 10mm Screw'",
  );
  assert.deepEqual(m5, [{ quantity_standard: 150, quantity_xl: 200 }]);
});

test('M5 x 10mm Screw XL 200 vs 225 is listed as a quantity difference', async () => {
  const differences = await rows(
    "SELECT version, packing_quantity, part_quantity, packing_minus_part " +
      "FROM quantity_difference WHERE part_name = 'M5 x 10mm Screw'",
  );
  assert.deepEqual(differences, [
    { version: 'xl', packing_quantity: 225, part_quantity: 200, packing_minus_part: 25 },
  ]);
});

test('the canonical extract hash matches the committed hash file', async () => {
  assert.ok(existsSync(HASH_PATH), `${HASH_PATH} is missing`);
  const expected = readFileSync(HASH_PATH, 'utf8').trim();
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(await canonicalDigest(DB_PATH), expected);

  // Rebuild and confirm the same pin plus the same code yields the same hash.
  // The native .duckdb file bytes may differ; the canonical digest must not.
  const rebuilt = runExtract();
  assert.equal(rebuilt.status, 0, `rebuild failed:\n${rebuilt.stderr}`);
  assert.equal(await canonicalDigest(DB_PATH), expected);
  assert.equal(readFileSync(HASH_PATH, 'utf8').trim(), expected);
});

test('a missing submodule fails clearly and writes nothing', () => {
  const directory = tempDir('farmbot-missing-');
  try {
    const missing = join(directory, 'absent-submodule');
    const out = join(directory, 'out');
    const result = runExtract(['--source', missing, '--out', out]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FarmBot Genesis submodule not found/);
    assert.ok(result.stderr.includes(missing), result.stderr);
    assert.equal(existsSync(join(out, 'farmbot.duckdb')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a wrong pin fails clearly', () => {
  const directory = tempDir('farmbot-wrong-pin-');
  try {
    const git = (...args) =>
      spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
    assert.equal(spawnSync('git', ['init', '-q', directory]).status, 0);
    writeFileSync(join(directory, 'README.md'), 'not the pinned submodule\n');
    assert.equal(git('add', 'README.md').status, 0);
    const commit = spawnSync(
      'git',
      [
        '-C',
        directory,
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-q',
        '-m',
        'fixture',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(commit.status, 0, commit.stderr);
    const actual = git('rev-parse', 'HEAD').stdout.trim();
    assert.match(actual, /^[0-9a-f]{40}$/);

    const result = runExtract([
      '--source',
      directory,
      '--out',
      join(directory, 'out'),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FarmBot Genesis pin mismatch/);
    assert.match(result.stderr, new RegExp(EXPECTED_PIN));
    assert.match(result.stderr, new RegExp(actual));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
