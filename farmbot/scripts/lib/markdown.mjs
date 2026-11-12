// Small Markdown readers for the subset used by the pinned FarmBot Genesis
// pages: GFM tables and `[[part name]]` links.

const SEPARATOR_ROW = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const WIKILINK = /\[\[([^\]]+)\]\]/g;

export function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => cell.trim());
}

export function findWikilinks(text) {
  const links = [];
  WIKILINK.lastIndex = 0;
  let match;
  while ((match = WIKILINK.exec(text)) !== null) {
    links.push({ name: match[1].trim(), index: match.index });
  }
  return links;
}

export function stripMarkup(text) {
  return text
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns table blocks with the nearest preceding Markdown heading.
export function extractTables(body) {
  const lines = body.split(/\r?\n/);
  const tables = [];
  let section = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[2].replace(/\s*#+\s*$/, '').trim();
      continue;
    }
    if (!line.trim().startsWith('|')) continue;
    if (i + 1 >= lines.length || !SEPARATOR_ROW.test(lines[i + 1])) continue;

    const header = splitTableRow(line);
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith('|')) {
      rows.push({ cells: splitTableRow(lines[j]), lineNumber: j + 1 });
      j += 1;
    }
    tables.push({ section, header, rows, startLine: i + 1 });
    i = j - 1;
  }

  return tables;
}
