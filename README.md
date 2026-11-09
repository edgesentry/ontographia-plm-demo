# ontographia-plm-demo

Static, in-browser PLM demo (Deskfan bracket EOL / ECO) built on [Ontographia](https://github.com/edgesentry/ontographia). Vite + React + TypeScript, ja/en UI. This stage (#1) only **compiles a fixed Intent into Cypher**; it does not analyse or execute any graph.

## Setup

```bash
npm ci
```

## Prepare WASM

Builds the WASM from the pinned upstream commit (`66120bee…`, `cargo --locked`) and writes `public/assets/ontographia/` plus `manifest.json`. The `.wasm` is not committed.

```bash
npm run prepare:wasm
```

## Verify

Typecheck, data/i18n checks, WASM smoke test, and build.

```bash
npm run verify
```

## Pages

Deploy the `dist/` folder only (`npm run build` after prepare). `public/_headers` carries the CSP.

Vendored data and binding live in `vendor/ontographia/` (see `PROVENANCE.md`).
