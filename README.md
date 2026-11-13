# ontographia-plm-demo

Static, in-browser PLM demo (desk-fan bracket EOL / ECO) built on
[Ontographia](https://github.com/edgesentry/ontographia). Vite + React + TypeScript, ja/en UI.

Phase 1 (#2) is an **Intent-driven traversal over a vendored fixture graph**. The WASM engine
compiles each chip's Intent into parameter-bound Cypher and the HUD shows that string as an audit
artifact. **The Cypher is not executed.** Results come from a small in-browser Intent executor
(`src/lib/executor.ts`) that walks `vendor/ontographia/data/fixtures/deskfan_eol.graph.json`; there is
no graph database, no server call, and no server-side LLM.

Phase 2 (#3) adds an optional **free-text** path. After an explicit consent step, a
`Llama-3.2-1B-Instruct-q4f16_1-MLC` model runs locally in the browser through
[`@mlc-ai/web-llm`](https://www.npmjs.com/package/@mlc-ai/web-llm). The model is asked for Intent JSON
only, never Cypher, and its output is checked against an explicit Intent schema before the existing
`buildCypher` + `executeIntent` pipeline runs. Invalid JSON, unknown or missing fields, and Cypher
text are rejected without executing anything. **Prompts are not sent to an external inference API.**
Only the model files (weights and `model_lib`) are downloaded from the CSP allowlist, and only after
consent. The chip path never goes through the LLM.

- Four lanes, left to right: **EBOM, MBOM, SBOM, BOP**. The vendored fixture has no MBOM tags or
  nodes, so the MBOM lane is intentionally empty with a "not in this fixture" note.
- Five chips. Each `intent_path` in `chips.json` is resolved by filename only under
  `vendor/ontographia/data/intents/`.
- Only the start node and nodes actually reached by the Intent are highlighted. `lane_hints` can
  emphasize a lane but never add highlighted nodes.
- Cross-lane edges (`ORDERED_BY`, `CONSUMES`, `PRODUCES`, …) are listed separately and marked when
  they are on the current path.

## Setup

```bash
npm ci
npm run dev
```

The engine is the published npm package
[`@edgesentry/ontographia-wasm@0.1.9`](https://www.npmjs.com/package/@edgesentry/ontographia-wasm).
There is no git clone, `cargo` build, or WASM prepare step; Vite emits the package's `.wasm` as a
same-origin asset.

## Verify

One command (typecheck, data/i18n checks, WASM smoke, Intent-executor gold tests, Intent-schema
rejection tests, free-text prompt-set shape, WebLLM prompt/lazy-import guards, package/dist WASM
integrity, the FarmBot seed copy, the `_headers` CSP allowlist, production build of both entries):

```bash
npm run verify
```

The WASM smoke compiles all five Intents plus a malformed Intent (must reject) and checks that an ABI
other than `1` is rejected. The gold tests assert the fixture paths for all five chips, an
empty-result filter, malformed Intents, unsupported filter ops, and `limit`.

### FarmBot preset-question screen (`/farmbot/`)

A second Vite entry (`farmbot/index.html` → `src/farmbot/main.tsx`) serves a screen at `/farmbot/`
with the five FarmBot preset questions from `farmbot/intents/`. A Run compiles the selected Intent
with the same Ontographia package against `farmbot/ontology/farmbot.native.yaml`, applies the
documented post-compile `RETURN DISTINCT` step for Q2 and Q3 only (Ontographia 0.1.9 cannot express
`DISTINCT`; see `farmbot/intents/README.md`), and executes the parameter-bound Cypher in an in-memory
`new RelateDb()` seeded from the committed graph. Every string is Japanese and English.

The seed is fetched as raw bytes from `/farmbot/farmbot.seed.json` (copied from
`farmbot/dist/farmbot.seed.json` by a small Vite plugin, so there is no second committed copy) and its
SHA-256 is checked with Web Crypto before parsing; a mismatch stops the run and loads nothing.
`@relate/relate-wasm` and its WASM asset are imported only on the first Run, so first paint of
`/farmbot/` requests neither.

`npm run test:farmbot` includes tests for the digest guard, the shared `RETURN DISTINCT` step, the
ontology endpoint parser, the seed loader, and the five default questions. `npm run verify` builds
both entries and checks that `dist/farmbot/index.html` exists, that the served seed is byte-identical
to the committed seed, that both WASM assets match their installed packages by SHA-256, and that the
FarmBot entry's first-paint chunks contain no Relate engine code.

### FarmBot browser smoke (`/farmbot/`)

```bash
npx -y node@22 scripts/verify.mjs   # or a Node 22 `npm run build`; produces dist/
npm run smoke:farmbot
```

`npm run smoke:farmbot` drives the built `/farmbot/` entry in headless Playwright
Chromium (with a system Chrome fallback). It does not build; its local default
requires `dist/farmbot/index.html` and `dist/farmbot/farmbot.seed.json`. When
`SMOKE_BASE_URL` is unset it serves `dist/` itself on `SMOKE_PORT` (default
`4175`) and stops the server in a `finally` block. `vite preview` does not apply
`_headers` as HTTP headers, so the script's own server applies the `_headers`
rules from `dist/` to the responses it serves: the production CSP on `/*`,
`Content-Type: application/wasm` on `/assets/*.wasm`, and the immutable cache
rule on `/assets/*`. In that mode the smoke asserts that the document response
really carries the CSP, so "zero CSP violations" is not a vacuous result. For a
deployed origin, set `SMOKE_BASE_URL`; the script then uses that origin as the
site root and adds no headers of its own:

```bash
SMOKE_BASE_URL=https://<origin>/ npx -y node@22 scripts/smoke-farmbot.mjs
```

The run fails unless all of these hold: the five question chips are visible and
Ontographia is ready before the first Run; first paint requests neither the
Relate WASM asset nor the lazy Relate chunk; the page shows the committed seed
digest and a same-origin fetch of `/farmbot/farmbot.seed.json` hashes to it;
each of the five questions runs with its committed default selector value and
matches the committed gold file `farmbot/oracle/default-results.gold.json` row
for row (12 / 2 / 7 / 24 / 17 rows); Relate WASM is requested same-origin on the
first successful Run; a one-byte-tampered seed is rejected with the
expected/actual digest, loads no rows, and never requests Relate; every context
reports zero CSP violations and zero non-same-origin requests; and the
happy-path `pageerror` list is empty.

The gold file is generated, never hand-edited:

```bash
npx -y node@22 farmbot/scripts/gold-results.mjs
```

`npm run test:farmbot` includes a test that the committed gold still equals both
Relate and the SQL oracle, so the fixture cannot drift.

Timings come from `performance` marks around the engine work only: the whole
`openRelateSession` (seed fetch, digest check, Relate load, in-memory seed load)
and each `session.execute` call, excluding Ontographia compilation and React
render. The proposed budgets are 2000 ms for the seed load and 100 ms per query.
They are printed but not enforced; set `SMOKE_FARMBOT_ENFORCE_BUDGET=1` to fail a
run that misses one. The `farmbot-smoke` CI job runs the build and the smoke on
Node 22 without that variable.

Measured on 2026-11-13 on macOS 27.2.1 arm64, Node 22.23.5, Playwright 1.65.0
with its bundled Chromium 158.0.8127.18, from a local `npm run smoke:farmbot`
run against a local Node 22 production build. These are local numbers; no
CI-runner timings were observed.

| Artifact | raw bytes | `gzip -9 -n` bytes |
| --- | ---: | ---: |
| `dist/assets/ontographia_wasm-BOJRSUvY.wasm` | 512627 | 173885 |
| `dist/assets/relate_bg-9Q1Zsp67.wasm` | 6932319 | 2424791 |
| `dist/assets/relate-loader-C129q4jF.js` | 12367 | 4579 |
| `dist/assets/farmbot-DcVRHk05.js` | 38730 | 11896 |
| `dist/farmbot/farmbot.seed.json` | 364867 | 18135 |

Each row came from these two commands (substituting the file):

```bash
wc -c < dist/assets/ontographia_wasm-BOJRSUvY.wasm
gzip -9 -n -c dist/assets/ontographia_wasm-BOJRSUvY.wasm | wc -c
```

Smoke timings from that run:

| Measurement | ms | Proposed budget |
| --- | ---: | ---: |
| Seed fetch + digest + Relate load | 585.9 | 2000 |
| Q1 `session.execute` | 4.2 | 100 |
| Q2 `session.execute` | 3.8 | 100 |
| Q3 `session.execute` | 3.2 | 100 |
| Q4 `session.execute` | 1.5 | 100 |
| Q5 `session.execute` | 0.8 | 100 |

### Browser smoke

```bash
npm run verify       # produces dist/
npm run smoke
```

The smoke starts `vite preview`, launches Playwright Chromium (or system Chrome if Chromium is not
installed), and checks all five chips: highlights, HUD Intent/Cypher/params/results, the Verified
badge, ja/en toggle state retention, same-origin `application/wasm` fetch, no outbound requests, and
mobile wrapping without horizontal clipping. It also checks the free-text consent gate (no Hugging
Face or lazy-model request before consent), the WebGPU-missing notice with a working chip path, and
rejection of invalid Intent output through a test-only stub of the lazy model chunk. The same stub
checks the Convert → Run gate (Convert shows a proposal with no execution, no Verified badge, and no
highlights until Run), remembered-consent first paint (zero model-host or lazy-chunk requests), and
Cancel during model loading (returns to the cached view and keeps a finished chip result). The smoke
never downloads the model.

### WebGPU model smoke

`npm run smoke` and `npm run verify` never download the model. To check the real download in a
headed WebGPU browser, run the dedicated script:

```bash
npm run verify                 # or npm run build, produces dist/
npm run smoke:webgpu
```

Against the live deploy, skip `dist/` and `vite preview`:

```bash
SMOKE_BASE_URL=https://ontographia-plm-demo.egdesentry.workers.dev/ npm run smoke:webgpu
```

`smoke:webgpu` launches the system Google Chrome channel headed (Chrome's bundled WebGPU/Metal
adapter, not Playwright's Chromium) and fails if Chrome or a WebGPU adapter is unavailable. It
clicks the consent button, waits up to four minutes for the model to become ready, and then asserts
that the model weights came from the Hugging Face model hosts (`huggingface.co`, `*.hf.co`) and the
`model_lib` WASM came from `raw.githubusercontent.com`, with no failed model-host request and zero
CSP violations. It does not type a prompt or click Convert/Run, and it exits as soon as the model is
ready or on the first failure.

Every run uses a fresh temporary Chrome profile that is deleted afterwards, so each run performs the
full download again (about 695 MB). This needs headed system Chrome with WebGPU (a Mac with Chrome is
fine). It is not part of `npm run verify`, not part of `npm run smoke`, and not run in CI, because CI
runners have no WebGPU and must not download the model.

### Free-text (in-browser WebLLM)

The free-text panel is off until you choose **Download and load model**. The consent card shows:

| Item | Value |
| --- | --- |
| Model | `Llama-3.2-1B-Instruct-q4f16_1-MLC` |
| GPU memory | 879.04 MB (WebLLM `prebuiltAppConfig.vram_required_MB`) |
| Download | 695,242,752 bytes, about 695 MB (documented Hugging Face `usedStorage`, not measured here) |

The model chunk and weights are never loaded on first paint. After the first download, a later visit
can load the browser-cached model without asking for consent again, but it still does not download on
first paint. Progress and a cancel action are shown while loading. WebGPU is required: when
`navigator.gpu` is absent or `requestAdapter()` fails, free-text is disabled with a ja/en notice and
all five chips keep working. There is no CPU, WASM, or server fallback for the model.

Conversion is a two-step, explicit confirm flow. **Convert** asks the model for Intent JSON, validates
it, compiles it, and shows a proposal: the matched one of the five templates (with its chip label and
description) or a "modified / custom Intent" notice, plus the start → traverse path. Nothing runs at
this point — no Verified badge, no HUD results, and no swimlane highlights. **Run** executes the
proposal through the existing `buildCypher` + `executeIntent` path; **Cancel** discards it and leaves
an already-finished result untouched. This confirm step is the gate for schema-valid misrouting; it is
not a semantic check.

The CSP in `public/_headers` allows only same-origin resources plus these exact origins for the
optional model:

- `https://huggingface.co` — model repository metadata and small model files
- `https://us.aws.cdn.hf.co` — the observed weight-shard redirect target
- `https://raw.githubusercontent.com` — the model_lib WebGPU WASM

`worker-src` is `'self' blob:` because WebLLM runs in workers created from blob URLs. `script-src`
stays `'self' 'wasm-unsafe-eval'`; the npm package is bundled, not loaded from a CDN.

The model runs locally in the tab and the prompt is never sent to an external inference API. The
system prompt contains the five supported Intent templates (the same vendored gold files) and asks
the model to copy the closest one; WebLLM's JSON-constrained decoding keeps the output in the Intent
shape. This is a deliberately closed-set demo, so free-text maps to one of the five chip Intents. The
explicit schema checker still runs on every output, and anything that fails it (or Cypher text) is
rejected before compilation or execution.

`vendor/ontographia/data/intents/` has a fixed local prompt set under `src/data/intentPromptSet.ts`
with at least one Japanese and one English paraphrase for each of the five gold Intents. It is a
small regression/demo check, **not a benchmark**, and it is not run in CI. `scripts/eval-intents.mjs`
can run it locally on a WebGPU machine; it downloads the model once and is not part of `npm run
verify` or `npm run smoke`.

On a machine without Playwright's browser bundle:

```bash
npx playwright install chromium
```

### Live smoke

To run the same assertions against a deployed Worker, set `SMOKE_BASE_URL`:

```bash
npm run smoke:live
```

or equivalently:

```bash
SMOKE_BASE_URL=https://ontographia-plm-demo.egdesentry.workers.dev/ npm run smoke
```

`npm run smoke:live` defaults to the production Workers URL. `SMOKE_BASE_URL` can also point at a
preview deploy URL. Setting it skips `vite preview` (no local server is started) and does not require
a local `dist/`; the browser drives the given URL directly. Leaving `SMOKE_BASE_URL` unset keeps
`npm run smoke` unchanged: it builds nothing itself, requires `dist/`, and serves it through
`vite preview` on `SMOKE_PORT` (default `4173`). The WASM failure case uses Playwright
`route.abort()` on `**/*.wasm`, so it runs in both local and live modes.

## Deploy

Deployment targets Cloudflare Workers with static assets via Workers Builds (Git integration), not
Cloudflare Pages. `npm run build` emits `dist/`; `public/_headers` is copied into `dist/` by Vite and
is honored by Workers Assets, where it carries the CSP, the `application/wasm` content type, and
immutable caching for hashed `/assets/*`. The `_headers` file itself is not served. Deployment is a
maintainer step; CI does not deploy.

`wrangler.jsonc` at the repo root is an assets-only Worker config: it has no `main` script, serves
`./dist`, and deliberately omits `not_found_handling` so unknown paths return `404` instead of
falling back to `index.html` (this app has no client-side routes).

Once this lands on `main`, connect the repository in the dashboard via **Workers & Pages → Create an
application → Workers → Connect to Git** and use these values:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | repository root (leave default) |
| Production branch | `main` |
| Build variable `NODE_VERSION` | `22` (Settings > Build > Build Variables and Secrets) |

The Worker name must match `name` in `wrangler.jsonc` (`ontographia-plm-demo`), otherwise the build
fails. Preview builds can be enabled for non-`main` branches; the default preview command is
`npx wrangler preview`.

### Checking that a merge went live

Every push to `main` should start a build in the Worker's **Deployments** list. To confirm a merge is
live, compare the hashed bundle name served at `/` (`assets/index-*.js`) before and after the build,
then run `npm run smoke:live`. If no new build appears after a merge, the Git connection is not
triggering builds: in **Settings > Builds**, disconnect and reconnect the repository with the
production branch `main`, and check that the Cloudflare Workers and Pages GitHub App still has
access to this repository. The app must be installed on the `edgesentry` organization (not only on a
personal account) with this repository selected under Repository access; otherwise pushes never reach
Workers Builds. Reconnecting alone does not start a build; trigger one with any new commit on `main`.

## Data and audit

Demo ontology data (COM, chips, intents, fixtures) lives in `vendor/ontographia/data/` and is kept in
this repo; see `vendor/ontographia/PROVENANCE.md`. The topic is the desk-fan bracket EOL/ECO.

`npm audit` currently reports esbuild/vite advisories that require a major Vite upgrade (Vite 5 is the
latest 5.x line). They are devDependencies only and are not part of the built `dist/` bundle; the
upgrade is tracked separately.
