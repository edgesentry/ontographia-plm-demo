#!/usr/bin/env node
// Generate the allowed parameter values for the preset question Intents from
// the DuckDB extract. The file is a deterministic build output kept beside the
// committed graph seed so that a test can regenerate it and compare bytes.
//
// Domains are read from the extract with the same classification as
// farmbot/scripts/graph.mjs: kit pages are packing pages other than the main
// carton and pallet-stacking.md, and Accessory bag BOM rows belong to a bag
// rather than to the enclosing pre-assembly page.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FARMBOT_DIR = resolve(SCRIPT_DIR, '..');

export const ALLOWED_VALUES_FORMAT = 'farmbot-allowed-values-v1';
export const DEFAULT_EXTRACT = resolve(FARMBOT_DIR, 'dist/farmbot.duckdb');
export const DEFAULT_OUT = resolve(FARMBOT_DIR, 'dist');
export const OUTPUT_NAME = 'farmbot.allowed-values.json';

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareStrings);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => indent(canonicalJson(item), 2));
    return `[\n${items.join(',\n')}\n]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort(compareStrings);
    if (keys.length === 0) return '{}';
    const items = keys.map(
      (key) => indent(`${JSON.stringify(key)}: ${canonicalJson(value[key])}`, 2),
    );
    return `{\n${items.join(',\n')}\n}`;
  }
  return JSON.stringify(value);
}

function indent(text, spaces) {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function serializeAllowedValues(values) {
  return Buffer.from(`${canonicalJson(values)}\n`, 'utf8');
}

export async function readAllowedValues(extractPath) {
  if (!existsSync(extractPath)) {
    throw new Error(`extract not found: ${extractPath}`);
  }
  const instance = await DuckDBInstance.create(extractPath, {
    access_mode: 'READ_ONLY',
  });
  try {
    const connection = await instance.connect();
    const read = async (sql, params) =>
      (await connection.runAndReadAll(sql, params)).getRowObjectsJS();
    try {
      const partRows = await read('SELECT name FROM part');
      const categoryRows = await read('SELECT slug FROM bom_category');
      const statusRows = await read('SELECT DISTINCT status FROM unmatched_name');
      const assemblyRows = await read(
        'SELECT DISTINCT resolved_part AS name FROM assembly_reference WHERE resolved_part IS NOT NULL',
      );
      const preassemblyRows = await read(
        "SELECT DISTINCT resolved_part AS name FROM preassembly_reference " +
          "WHERE resolved_part IS NOT NULL AND section IS DISTINCT FROM 'Accessory bag BOM'",
      );
      const kitRows = await read(
        'SELECT DISTINCT item.resolved_part AS name ' +
          'FROM packing_item AS item ' +
          'JOIN packing_page AS page ON page.path = item.page_path ' +
          'WHERE item.resolved_part IS NOT NULL ' +
          "AND page.path NOT LIKE '%/main-carton.md' " +
          "AND page.path NOT LIKE '%/pallet-stacking.md'",
      );
      const kitCategoryRows = await read(
        'SELECT DISTINCT part.category_slug AS slug ' +
          'FROM packing_item AS item ' +
          'JOIN packing_page AS page ON page.path = item.page_path ' +
          'JOIN part ON part.name = item.resolved_part ' +
          "WHERE page.path NOT LIKE '%/main-carton.md' " +
          "AND page.path NOT LIKE '%/pallet-stacking.md'",
      );

      const partNames = sortedUnique(partRows.map((row) => row.name));
      const inAssembly = sortedUnique(assemblyRows.map((row) => row.name));
      const inPreassembly = sortedUnique(preassemblyRows.map((row) => row.name));
      const inKits = sortedUnique(kitRows.map((row) => row.name));
      const preassemblySet = new Set(inPreassembly);
      const kitSet = new Set(inKits);
      const inAllThree = inAssembly.filter(
        (name) => preassemblySet.has(name) && kitSet.has(name),
      );

      return {
        format: ALLOWED_VALUES_FORMAT,
        category_slugs: sortedUnique(categoryRows.map((row) => row.slug)),
        category_slugs_in_kits: sortedUnique(kitCategoryRows.map((row) => row.slug)),
        part_names: partNames,
        part_names_in_all_three_structure_kinds: inAllThree,
        part_names_in_assembly_chapters: inAssembly,
        part_names_in_kits: inKits,
        part_names_in_preassemblies: inPreassembly,
        unmatched_statuses: sortedUnique(statusRows.map((row) => row.status)),
      };
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

export async function generate({ extract, out }) {
  const values = await readAllowedValues(extract);
  const bytes = serializeAllowedValues(values);
  await mkdir(out, { recursive: true });
  const path = resolve(out, OUTPUT_NAME);
  await writeFile(path, bytes);
  return {
    path,
    bytes: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
    values,
  };
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const options = { extract: DEFAULT_EXTRACT, out: DEFAULT_OUT };
  const keys = { '--extract': 'extract', '--out': 'out' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    const equals = argument.indexOf('=');
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const key = keys[flag];
    if (!key) throw new Error(`unknown argument ${argument}`);
    if (equals === -1) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options[key] = value;
      index += 1;
    } else {
      options[key] = argument.slice(equals + 1);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: allowed-values.mjs [--extract <duckdb>] [--out <directory>]',
    '',
    `Defaults: extract ${DEFAULT_EXTRACT}`,
    `          out ${DEFAULT_OUT}`,
  ].join('\n');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await generate({
    extract: resolve(parsed.extract),
    out: resolve(parsed.out),
  });
  process.stdout.write(
    `Allowed values written: ${result.path} (${result.bytes} bytes)\n`,
  );
  process.stdout.write(`sha256:${result.digest}\n`);
  process.stdout.write(
    `parts ${result.values.part_names.length}, ` +
      `categories ${result.values.category_slugs.length}, ` +
      `statuses ${result.values.unmatched_statuses.length}, ` +
      `all-structure-kind parts ${result.values.part_names_in_all_three_structure_kinds.length}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`allowed-values.mjs: ${error.message}\n`);
    process.exitCode = 1;
  });
}
