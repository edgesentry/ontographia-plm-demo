# Relate directory store

The FarmBot screen at `/farmbot/` runs the committed seed in an in-memory
Relate WASM database inside the browser tab. Nothing from that session is
written to disk. For inspection without a browser, the same seed can be loaded
into a persistent Relate **directory store** on disk with the Node client
`@relate/relate` 1.0.1.

The store is a build output. It is not committed, and its files are not
byte-hashed: the files are not guaranteed to be byte-identical across runs or
platforms, and the archive bytes differ between runs. What is committed is a **logical** digest of the graph,
stored in `farmbot/dist/farmbot.release.json`.

## Build

```sh
npm ci
node farmbot/scripts/relate-store.mjs
```

The default output directory is `farmbot/dist/farmbot.relate-store/`
(gitignored). `--out <dir>` writes elsewhere. The script:

1. verifies the SHA-256 of `farmbot/dist/farmbot.seed.json` against
   `src/farmbot/seed-digest.mjs` and refuses to continue on a mismatch; the
   output directory is not touched before this check, so a bad seed leaves an
   existing store intact;
2. deletes and recreates the output directory;
3. sets `RELATE_SNAPSHOT_FORMAT=json` in the child process that opens the
   writable store;
4. loads the seed with the same statements the browser uses
   (`src/farmbot/seed-load.mjs` and `src/farmbot/ontology-relationships.mjs`);
5. calls `checkpoint()`;
6. asserts that `graph.json` exists and that `manifest.json` reports
   `"codec": "json"`;
7. reads the graph back read-only and prints the logical digest, node count and
   relationship count, comparing them with the committed manifest.

`--write-manifest` rewrites only `digestFormat`, `sha256`, `nodes` and
`relationships` inside the `relateStore` section of
`farmbot/dist/farmbot.release.json`; the `file`, `client`, `clientVersion`,
`snapshotCodec`, `seed`, `duckdb` and `genesis` values stay as committed. Use
it only when the seed or the load changed; the store fields are otherwise
checked, not rewritten.

The store is built in a child Node process. The Node client has no `close()`
method, so the writer handle lives until its process exits; archiving or
copying the directory before that would capture a store that is still open.

## Why `RELATE_SNAPSHOT_FORMAT=json`

The snapshot codec is selected when the writable store is opened, by the
environment variable `RELATE_SNAPSHOT_FORMAT`, read by the native library. With
`RELATE_SNAPSHOT_FORMAT=json` the checkpoint writes the whole graph to
`graph.json`, which is readable JSON with `nodes` and `relationships` arrays.
Without the variable the default codec writes Parquet shards under `nodes/` and
`relationships/` instead. The environment variable must be set before the first
`Database.open` of the writable store in that process.

The build does not trust the variable blindly: it checks the two files above
after the checkpoint and fails if the JSON layout is not there.

## Layout observed on macOS arm64

| Path | Size | Role |
| --- | ---: | --- |
| `graph.json` | 222122 bytes | The graph: `value_encoding`, `nodes`, `relationships`. |
| `manifest.json` | 122 bytes | Engine metadata; `"codec": "json"`, checkpoint LSN and commit timestamp. |
| `wal/00000002.log` | 8 bytes | Write-ahead log segment left after the checkpoint. |
| `.cypherlite/schema/schema.cypher` | 0 bytes | Schema text; empty for this store. |
| `.cypherlite.lock` | 24 bytes | Lock marker (`CYPHERLITE-LOCK-v1 root`). |
| `wal/.cypherlite.lock` | 23 bytes | Lock marker for the WAL directory. |
| `.cypherlite.writer` | 0 bytes | Writer marker. |
| `wal/.cypherlite.writer` | 0 bytes | Writer marker in the WAL directory. |

Sizes and file names are engine details, not part of the contract. Treat the
directory as one store and archive it whole.

## Logical dump format

`logicalDump()` in `farmbot/scripts/relate-store.mjs` opens the store
read-only, reads every node and every relationship through Cypher, and
serializes them canonically. Engine-internal numeric ids and element ids are
never used: a relationship records the `id` property of its two nodes.

The format id is `farmbot-relate-store-v2`. The serialized text is:

```text
farmbot-relate-store-v2
{"kind":"node","labels":[...],"properties":{"<key>":{"type":"...","value":...},...}}
...
{"from":"...","kind":"relationship","properties":{...},"to":"...","type":"..."}
...
```

- One header line with the format id, then one canonical JSON object per line.
- Object keys are sorted by code point at every level.
- Node objects carry `kind`, `labels` (sorted), and `properties` (keys sorted,
  including `id`). Nodes are ordered by their `id` property.
- Relationship objects carry `kind`, `type`, `from`, `to`, and `properties`.
  `from` and `to` are the `id` properties of the endpoint nodes. Relationships
  are ordered by type, then `from`, then `to`, then the canonical properties.
- Every property is **typed**. The dump query also asks the engine for
  `[k IN keys(n) | [k, valueType(n[k])]]` (and the same for relationships), and
  each property is encoded as `{"type": <engine type>, "value": <canonical
  value>}`. `type` is the engine's spelling, such as `"INTEGER NOT NULL"` or
  `"LIST<FLOAT NOT NULL> NOT NULL"`.
- INTEGER values (a JS number or a `bigint`) are decimal strings, so `1` and
  `1n` with type INTEGER encode the same. FLOAT values are JSON numbers.
  STRING and BOOLEAN values are JSON strings and literals, lists encode each
  element by the type inside `LIST<...>`, and maps encode as canonical JSON.
- A value that does not match its reported type (for example a fractional
  number for INTEGER), and any unsupported type, throws: a lossy encoding would
  make the digest meaningless. Because FLOAT values are JSON numbers, `-0.0`
  and `0.0` encode the same; the seed has no such value.

The digest is SHA-256 over the UTF-8 bytes of the serialized text, printed as
`farmbot-relate-store-v2 sha256:<hex>`. The seed used here has 604 nodes and
1022 relationships, and its digest is the `relateStore.sha256` value in
`farmbot/dist/farmbot.release.json`.

## Reading a store read-only

The store archive in the release assets is
`farmbot-relate-store.tar.gz`; extracting it yields a `farmbot.relate-store/`
directory. A read-only open needs the `.cypherlite.lock` marker files, so
archive the whole directory rather than only `graph.json`, `manifest.json`, the
WAL and the schema: an archive without the lock markers fails with
`RelateError: internal error`. The writer marker files may be left in; they do
not prevent a read-only open of an extracted copy.

```js
import { createRequire } from 'node:module';
import { logicalDump } from './farmbot/scripts/relate-store.mjs';

const { Database } = createRequire(import.meta.url)('@relate/relate');
const db = Database.open('<extracted>/farmbot.relate-store', { readOnly: true });
const connection = db.connect();
console.log(connection.query('MATCH (n) RETURN count(n) AS nodes').rows[0]);
console.log(logicalDump('<extracted>/farmbot.relate-store').digest);
```

`Database.open(dir, { readOnly: true })` refuses writes and checkpoints, and any
number of reader handles may open the same directory. `@relate/relate` is a
Node-only devDependency; the browser keeps using `@relate/relate-wasm` in
`:memory:`.

## Verify release assets

```sh
npm run release:assets -- --out release-assets
npm run release:verify -- release-assets
```

`release:assets` rebuilds the DuckDB file and the store, checks both against
`farmbot/dist/farmbot.release.json` and the DuckDB sidecar, then writes the
three release files and `SHA256SUMS`. `release:verify` repeats the checks on a
directory that may have been downloaded: file hashes, the bundled manifest, the
store's logical digest and counts, and the DuckDB canonical digest.

`SHA256SUMS` may name only the three expected asset basenames; any other name
(including one with `..` or a path separator) fails before a file is read. The
store archive is untrusted input: before extraction every member name must sit
under `farmbot.relate-store/` with no absolute path and no empty, `.` or `..`
segment, and after extraction the tree may contain only directories and
single-link regular files. A symlink, hardlink or other entry type fails the
check, and the archive is removed from the temporary directory afterwards.
