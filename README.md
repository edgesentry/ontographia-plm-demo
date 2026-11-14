# ontographia-plm-demo

Static, in-browser PLM graph queries with Ontographia and Relate by Neo4j.

## Use case

Exploring and auditing product lifecycle management (PLM) data for the open-source [FarmBot Genesis v1.7](https://github.com/FarmBot-Docs/farmbot-genesis) hardware project across engineering bills of materials (EBOM) and manufacturing bills of materials (MBOM) / assembly documentation:

- **Packing differences**: Detecting discrepancies between the packing list and the BOM (e.g. quantity mismatches).
- **Assembly chapters for a part**: Identifying which assembly chapters use a specific part to assess change impact.
- **Structures a part reaches**: Forward-tracing which manufacturing structures and pre-assembly tools reach a part.
- **Kit parts in a category**: Listing kit parts that belong to a specific functional category.
- **Unmatched references**: Surfacing manufacturing references that did not resolve to a canonical part page.

High-level questions expressed as Ontographia Intents compile into parameter-bound Cypher queries and execute in Relate.

## How it uses Relate

- Mode: in memory (browser screen at `/farmbot/`) | directory store (inspectable build output)
- Why this mode: A browser tab has no filesystem, so the interactive `/farmbot/` screen runs `@relate/relate-wasm` 1.0.1 in `:memory:`. The committed seed graph is fetched from `/farmbot/farmbot.seed.json`, verified by SHA-256 with Web Crypto against the committed digest, and loaded into an in-memory database that exists only in that tab. Relate WASM is lazily imported only on the first Run (not on first paint). For offline inspection, the same seed is compiled into a persistent Relate directory store using Node `@relate/relate` 1.0.1 with the JSON snapshot codec (`RELATE_SNAPSHOT_FORMAT=json`). Reviewers can inspect `graph.json` directly as plain JSON or open the directory store read-only from Node without running a browser or database daemon.
- What the graph models: FarmBot Genesis v1.7 EBOM and MBOM data, including BOM parts, part variants, BOM categories, product variants, assembly chapters, pre-assembly pages, kits, the main carton, bags, usage lines, packing-versus-BOM quantity comparisons, quantity differences, and unresolved references. The logical store contains 604 nodes and 1022 relationships. Node labels include `Part`, `PartVariant`, `BomCategory`, `ProductVariant`, `AssemblyChapter`, `PreAssembly`, `Kit`, `Carton`, `Bag`, `Usage`, `QuantityComparison`, `QuantityDifference`, and `UnmatchedName`, along with abstract labels `Item`, `Structure`, `ManufacturingContainer`, and `Correspondence` that concrete nodes also carry.

Relationship types and counts (from the logical dump):

| Type | Count | Type | Count |
| --- | ---: | --- | ---: |
| `HAS_USAGE` | 279 | `USES_ITEM` | 257 |
| `IN_CATEGORY` | 149 | `COMPARED_IN` | 76 |
| `COMPARES_PART` | 76 | `FOR_VARIANT` | 76 |
| `HAS_PART_VARIANT` | 44 | `APPLIES_TO` | 38 |
| `SEEN_IN` | 17 | `CANDIDATE` | 10 |

The browser screen does not execute against the unpacked directory store; it executes queries against the in-memory database and displays the committed store logical digest and node/relationship counts from `farmbot/dist/farmbot.release.json`.

## Setup and run

### Prerequisites

- Node >=22 (or use `npx -y node@22`)
- npm

### Run locally

```bash
npm ci
npm run dev
```

Open <http://localhost:5173/farmbot/> to access the FarmBot query screen.

### Run tests and smoke

To build and run the browser smoke suite against a local production build:

```bash
npx -y node@22 scripts/verify.mjs
npm run smoke:farmbot
```

`npm run smoke:farmbot` requires `dist/` and checks the five preset questions against `farmbot/oracle/default-results.gold.json`.

### Live demo

- Live demo: <https://ontographia-plm-demo.egdesentry.workers.dev/> (HTTP 200 confirmed 2026-11-14)
- FarmBot query screen: <https://ontographia-plm-demo.egdesentry.workers.dev/farmbot/>

To run the browser smoke suite against the live deployment:

```bash
SMOKE_BASE_URL=https://ontographia-plm-demo.egdesentry.workers.dev/ npx -y node@22 scripts/smoke-farmbot.mjs
```

### Preset questions

The screen provides five preset questions with localized labels (`src/farmbot/i18n.ts`):

- **Q1 · Packing differences** — "Which parts disagree between the packing list and the BOM?" — 12 rows — no selector — columns: `part`, `packing_minus_part`
- **Q2 · Assembly chapters for a part** — "Which assembly chapters use this part?" — default filter: `M5 x 10mm Screw` — 2 rows — DISTINCT applied after compile
- **Q3 · Structures a part reaches** — "If this part changes, which structures reach it?" — default filter: `M5 Flange Locknut` — 7 rows — DISTINCT applied after compile
- **Q4 · Kit parts in a category** — "Which kit parts belong to this category?" — default filter: `fasteners-and-hardware` — 24 rows
- **Q5 · Unmatched references** — "Which references did not resolve to a part page?" — 17 rows (13 distinct `display_name` values) — filter `status = unmatched` is embedded in the Intent, no on-screen selector

*Note on query compilation*: Ontographia 0.1.9 cannot express `DISTINCT`; Q2 and Q3 receive a documented post-compile `RETURN DISTINCT` step. Q1, Q4, and Q5 are not modified. Q1 projects only `part` and `packing_minus_part`. Quantity differences are reported, not corrected.

## Where the data lives

The committed seed and sidecar digests live in `farmbot/dist/`:

- Seed file: `farmbot/dist/farmbot.seed.json` (364867 bytes) and sidecar `farmbot/dist/farmbot.seed.json.sha256`
- DuckDB extract sidecar: `farmbot/dist/farmbot.duckdb.sha256` (the DuckDB file itself is a build output and is gitignored)
- Release manifest: `farmbot/dist/farmbot.release.json` (format `farmbot-release-manifest-v1`)

The directory store and DuckDB extract are gitignored under `farmbot/dist/.gitignore` (`*.duckdb`, `farmbot.relate-store/`, `farmbot-relate-store.tar.gz`).

### Cryptographic digests

| Artifact | Digest |
| --- | --- |
| Committed seed | `farmbot-graph-v1 sha256:db6503e0c17d024d610736b0996c98a2872b495936d4f84230747db603f36fb1` |
| DuckDB extract | `farmbot-canonical-v1 sha256:6c32e7067b21679531fd7b6959670b76dcad461227137c96e54078a70ac3ee84` |
| Relate store (logical) | `farmbot-relate-store-v2 sha256:c44248c23f4800f20c0d456924d930e09e8dd0bb76080fdbd63375bd4b52b7fc` |

- The seed digest is the SHA-256 of the committed file bytes.
- The DuckDB digest is a canonical dump of all tables, not the file bytes.
- The Relate store digest is a canonical logical dump (`farmbot-relate-store-v2`) over all nodes and relationships (documented in `farmbot/docs/relate-store.md`). The archive bytes can differ between builds; judges should verify the logical store digest rather than assuming byte-identical tar.gz archives.

### GitHub Release assets

GitHub Release `farmbot-data-v1`: <https://github.com/edgesentry/plm-relate-ontographia-demo/releases/tag/farmbot-data-v1>  
Target commit: `6aa2bc5cd595d23bf1d742d64b5963ae7b45da6b`

| Asset | Size | Role |
| --- | ---: | --- |
| `farmbot-relate-store.tar.gz` | 21847 bytes | Relate persistent directory store archive |
| `farmbot.duckdb` | 5517312 bytes | DuckDB canonical extract database |
| `farmbot.release.json` | 801 bytes | Release manifest |
| `SHA256SUMS` | 262 bytes | Checksums of release assets |

### Third-party provenance and licenses

- Project license: Apache-2.0 at `LICENSE`
- FarmBot Genesis documentation source: submodule pinned at `44e0fa24d4a538dfa1255a4e89308ccabf3abaeb` (Genesis v1.7, also recorded in `farmbot/dist/farmbot.release.json`). Third-party notice: MIT in `farmbot/notices/LICENSE`.
- Ontographia demo data provenance: `vendor/ontographia/PROVENANCE.md` (Apache-2.0).

## Pre-event code used in this submission

This section provides a factual list of what was already in the repository before the Contest Period, and what was added during it.

### Hackathon context

- Hackathon: Relate by Neo4j Hackathon
- Overview: <https://relate.devpost.com/>
- Official Rules: <https://relate.devpost.com/rules>
- Contest Period: Starts 6:00 PM PST on Wednesday, November 11, 2026, which is 2026-11-12 10:00 in Asia/Singapore. Ends 6:00 PM PST on Friday, December 11, 2026, which is 2026-12-12 10:00 in Asia/Singapore.
- Public repository: <https://github.com/edgesentry/plm-relate-ontographia-demo>
- GitHub topics: `relate`, `relate-neo4j-hackathon`, `ontographia`

### Repository timeline

- Repository created at 2026-11-05 22:27 UTC, which is 2026-11-06 06:27 in Asia/Singapore, before the Contest Period start (2026-11-12 10:00 Asia/Singapore).
- First commit: `1c07d8e` Initial commit (2026-11-06 06:27 Asia/Singapore).
- 16 commits reached `main` before the Contest Period start. They include: Vite/React/TypeScript static scaffold (#1), `@edgesentry/ontographia-wasm` 0.1.9 from npm, the desk-fan EOL/ECO Intent-driven swimlane at `/` (#2), Cloudflare Workers static-assets deploy config, live smoke, ripple-pulse animation (#12), and in-browser WebLLM free-text to a validated Intent (#15, 2026-11-11 21:10 Asia/Singapore).
- 10 commits reached `main` on or after the Contest Period start, through `6aa2bc5`. They include: headed WebGPU model-download smoke (#17); FarmBot Genesis v1.7 submodule with provenance (#23, first FarmBot work, 2026-11-12 19:43 Asia/Singapore); DuckDB extract (#24); FarmBot ontology (#21 / #25); Phase 2a Relate spike, graph generator, preset Intents and oracle, `/farmbot/` screen, browser smoke, and persistent store / Release assets (PRs #33–#38). Release `farmbot-data-v1` was published from `6aa2bc5`.

The desk-fan screen at `/` and its WebLLM path remain in the repository. The work submitted for this hackathon's FarmBot / Relate demonstration is the `/farmbot/` screen, the committed seed, and the persistent Relate store published on Release `farmbot-data-v1`.

## Desk-fan demo

The repository retains the desk-fan EOL / ECO demonstration at `/`:

- **Traversal**: An Intent-driven traversal over a vendored fixture graph (`vendor/ontographia/data/fixtures/deskfan_eol.graph.json`).
- **Compilation without execution**: The WASM engine compiles each chip's Intent into parameter-bound Cypher shown in the HUD as an audit artifact. Cypher is not executed on a graph database; results come from a small in-browser Intent executor (`src/lib/executor.ts`).
- **Lanes**: Four lanes represent EBOM, MBOM, SBOM, and BOP (the fixture has no MBOM nodes or tags, so that lane displays a "not in this fixture" notice).
- **Optional in-browser WebLLM**: An optional free-text interface runs `Llama-3.2-1B-Instruct-q4f16_1-MLC` locally via `@mlc-ai/web-llm` in the browser tab:
  - Requires WebGPU and explicit user consent.
  - Memory and storage: 879.04 MB VRAM (from WebLLM `prebuiltAppConfig.vram_required_MB`); 695,242,752 bytes download (documented Hugging Face `usedStorage`, not measured here).
  - The model is asked for Intent JSON only, validated against an explicit Intent schema; it never outputs Cypher and prompts are never sent to external inference APIs.
  - Model weights and `model_lib` WASM are downloaded only after consent from the CSP allowlist in `public/_headers` (`https://huggingface.co`, `https://us.aws.cdn.hf.co`, `https://raw.githubusercontent.com`).
  - Two-step flow: **Convert** asks the model for Intent JSON, validates, compiles, and shows a proposal without execution; **Run** executes the proposal through `buildCypher` + `executeIntent`.
- **Smoke tests**:
  - `npm run smoke`: Headless Playwright Chromium smoke test for chips, HUD, ja/en toggle, CSP, and consent gate (uses a test stub; never downloads the model).
  - `npm run smoke:webgpu`: Headed system Chrome test that downloads the model to assert network transfers from allowlisted hosts and WebGPU initialization without typing prompts.
  - `npm run smoke:live`: Runs smoke tests against the deployed origin (`SMOKE_BASE_URL=https://ontographia-plm-demo.egdesentry.workers.dev/ npm run smoke`).

## Verify and smoke

### Verification suite

Run the comprehensive verification check:

```bash
npm run verify
```

`npm run verify` checks:
- TypeScript typecheck (`tsc --noEmit`)
- Data and i18n structure checks
- Ontographia WASM smoke compilation (all five Intents plus a malformed Intent, ABI rejection)
- Intent executor gold tests and schema rejection tests
- Free-text prompt-set shape and WebLLM prompt/lazy-import guards
- Package and dist WASM binary SHA-256 integrity
- FarmBot seed copy byte-identity between source and distribution
- CSP header allowlist rules in `public/_headers`
- Production builds of both entries (`dist/index.html` and `dist/farmbot/index.html`)

### FarmBot unit and oracle tests

```bash
npm run test:farmbot
```

Tests the SHA-256 digest guard, shared `RETURN DISTINCT` step, ontology endpoint parser, seed loader, and default questions against `farmbot/oracle/default-results.gold.json`.

### FarmBot browser smoke

```bash
npx -y node@22 scripts/verify.mjs
npm run smoke:farmbot
```

Drives headless Playwright Chromium to verify `/farmbot/`:
1. Question chips are visible and Ontographia is ready before first Run.
2. First paint requests neither Relate WASM asset nor lazy Relate chunk.
3. The page displays the committed seed digest, matching the SHA-256 of `/farmbot/farmbot.seed.json`.
4. All five preset questions execute with default selectors and match `farmbot/oracle/default-results.gold.json` row-for-row (12 / 2 / 7 / 24 / 17 rows).
5. Relate WASM is requested same-origin on the first successful Run.
6. A single-byte-tampered seed is rejected with expected and actual digests, loads no rows, and never requests Relate.
7. Zero CSP violations, zero non-same-origin network requests, and zero uncaught page errors.

### Local measurements and performance budgets

Measured on 2026-11-13 on macOS 27.2.1 arm64, Node 22.23.5, Playwright 1.65.0 with Chromium 158.0.8127.18, from a local `npm run smoke:farmbot` run against a local Node 22 production build. These are local numbers; no CI-runner timings were observed.

Artifact sizes (raw / `gzip -9 -n` bytes):

| Artifact | raw bytes | gzip -9 -n bytes |
| --- | ---: | ---: |
| `dist/assets/ontographia_wasm-BOJRSUvY.wasm` | 512627 | 173885 |
| `dist/assets/relate_bg-9Q1Zsp67.wasm` | 6932319 | 2424791 |
| `dist/assets/relate-loader-C129q4jF.js` | 12367 | 4579 |
| `dist/assets/farmbot-DcVRHk05.js` | 38730 | 11896 |
| `dist/farmbot/farmbot.seed.json` | 364867 | 18135 |

Timings from that local run:

| Measurement | ms | Proposed budget |
| --- | ---: | ---: |
| Seed fetch + digest + Relate load | 585.9 | 2000 |
| Q1 `session.execute` | 4.2 | 100 |
| Q2 `session.execute` | 3.8 | 100 |
| Q3 `session.execute` | 3.2 | 100 |
| Q4 `session.execute` | 1.5 | 100 |
| Q5 `session.execute` | 0.8 | 100 |

Budgets are printed in smoke output but not enforced unless `SMOKE_FARMBOT_ENFORCE_BUDGET=1`.

## Rebuild and inspect the Relate store

### Rebuilding from a fresh clone

```bash
git clone --recurse-submodules https://github.com/edgesentry/plm-relate-ontographia-demo.git
cd plm-relate-ontographia-demo
npm ci
npm run release:assets
npm run release:verify -- release-assets
```

`npm run release:assets` rebuilds the DuckDB file and the store (`RELATE_SNAPSHOT_FORMAT=json`), checks both digests and the counts against the committed manifest, and writes the release files plus `SHA256SUMS` into `release-assets/`.

To verify downloaded release assets:

```bash
npm run release:verify -- <dir>
```

### Opening the store read-only from Node

Extract `farmbot-relate-store.tar.gz` and open the directory; keep the `.cypherlite.lock` marker files, or the read-only open fails:

```bash
tar -xzf farmbot-relate-store.tar.gz
node --input-type=module -e "
import { createRequire } from 'node:module';
const { Database } = createRequire(import.meta.url)('@relate/relate');
const db = Database.open('farmbot.relate-store', { readOnly: true });
console.log(db.connect().query('MATCH (n) RETURN count(n) AS nodes').rows[0]);
"
```

`Database.open(dir, { readOnly: true })` opens the directory read-only. `farmbot/scripts/relate-store.mjs` exports `logicalDump(dir)` for the digest and `buildStore(dir)` for a rebuild.

### Maintainer: publishing the release

CI uploads the `farmbot-release-assets` artifact; it never creates a release. After a merge, download the artifact, verify it, and attach the files:

Release `farmbot-data-v1` already exists and targets `6aa2bc5cd595d23bf1d742d64b5963ae7b45da6b`. CI still uploads a `farmbot-release-assets` artifact after later merges; it never creates or updates the Release. To publish a new tag later:

```bash
gh run download <run-id> -n farmbot-release-assets -D release-assets
npm run release:verify -- release-assets
gh release create <tag> release-assets/* --target <merge-commit-sha> --title "..." --notes "..."
```

## Deploy

Deployment targets Cloudflare Workers with static assets via Workers Builds (Git integration), not Cloudflare Pages. `npm run build` emits `dist/`; `public/_headers` is copied into `dist/` by Vite and is honored by Workers Assets, where it carries the CSP, the `application/wasm` content type, and immutable caching for hashed `/assets/*`. Deployment is a maintainer step; CI does not deploy.

`wrangler.jsonc` at the repository root is an assets-only Worker configuration:
- Worker name: `ontographia-plm-demo`
- Assets directory: `./dist`
- Deliberately omits `not_found_handling` so unknown paths return 404 instead of falling back to `index.html`.

### Workers Builds settings

In Cloudflare Dashboard (**Workers & Pages → Create an application → Workers → Connect to Git**):

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | repository root (leave default) |
| Production branch | `main` |
| Build variable `NODE_VERSION` | `22` (Settings > Build > Build Variables and Secrets) |

### Checking that a merge went live

Every push to `main` starts a build in the Worker's Deployments list. To confirm a merge is live, compare the hashed bundle name served at `/` (`assets/index-*.js`) before and after the build, then run:

```bash
npm run smoke:live
```
