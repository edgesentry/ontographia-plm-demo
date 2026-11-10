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

## Deploy

Deploy the `dist/` folder to Cloudflare Pages (`npm run build`). `public/_headers` carries the CSP,
the `application/wasm` content type, and immutable caching for hashed `/assets/*`. Deployment is a
maintainer step; CI does not deploy.

## Data and audit

Demo ontology data (COM, chips, intents, fixtures) lives in `vendor/ontographia/data/` and is kept in
this repo; see `vendor/ontographia/PROVENANCE.md`. The topic is the desk-fan bracket EOL/ECO.

`npm audit` currently reports esbuild/vite advisories that require a major Vite upgrade (Vite 5 is the
latest 5.x line). They are devDependencies only and are not part of the built `dist/` bundle; the
upgrade is tracked separately.
