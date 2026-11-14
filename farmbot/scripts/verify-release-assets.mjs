#!/usr/bin/env node
// Verify a directory of downloaded FarmBot release assets:
//
//   node farmbot/scripts/verify-release-assets.mjs <dir>
//
// Every check prints one line. The first failure stops the run with a non-zero
// exit code. Nothing is uploaded and no release is created.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalDigest } from './extract.mjs';
import { extractStoreArchive } from './lib/archive-guard.mjs';
import { MANIFEST_NAME, logicalDump, readManifest } from './relate-store.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..', '..');
const TRACKED_DUCKDB_SIDECAR = resolve(ROOT, 'farmbot/dist/farmbot.duckdb.sha256');

const SHA256SUMS_NAME = 'SHA256SUMS';
const SUM_LINE = /^([0-9a-f]{64}) {2}(\S.*)$/;

class VerifyError extends Error {}

/**
 * Run one named check, print its line, and stop on the first failure.
 *
 * @template T
 * @param {string} name
 * @param {() => T | Promise<T>} check
 * @returns {Promise<T>}
 */
async function runCheck(name, check) {
  let detail;
  try {
    detail = await check();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`FAIL ${name}: ${message}\n`);
    throw new VerifyError(message);
  }
  process.stdout.write(`ok   ${name}${detail ? `: ${detail}` : ''}\n`);
  return detail;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Read and verify the asset directory. Returns a summary for the caller.
 *
 * @param {string} dir
 * @returns {Promise<{ dir: string, files: string[], storeDigest: string }>}
 */
export async function verifyReleaseAssets(dir) {
  const assetDir = resolve(dir);
  const manifest = readManifest();

  await runCheck('asset directory exists', () => {
    if (!existsSync(assetDir) || !statSync(assetDir).isDirectory()) {
      throw new Error(`${assetDir} is not a directory`);
    }
    return assetDir;
  });

  const expected = [MANIFEST_NAME, manifest.duckdb.file, manifest.relateStore.file];
  const allowedNames = new Set(expected);

  const sumsPath = join(assetDir, SHA256SUMS_NAME);
  const sums = new Map();
  await runCheck(`${SHA256SUMS_NAME} parses`, () => {
    if (!existsSync(sumsPath)) throw new Error(`${sumsPath} is missing`);
    for (const [index, line] of readFileSync(sumsPath, 'utf8').split('\n').entries()) {
      if (line === '') continue;
      const match = SUM_LINE.exec(line);
      if (!match) {
        throw new Error(`line ${index + 1} is not "<hex>  <name>": ${JSON.stringify(line)}`);
      }
      const name = match[2];
      if (!allowedNames.has(name)) {
        throw new Error(
          `line ${index + 1} names ${JSON.stringify(name)}, which is not one of ` +
            `${[...allowedNames].join(', ')}`,
        );
      }
      if (sums.has(name)) throw new Error(`duplicate entry for ${name}`);
      sums.set(name, match[1]);
    }
    if (sums.size === 0) throw new Error('no entries');
    return `${sums.size} entries`;
  });

  for (const name of expected) {
    await runCheck(`expected asset ${name} is present and listed`, () => {
      const path = join(assetDir, name);
      if (!existsSync(path)) throw new Error(`${path} is missing`);
      if (!sums.has(name)) throw new Error(`${SHA256SUMS_NAME} has no line for ${name}`);
      return `${statSync(path).size} bytes`;
    });
  }

  for (const [name, expectedHex] of sums) {
    await runCheck(`${SHA256SUMS_NAME} entry ${name} matches the file bytes`, () => {
      const path = join(assetDir, name);
      if (!existsSync(path)) throw new Error(`${path} is missing`);
      const actual = sha256File(path);
      if (actual !== expectedHex) {
        throw new Error(`listed ${expectedHex}, file hashes to ${actual}`);
      }
      return actual;
    });
  }

  await runCheck('bundled manifest equals the committed manifest', () => {
    const bundledPath = join(assetDir, MANIFEST_NAME);
    const bundled = JSON.parse(readFileSync(bundledPath, 'utf8'));
    if (!sameJson(bundled, manifest)) {
      throw new Error(`${bundledPath} differs from ${join(ROOT, 'farmbot/dist', MANIFEST_NAME)}`);
    }
    return bundled.format;
  });

  const workDir = mkdtempSync(join(tmpdir(), 'farmbot-verify-assets-'));
  try {
    const archivePath = join(assetDir, manifest.relateStore.file);
    let storeDir;
    await runCheck('store archive extracts and opens read-only', () => {
      storeDir = extractStoreArchive(archivePath, workDir);
      return storeDir;
    });

    let dump;
    await runCheck('store logical digest and counts match the manifest', () => {
      dump = logicalDump(storeDir);
      if (dump.sha256 !== manifest.relateStore.sha256) {
        throw new Error(
          `computed ${manifest.relateStore.digestFormat}:${dump.sha256}, ` +
            `manifest ${manifest.relateStore.sha256}`,
        );
      }
      if (dump.nodes !== manifest.relateStore.nodes) {
        throw new Error(`computed ${dump.nodes} nodes, manifest ${manifest.relateStore.nodes}`);
      }
      if (dump.relationships !== manifest.relateStore.relationships) {
        throw new Error(
          `computed ${dump.relationships} relationships, ` +
            `manifest ${manifest.relateStore.relationships}`,
        );
      }
      return `${dump.digest} (${dump.nodes} nodes, ${dump.relationships} relationships)`;
    });

    await runCheck('DuckDB canonical digest matches the manifest', async () => {
      const duckdbPath = join(assetDir, manifest.duckdb.file);
      const digest = await canonicalDigest(duckdbPath);
      if (digest !== manifest.duckdb.sha256) {
        throw new Error(
          `computed ${manifest.duckdb.digestFormat}:${digest}, manifest ${manifest.duckdb.sha256}`,
        );
      }
      const trackedSidecar = readFileSync(TRACKED_DUCKDB_SIDECAR, 'utf8').trim();
      if (trackedSidecar !== digest) {
        throw new Error(`${TRACKED_DUCKDB_SIDECAR} is ${trackedSidecar}`);
      }
      return digest;
    });

    return {
      dir: assetDir,
      files: expected,
      storeDigest: dump.digest,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('Usage: node farmbot/scripts/verify-release-assets.mjs <dir>\n');
    process.exitCode = 1;
  } else {
    try {
      const summary = await verifyReleaseAssets(args[0]);
      process.stdout.write(
        `release assets verified: ${summary.dir} (${summary.storeDigest})\n`,
      );
    } catch (error) {
      if (!(error instanceof VerifyError)) {
        process.stdout.write(`FAIL unexpected error: ${error?.message ?? error}\n`);
      }
      process.exitCode = 1;
    }
  }
}
