// Builds Ontographia WASM from pinned upstream and copies to public/assets/ontographia/.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PIN = '66120bee7f2d9c4a228f4911d5c5f6ebdb635daa';
const UPSTREAM = 'https://github.com/edgesentry/ontographia.git';
const root = resolve(import.meta.dirname, '..');
const src = join(root, '.cache', 'ontographia-src');
const out = join(root, 'public', 'assets', 'ontographia');
const wasmName = 'ontographia_wasm.wasm';

const run = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });

if (!existsSync(src)) {
  mkdirSync(join(root, '.cache'), { recursive: true });
  run('git', ['clone', UPSTREAM, src]);
}
run('git', ['fetch', '--depth', '1', 'origin', PIN], src);
run('git', ['checkout', '--detach', 'FETCH_HEAD'], src);

try {
  run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
} catch {
  // target may already be installed
}

// Match upstream examples/plm/browser-spike/scripts/build-wasm.sh profile; add --locked.
run(
  'cargo',
  ['build', '-p', 'ontographia-wasm', '--release', '--target', 'wasm32-unknown-unknown', '--locked'],
  src,
  {
    CARGO_PROFILE_RELEASE_OPT_LEVEL: 'z',
    CARGO_PROFILE_RELEASE_LTO: 'true',
    CARGO_PROFILE_RELEASE_PANIC: 'abort',
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
    CARGO_PROFILE_RELEASE_STRIP: 'symbols',
  },
);

const built = join(src, 'target', 'wasm32-unknown-unknown', 'release', wasmName);
if (!existsSync(built)) throw new Error(`missing built wasm at ${built}`);

mkdirSync(out, { recursive: true });
cpSync(built, join(out, wasmName));
const bytes = readFileSync(join(out, wasmName));
const manifest = {
  upstream: UPSTREAM,
  pin: PIN,
  file: wasmName,
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  build: {
    package: 'ontographia-wasm',
    target: 'wasm32-unknown-unknown',
    locked: true,
    profile_env: [
      'CARGO_PROFILE_RELEASE_OPT_LEVEL=z',
      'CARGO_PROFILE_RELEASE_LTO=true',
      'CARGO_PROFILE_RELEASE_PANIC=abort',
      'CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1',
      'CARGO_PROFILE_RELEASE_STRIP=symbols',
    ],
  },
};
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Prepared', manifest);
