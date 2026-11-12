// Minimal reader for the YAML subset used by the pinned FarmBot Genesis
// frontmatter: top-level keys, one level of nested keys, and quoted scalars
// that may span multiple lines. It intentionally does not attempt to be a
// general YAML implementation.

function endsWithUnescapedQuote(value) {
  if (!value.endsWith('"')) return false;
  let backslashes = 0;
  for (let i = value.length - 2; i >= 0 && value[i] === '\\'; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}

function unescapeDoubleQuoted(value) {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function readScalar(lines, index, raw) {
  if (raw === '') return { value: '', consumed: 0 };
  if (raw.startsWith('"')) {
    let value = raw.slice(1);
    let consumed = 0;
    while (!endsWithUnescapedQuote(value) && index + consumed + 1 < lines.length) {
      consumed += 1;
      value += ` ${lines[index + consumed].trim()}`;
    }
    if (value.endsWith('"')) value = value.slice(0, -1);
    return { value: unescapeDoubleQuoted(value).trim(), consumed };
  }
  if (raw.startsWith("'")) {
    let value = raw.slice(1);
    let consumed = 0;
    while (!(value.endsWith("'") && !value.endsWith("\\'")) && index + consumed + 1 < lines.length) {
      consumed += 1;
      value += ` ${lines[index + consumed].trim()}`;
    }
    if (value.endsWith("'")) value = value.slice(0, -1);
    return { value: value.replace(/''/g, "'").trim(), consumed };
  }
  return { value: raw.trim(), consumed: 0 };
}

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };

  const lines = match[1].split(/\r?\n/);
  const data = {};
  let nested = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const entry = /^([^:]+):[ \t]*(.*)$/.exec(line.trim());
    if (!entry) continue;

    const key = entry[1].trim();
    const { value, consumed } = readScalar(lines, i, entry[2]);
    i += consumed;

    if (indent === 0) {
      if (value === '') {
        data[key] = {};
        nested = data[key];
      } else {
        data[key] = value;
        nested = null;
      }
    } else if (nested) {
      nested[key] = value;
    }
  }

  return { data, body: text.slice(match[0].length) };
}
