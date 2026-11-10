# Provenance

## Engine / WASM binding

- Package: `@edgesentry/ontographia-wasm` `0.1.9` (exact pin in `package.json`)
- Registry: npm, published with provenance; dist-tag `latest` is `0.1.9`
- License: Apache-2.0
- Intake: installed from npm via `npm ci`; this repo does not clone a git pin and does not build the WASM with Cargo.

## Demo data

- Source: `edgesentry/ontographia`
- Pin: `66120bee7f2d9c4a228f4911d5c5f6ebdb635daa` (PR #159 merge)
- Intake: `data/*` (COM `plm.native.yaml`, `chips.json`, `intents/`, `fixtures/`) byte-copied from that pin and kept in this repo. The npm package does not ship demo data.
- License: Apache-2.0 (see `notices/LICENSE`)
