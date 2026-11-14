// Guard for extracting the persistent Relate store archive.
//
// The release assets are downloaded, so the archive is untrusted input. Before
// any member is written to disk the member list is checked: every name must sit
// under `farmbot.relate-store/` and must not be absolute or contain empty, `.`
// or `..` segments. After extraction the tree is walked with `lstatSync` and
// only directories and regular single-link files are accepted, so a symlink or
// hardlink planted in the archive cannot redirect a later read. The resolved
// store directory must also still be inside the resolved extraction root.
//
// tar's own defences (GNU tar refuses `..` members and writes through links,
// bsdtar refuses absolute names) differ between implementations, so this guard
// does not rely on them.

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { STORE_DIR_NAME } from '../relate-store.mjs';

/**
 * List the member names in a gzipped tar archive.
 *
 * @param {string} archivePath
 * @returns {string[]}
 */
export function listArchiveMembers(archivePath) {
  const result = spawnSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.status !== 0) {
    throw new Error(
      `tar -tzf failed (exit ${result.status ?? 'signal'}): ${String(result.stderr).trim()}`,
    );
  }
  const names = String(result.stdout).split('\n');
  if (names.at(-1) === '') names.pop();
  if (names.length === 0) throw new Error('the archive has no members');
  return names;
}

/**
 * Refuse member names that could escape the extraction directory or that do
 * not belong to the store directory.
 *
 * @param {string[]} names
 * @param {string} [storeDirName]
 */
export function assertArchiveMemberNames(names, storeDirName = STORE_DIR_NAME) {
  const prefix = `${storeDirName}/`;
  for (const name of names) {
    if (name === '') throw new Error('the archive has an empty member name');
    if (isAbsolute(name)) {
      throw new Error(`archive member ${JSON.stringify(name)} is an absolute path`);
    }
    const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
    const segments = trimmed.split('/');
    for (const segment of segments) {
      if (segment === '') {
        throw new Error(
          `archive member ${JSON.stringify(name)} contains an empty path segment`,
        );
      }
      if (segment === '.' || segment === '..') {
        throw new Error(
          `archive member ${JSON.stringify(name)} contains a ${JSON.stringify(segment)} segment`,
        );
      }
    }
    if (name !== prefix && !name.startsWith(prefix)) {
      throw new Error(
        `archive member ${JSON.stringify(name)} is outside the ${prefix} directory`,
      );
    }
  }
}

/**
 * Walk an extracted tree and refuse anything but plain directories and
 * single-link regular files.
 *
 * @param {string} path
 * @param {string} root
 */
function assertPlainTree(path, root) {
  const shown = relative(root, path) || '.';
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error(`extracted entry ${JSON.stringify(shown)} is a symbolic link`);
  }
  if (stats.isDirectory()) {
    for (const name of readdirSync(path)) assertPlainTree(join(path, name), root);
    return;
  }
  if (!stats.isFile()) {
    throw new Error(
      `extracted entry ${JSON.stringify(shown)} is neither a regular file nor a directory`,
    );
  }
  if (stats.nlink > 1) {
    throw new Error(
      `extracted file ${JSON.stringify(shown)} has ${stats.nlink} hard links`,
    );
  }
}

/**
 * Check that the extracted store is a plain directory inside `root`.
 *
 * @param {string} root The extraction directory.
 * @param {string} [storeDirName]
 * @returns {string} The absolute store directory.
 */
export function assertExtractedStore(root, storeDirName = STORE_DIR_NAME) {
  const storePath = join(root, storeDirName);
  let storeStats;
  try {
    storeStats = lstatSync(storePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${storeDirName} is not in the archive`);
    }
    throw error;
  }
  if (storeStats.isSymbolicLink()) {
    throw new Error(`extracted entry ${JSON.stringify(storeDirName)} is a symbolic link`);
  }
  if (!storeStats.isDirectory()) {
    throw new Error(`extracted entry ${JSON.stringify(storeDirName)} is not a directory`);
  }
  assertPlainTree(storePath, root);

  const realRoot = realpathSync(root);
  const realStore = realpathSync(storePath);
  const inside = relative(realRoot, realStore);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(
      `resolved store directory ${realStore} is outside the extraction directory ${realRoot}`,
    );
  }
  return realStore;
}

/**
 * Check, extract and re-check the store archive into `destDir`.
 *
 * @param {string} archivePath
 * @param {string} destDir An existing, empty directory.
 * @returns {string} The absolute store directory inside `destDir`.
 */
export function extractStoreArchive(archivePath, destDir) {
  const root = resolve(destDir);
  assertArchiveMemberNames(listArchiveMembers(archivePath));
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', root], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.status !== 0) {
    throw new Error(
      `tar -xzf failed (exit ${result.status ?? 'signal'}): ${String(result.stderr).trim()}`,
    );
  }
  return assertExtractedStore(root);
}
