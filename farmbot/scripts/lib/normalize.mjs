// Display-name normalization and matching for the pinned FarmBot Genesis
// extract. The rules are documented in farmbot/docs/name-normalization.md.

export function normalizeName(name) {
  let value = String(name ?? '').normalize('NFKC').toLowerCase();
  value = value.replace(/[×✕]/g, 'x').replace(/[‐‑‒–—―]/g, '-');
  value = value.replace(/\bw\/\s*/g, 'with ');
  // Parenthetical suffixes such as "(1.7m)" are descriptive, not part of the
  // name. Repeat to handle nesting.
  let previous;
  do {
    previous = value;
    value = value.replace(/\([^)]*\)/g, ' ');
  } while (value !== previous);
  value = value.replace(/\[[^\]]*\]/g, ' ');
  value = value.replace(/&/g, ' and ');
  value = value.replace(/[^a-z0-9]+/g, ' ').trim();
  return value.replace(/\s+/g, ' ');
}

export function singularizeName(name) {
  const words = normalizeName(name).split(' ').filter(Boolean);
  if (words.length === 0) return '';
  const last = words[words.length - 1];
  if (last.length > 3 && last.endsWith('s') && !last.endsWith('ss')) {
    words[words.length - 1] = last.slice(0, -1);
  }
  return words.join(' ');
}

function add(map, key, partName) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(partName);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function buildPartIndex(parts) {
  const exact = new Map();
  const folded = new Map();
  const normalized = new Map();
  const singular = new Map();

  for (const part of parts) {
    exact.set(part.name, part.name);
    add(folded, part.name.toLowerCase(), part.name);
    add(normalized, normalizeName(part.name), part.name);
    add(singular, singularizeName(part.name), part.name);
  }

  return { exact, folded, normalized, singular };
}

function lookup(map, key) {
  const values = map.get(key);
  if (!values || values.length === 0) return { status: 'none', values: [] };
  if (values.length === 1) return { status: 'one', values };
  return { status: 'ambiguous', values: uniqueSorted(values) };
}

// Diagnostic candidates only. These are never used to resolve a reference.
function nearCandidates(name, parts) {
  const keys = new Set([normalizeName(name), singularizeName(name)]);
  const padded = [...keys].filter(Boolean).map((key) => ` ${key} `);
  if (padded.length === 0) return [];
  return uniqueSorted(
    parts
      .filter((part) => {
        const candidate = ` ${normalizeName(part.name)} `;
        const candidateSingular = ` ${singularizeName(part.name)} `;
        return padded.some(
          (query) => candidate.includes(query) || candidateSingular.includes(query),
        );
      })
      .map((part) => part.name),
  ).slice(0, 5);
}

export function resolveName(name, index, parts) {
  if (index.exact.has(name)) {
    return { partName: index.exact.get(name), method: 'exact', candidates: [] };
  }

  const folded = lookup(index.folded, String(name).toLowerCase());
  if (folded.status === 'one') {
    return { partName: folded.values[0], method: 'case-insensitive', candidates: [] };
  }
  if (folded.status === 'ambiguous') {
    return { partName: null, method: 'ambiguous', candidates: folded.values };
  }

  const normalizedKey = normalizeName(name);
  const normalized = lookup(index.normalized, normalizedKey);
  if (normalized.status === 'one') {
    return { partName: normalized.values[0], method: 'normalized', candidates: [] };
  }
  if (normalized.status === 'ambiguous') {
    return { partName: null, method: 'ambiguous', candidates: normalized.values };
  }

  const singularKey = singularizeName(name);
  const singular = lookup(index.singular, singularKey);
  if (singular.status === 'one') {
    return { partName: singular.values[0], method: 'singular', candidates: [] };
  }
  if (singular.status === 'ambiguous') {
    return { partName: null, method: 'ambiguous', candidates: singular.values };
  }

  return {
    partName: null,
    method: 'unmatched',
    candidates: nearCandidates(name, parts),
  };
}

// For table items, the cell text can carry a qualifier in front of the link,
// for example "X-Axis [[Cable Carrier]]". Only use the qualifier when the raw
// display name does not resolve on its own.
export function resolveWithQualifier(displayName, qualifier, index, parts) {
  const raw = resolveName(displayName, index, parts);
  if (raw.partName || !qualifier) return raw;

  const cleaned = qualifier.trim();
  if (!cleaned) return raw;
  if (normalizeName(cleaned) === normalizeName(displayName)) return raw;

  const qualified = resolveName(cleaned, index, parts);
  if (qualified.partName) {
    return {
      partName: qualified.partName,
      method: `qualified-${qualified.method}`,
      candidates: [],
    };
  }
  return raw;
}
