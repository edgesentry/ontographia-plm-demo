// Read a Relate node value as its property map.
//
// Relate returns a whole node as `{ id, kind, labels, properties }`. The seed id
// is carried inside `properties.id`, the same field the seed loader writes.
// Throwing here means a check Intent projected something other than a node,
// which would make every evidence row unresolvable.

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function nodeProperties(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (/** @type {{ properties?: unknown }} */ (value).properties) !== 'object'
  ) {
    throw new Error('expected a whole-node value with a properties map');
  }
  return /** @type {{ properties: Record<string, unknown> }} */ (value).properties;
}

/**
 * Return the seed node id carried by a whole-node value.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function nodeId(value) {
  const properties = nodeProperties(value);
  if (typeof properties.id !== 'string' || properties.id.length === 0) {
    throw new Error('node value has no seed id');
  }
  return properties.id;
}
