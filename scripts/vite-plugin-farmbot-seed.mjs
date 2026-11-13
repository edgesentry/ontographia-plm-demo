// Copy the committed FarmBot seed next to the /farmbot/ entry at build time and
// serve the same bytes from the dev server.
//
// The page fetches these bytes and verifies their SHA-256 before loading them
// into Relate, so the file must stay byte-identical to
// farmbot/dist/farmbot.seed.json. It is copied from that committed path rather
// than committed again under public/.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEED_SOURCE = 'farmbot/dist/farmbot.seed.json';
const SEED_OUTPUT = 'farmbot/farmbot.seed.json';
const SEED_DEV_URL = '/farmbot/farmbot.seed.json';

export function farmbotSeed() {
  let root = process.cwd();

  return {
    name: 'farmbot-seed',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0];
        if (path !== SEED_DEV_URL) {
          next();
          return;
        }
        try {
          const bytes = readFileSync(resolve(root, SEED_SOURCE));
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Content-Length', String(bytes.length));
          response.setHeader('Cache-Control', 'no-store');
          response.end(bytes);
        } catch (error) {
          next(error);
        }
      });
    },
    generateBundle() {
      const bytes = readFileSync(resolve(root, SEED_SOURCE));
      this.emitFile({ type: 'asset', fileName: SEED_OUTPUT, source: bytes });
    },
  };
}
