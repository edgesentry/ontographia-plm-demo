// Sort object keys recursively so a serialized result is byte-stable.
//
// Arrays keep their order. The rules sort their arrays explicitly by a
// documented key before serialization.

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

/**
 * Pretty-print a value with sorted keys and one trailing newline.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
