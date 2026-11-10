# ontographia-plm-demo

Static, in-browser PLM demo (Deskfan bracket EOL / ECO) built on [Ontographia](https://github.com/edgesentry/ontographia). Vite + React + TypeScript, ja/en UI. This stage (#1) only **compiles a fixed Intent into Cypher**; it does not analyse or execute any graph.

## Setup

```bash
npm ci
```

The engine is the published npm package [`@edgesentry/ontographia-wasm@0.1.9`](https://www.npmjs.com/package/@edgesentry/ontographia-wasm). There is no git clone, `cargo` build, or WASM prepare step; Vite emits the package's `.wasm` as a same-origin asset.

## Verify

Typecheck, data/i18n checks, npm-package WASM smoke test (all 5 demo Intents plus malformed-Intent rejection), and build.

```bash
npm run verify
```

## Pages

Deploy the `dist/` folder only (`npm run build`). `public/_headers` carries the CSP and the `application/wasm` content type.

Demo ontology data (COM, chips, intents, fixtures) lives in `vendor/ontographia/data/` and is kept in this repo; see `PROVENANCE.md`.
