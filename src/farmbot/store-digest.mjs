// The store digest shown on /farmbot/.
//
// The committed release manifest is the single source of truth for the three
// release digests. This module only reads it, so the screen cannot drift from
// the file that the release assets are checked against.

import manifest from '../../farmbot/dist/farmbot.release.json' with { type: 'json' };

export const STORE_DIGEST_FORMAT = manifest.relateStore.digestFormat;
export const STORE_SHA256_HEX = manifest.relateStore.sha256;
export const STORE_DIGEST = `${STORE_DIGEST_FORMAT} sha256:${STORE_SHA256_HEX}`;
export const STORE_NODES = manifest.relateStore.nodes;
export const STORE_RELATIONSHIPS = manifest.relateStore.relationships;
