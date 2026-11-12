# DuckDB extract distribution

The FarmBot tree builds one DuckDB file from the pinned Genesis submodule. The
binary is a build output and is not committed. The expected content hash is
committed, and the artifact is distributed in two ways: a short-lived CI
artifact and a lasting object in Cloudflare R2.

The constructed EBOM and MBOM views, and the derived correspondence tables in
the extract, are ours. They are not official FarmBot labels.

## Build and test

Run from the repository root:

```sh
npm ci
node farmbot/scripts/extract.mjs
npm run test:farmbot
```

The extract script accepts `--source <path>` and `--out <directory>` (or
`FARMBOT_GENESIS_DIR` and `FARMBOT_OUT_DIR`). The default source is
`farmbot/third_party/farmbot-genesis`. The script refuses to run when that path
is missing, is not a git checkout, or is not at
`44e0fa24d4a538dfa1255a4e89308ccabf3abaeb`.

After a successful build:

- `farmbot/dist/farmbot.duckdb` — the DuckDB database (gitignored);
- `farmbot/dist/farmbot.duckdb.sha256` — the SHA-256 of a canonical dump of
  every table (lowercase hexadecimal plus a newline). This is not the hash
  of the `.duckdb` file bytes. The native file is not bit-identical across
  runs of the same extract: the logical rows are the same, but a small
  number of storage bytes change. The sidecar is tracked.

`npm run test:farmbot` rebuilds the database, computes the canonical digest,
and compares it with the tracked sidecar. The test is scoped to the FarmBot
tree and is not part of `npm run verify` or `npm run smoke`.

## Reproducibility

The same submodule pin, the same extract code, and the same pinned DuckDB
version produce the same canonical digest. The build does not read the
clock, the host name, or any environment-specific value, and it inserts rows
in a fixed order. The output file name is always `farmbot.duckdb`.

The canonical digest is SHA-256 over a stable dump, not over the `.duckdb`
file. The dump format (`farmbot-canonical-v1`) is: every base table in name
order; for each table, the column names in ordinal order, then every row
ordered by those columns, as JSON. The extract script writes this digest to
the sidecar after each successful build. To check a downloaded copy, rebuild
or run:

```sh
node --input-type=module -e "import { canonicalDigest } from './farmbot/scripts/extract.mjs'; const d = await canonicalDigest('farmbot/dist/farmbot.duckdb'); const fs = await import('node:fs'); const expected = fs.readFileSync('farmbot/dist/farmbot.duckdb.sha256', 'utf8').trim(); if (d !== expected) { console.error('canonical digest mismatch'); process.exit(1); } console.log(d);"
```

`npm run test:farmbot` performs the same check, including a rebuild.

## What the extract contains

| Table | Contents |
| --- | --- |
| `part` | One row per BOM part page with a `quantity` key (149 rows). `quantity_standard` and `quantity_xl` are per-kit totals across variants; the raw pipe-delimited values are kept in the `_raw` columns. |
| `part_variant` | Positional variant rows for the part pages with a pipe-delimited `variants` field. |
| `bom_category` | BOM category index pages and their part counts. |
| `assembly_page`, `assembly_reference` | Top-level assembly chapters and every `[[part name]]` reference. |
| `preassembly_page` | Pre-assembly pages with `machine_readable`, a reason, PDF count, and reference count. PDF-only pages are recorded as not machine-readable; no OCR is performed. |
| `preassembly_reference` | Components from Markdown component tables and component lists. |
| `packing_page`, `packing_item` | Packing-list rows, including nested screw-pack components with their own quantities. |
| `quantity_comparison` | Packing-list quantity sums compared with part-page quantities, per page and version. |
| `quantity_difference` | The subset of comparisons whose plain-count quantities disagree. |
| `unmatched_name` | Display names that did not resolve, with source counts and diagnostic candidates. |
| `extract_metadata` | Source pin, source label, schema version, row counts, and DuckDB version. |

Name matching rules and the meaning of `not_comparable` are documented in
`farmbot/docs/name-normalization.md`.

## Short-term distribution: CI artifact

The `farmbot` job in `.github/workflows/ci.yml` checks out the submodule,
installs dependencies, runs `npm run test:farmbot`, and uploads both files as
the `farmbot-duckdb` artifact with 90 days of retention. The job uses
SHA-pinned checkout, setup-node, and upload-artifact actions.

The artifact is suitable for review and short-lived use. It expires, so it is
not the lasting distribution channel.

## Lasting distribution: Cloudflare R2

The canonical object keys are:

```text
farmbot/v1.7/44e0fa24d4a538dfa1255a4e89308ccabf3abaeb/farmbot.duckdb
farmbot/v1.7/44e0fa24d4a538dfa1255a4e89308ccabf3abaeb/farmbot.duckdb.sha256
```

Upload is a maintainer step. It is not performed by CI, by the extract script,
or by this repository's application code. The bucket and its access policy are
maintained outside this task; no Worker configuration or `wrangler.jsonc`
change is required to publish the objects.

One upload procedure with an S3-compatible client:

```sh
export R2_ENDPOINT="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
export R2_BUCKET="<BUCKET_NAME>"
# Provide credentials through the client's normal environment or profile.
aws s3 cp farmbot/dist/farmbot.duckdb \
  "s3://${R2_BUCKET}/farmbot/v1.7/44e0fa24d4a538dfa1255a4e89308ccabf3abaeb/farmbot.duckdb" \
  --endpoint-url "${R2_ENDPOINT}"
aws s3 cp farmbot/dist/farmbot.duckdb.sha256 \
  "s3://${R2_BUCKET}/farmbot/v1.7/44e0fa24d4a538dfa1255a4e89308ccabf3abaeb/farmbot.duckdb.sha256" \
  --endpoint-url "${R2_ENDPOINT}"
```

Before uploading, run `npm run test:farmbot` and confirm that the tracked
`.sha256` file matches the canonical digest of the local database. After
uploading, download both objects and verify the digest again. Credentials
and endpoints stay in the maintainer's environment; they are never committed
to this repository.
