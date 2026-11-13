#!/usr/bin/env node
// Build the release-ready FarmBot assets into one directory:
//
//   farmbot.duckdb                the DuckDB extract
//   farmbot-relate-store.tar.gz   the persistent Relate directory store
//   farmbot.release.json          the committed digest manifest
//   SHA256SUMS                    sha256sum-format hashes of the three files
//
// Every logical digest and count is checked against the committed manifest
// before a file is written to the output directory. The script never creates a
// release and never uploads anything; publishing is a maintainer step.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { canonicalDigest } from './extract.mjs';
import {
  COMMITTED_MANIFEST,
  MANIFEST_NAME,
  STORE_ARCHIVE_NAME,
  STORE_DIR_NAME,
  buildStoreInChild,
  logicalDump,
  readManifest,
} from './relate-store.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..', '..');
const EXTRACT_SCRIPT = resolve(SCRIPT_DIR, 'extract.mjs');
const TRACKED_DUCKDB_SIDECAR = resolve(ROOT, 'farmbot/dist/farmbot.duckdb.sha256');
export const DEFAULT_OUT = resolve(ROOT, 'release-assets');

/**
 * SHA-256 hex of a file's bytes.
 *
 * @param {string} path
 * @returns {string}
 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The `sha256sum` text for a set of named files, sorted by file name.
 *
 * @param {Array<{ name: string, path: string }>} files
 * @returns {string}
 */
export function sha256SumsText(files) {
  return `${[...files]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((file) => `${sha256File(file.path)}  ${file.name}`)
    .join('\n')}\n`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${result.status ?? 'signal'})` +
        (detail ? `: ${detail}` : ''),
    );
  }
  return result;
}

/**
 * Build every asset into `outDir` and check it against the committed manifest.
 *
 * @param {{ outDir?: string }} [options]
 * @returns {{
 *   outDir: string,
 *   duckdb: { path: string, bytes: number, sha256: string },
 *   store: { path: string, bytes: number, digest: string, nodes: number, relationships: number },
 *   manifest: { path: string, bytes: number },
 *   sums: { path: string, bytes: number, text: string },
 * }}
 */
export async function buildReleaseAssets(options = {}) {
  const outDir = resolve(options.outDir ?? DEFAULT_OUT);
  const manifest = readManifest();
  const workDir = mkdtempSync(join(tmpdir(), 'farmbot-release-assets-'));

  try {
    const duckdbDir = join(workDir, 'duckdb');
    run(process.execPath, [EXTRACT_SCRIPT, '--out', duckdbDir], { stdio: 'inherit' });
    const duckdbPath = join(duckdbDir, manifest.duckdb.file);
    const duckdbDigest = await canonicalDigest(duckdbPath);
    if (duckdbDigest !== manifest.duckdb.sha256) {
      throw new Error(
        `DuckDB canonical digest mismatch: built ${manifest.duckdb.digestFormat}:${duckdbDigest}, ` +
          `manifest ${manifest.duckdb.sha256}`,
      );
    }
    const trackedSidecar = readFileSync(TRACKED_DUCKDB_SIDECAR, 'utf8').trim();
    if (trackedSidecar !== manifest.duckdb.sha256) {
      throw new Error(
        `${TRACKED_DUCKDB_SIDECAR} does not match the manifest: ${trackedSidecar}`,
      );
    }

    const storeDir = join(workDir, STORE_DIR_NAME);
    buildStoreInChild(storeDir);
    const dump = logicalDump(storeDir);
    if (dump.format !== manifest.relateStore.digestFormat) {
      throw new Error(
        `store digest format mismatch: built ${dump.format}, ` +
          `manifest ${manifest.relateStore.digestFormat}`,
      );
    }
    if (dump.sha256 !== manifest.relateStore.sha256) {
      throw new Error(
        `store logical digest mismatch: built ${dump.digest}, ` +
          `manifest ${manifest.relateStore.digestFormat}:${manifest.relateStore.sha256}`,
      );
    }
    if (dump.nodes !== manifest.relateStore.nodes) {
      throw new Error(
        `store node count mismatch: built ${dump.nodes}, manifest ${manifest.relateStore.nodes}`,
      );
    }
    if (dump.relationships !== manifest.relateStore.relationships) {
      throw new Error(
        `store relationship count mismatch: built ${dump.relationships}, ` +
          `manifest ${manifest.relateStore.relationships}`,
      );
    }

    const archivePath = join(outDir, STORE_ARCHIVE_NAME);
    mkdirSync(outDir, { recursive: true });
    run('tar', ['-czf', archivePath, '-C', workDir, STORE_DIR_NAME], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const outDuckdb = join(outDir, manifest.duckdb.file);
    copyFileSync(duckdbPath, outDuckdb);
    const outManifest = join(outDir, MANIFEST_NAME);
    copyFileSync(COMMITTED_MANIFEST, outManifest);

    const files = [
      { name: MANIFEST_NAME, path: outManifest },
      { name: manifest.duckdb.file, path: outDuckdb },
      { name: STORE_ARCHIVE_NAME, path: archivePath },
    ];
    const sumsText = sha256SumsText(files);
    const sumsPath = join(outDir, 'SHA256SUMS');
    writeFileSync(sumsPath, sumsText, 'utf8');

    return {
      outDir,
      duckdb: {
        path: outDuckdb,
        bytes: statSync(outDuckdb).size,
        sha256: duckdbDigest,
      },
      store: {
        path: archivePath,
        bytes: statSync(archivePath).size,
        digest: dump.digest,
        nodes: dump.nodes,
        relationships: dump.relationships,
      },
      manifest: { path: outManifest, bytes: statSync(outManifest).size },
      sums: { path: sumsPath, bytes: statSync(sumsPath).size, text: sumsText },
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  let outDir = DEFAULT_OUT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out requires a path');
      outDir = resolve(value);
      index += 1;
    } else if (argument.startsWith('--out=')) {
      outDir = resolve(argument.slice('--out='.length));
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { outDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { outDir } = parseArguments(process.argv.slice(2));
    const summary = await buildReleaseAssets({ outDir });
    process.stdout.write(`release assets: ${summary.outDir}\n`);
    process.stdout.write(
      `${MANIFEST_NAME}: ${summary.manifest.bytes} bytes\n` +
        `${STORE_ARCHIVE_NAME}: ${summary.store.bytes} bytes\n` +
        `${summary.duckdb.path.split('/').pop()}: ${summary.duckdb.bytes} bytes\n`,
    );
    process.stdout.write(`duckdb canonical: ${summary.duckdb.sha256}\n`);
    process.stdout.write(`store logical: ${summary.store.digest}\n`);
    process.stdout.write(
      `store counts: ${summary.store.nodes} nodes / ${summary.store.relationships} relationships\n`,
    );
    process.stdout.write('SHA256SUMS:\n');
    process.stdout.write(summary.sums.text);
  } catch (error) {
    process.stderr.write(`release-assets.mjs: ${error.message}\n`);
    process.exitCode = 1;
  }
}
