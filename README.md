# ontographia-plm-demo

Static, in-browser PLM demo (desk-fan bracket EOL / ECO) built on
[Ontographia](https://github.com/edgesentry/ontographia). Vite + React + TypeScript, ja/en UI.

Phase 1 (#2) is an **Intent-driven traversal over a vendored fixture graph**. The WASM engine
compiles each chip's Intent into parameter-bound Cypher and the HUD shows that string as an audit
artifact. **The Cypher is not executed.** Results come from a small in-browser Intent executor
(`src/lib/executor.ts`) that walks `vendor/ontographia/data/fixtures/deskfan_eol.graph.json`; there is
no graph database, no server call, and no LLM.

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

One command (typecheck, data/i18n checks, WASM smoke, Intent-executor gold tests, package/dist WASM
integrity, `_headers` checks, production build):

```bash
npm run verify
```

The WASM smoke compiles all five Intents plus a malformed Intent (must reject) and checks that an ABI
other than `1` is rejected. The gold tests assert the fixture paths for all five chips, an
empty-result filter, malformed Intents, unsupported filter ops, and `limit`.

### Browser smoke

```bash
npm run verify       # produces dist/
npm run smoke
```

The smoke starts `vite preview`, launches Playwright Chromium (or system Chrome if Chromium is not
installed), and checks all five chips: highlights, HUD Intent/Cypher/params/results, the Verified
badge, ja/en toggle state retention, same-origin `application/wasm` fetch, no outbound requests, and
mobile wrapping without horizontal clipping.

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
