// Headless browser smoke for the FarmBot screen at /farmbot/.
//
// Unlike `vite preview`, this script serves dist/ with the production headers
// from `_headers` (the CSP, the WASM content type, and the immutable asset
// cache rule), so a "zero CSP violations" result is meaningful. Set
// SMOKE_BASE_URL to drive a deployed origin instead; the given origin is used
// as the site root and its headers are left alone.
//
// The script does not build. Run `npx -y node@22 scripts/verify.mjs` (or a Node
// 22 `npm run build`) first. On any assertion failure it exits 1.
//
// Proposed latency budgets are reported but not enforced. Set
// SMOKE_FARMBOT_ENFORCE_BUDGET=1 to fail when a budget is missed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, extname, join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const liveBase = process.env.SMOKE_BASE_URL?.trim();
const port = Number(process.env.SMOKE_PORT ?? 4175);
const base = (liveBase || `http://127.0.0.1:${port}`).replace(/\/?$/, '/');
const baseOrigin = new URL(base).origin;
const entryUrl = `${base}farmbot/`;
const useLive = Boolean(liveBase);
const enforceBudget = process.env.SMOKE_FARMBOT_ENFORCE_BUDGET === '1';

const SEED_BUDGET_MS = 2000;
const QUERY_BUDGET_MS = 100;
const EXPECTED_SEED_SHA256 =
  'db6503e0c17d024d610736b0996c98a2872b495936d4f84230747db603f36fb1';
const EXPECTED_SEED_DIGEST = `farmbot-graph-v1 sha256:${EXPECTED_SEED_SHA256}`;
const EXPECTED_ROW_COUNTS = { q1: 12, q2: 2, q3: 7, q4: 24, q5: 17 };
const QUESTION_IDS = ['q1', 'q2', 'q3', 'q4', 'q5'];

const committedSeedPath = join(root, 'farmbot/dist/farmbot.seed.json');
const goldPath = join(root, 'farmbot/oracle/default-results.gold.json');

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

/** `blob:` and `data:` URLs are not outbound hosts. */
const isExternal = (url) => {
  const parsed = new URL(url);
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.origin !== baseOrigin
  );
};

/** Mirrors `cellText` in src/farmbot/App.tsx. */
const cellText = (value) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

// --- static server: dist/ plus the production `_headers` rules --------------

function parseHeaderRules(text) {
  const rules = [];
  let rule = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      rule = null;
      continue;
    }
    if (/^\s/.test(line)) {
      if (!rule) continue;
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      rule.headers.push([
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      ]);
      continue;
    }
    rule = { pattern: line.trim(), headers: [] };
    rules.push(rule);
  }
  return rules;
}

/** One `*` splat, matched greedily; absolute patterns use their path. */
function patternMatches(pattern, pathname) {
  const path = /^https?:\/\//.test(pattern) ? new URL(pattern).pathname : pattern;
  const source = path
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(pathname);
}

/** Rules apply in file order; repeated headers are comma-joined. */
function headersFor(rules, pathname) {
  const headers = new Map();
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) {
      headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
    }
  }
  return headers;
}

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

async function startStaticServer() {
  const distRoot = join(root, 'dist');
  for (const file of ['farmbot/index.html', 'farmbot/farmbot.seed.json']) {
    if (!existsSync(join(distRoot, file))) {
      throw new Error(
        `dist/${file} is missing; run \`npx -y node@22 scripts/verify.mjs\` ` +
          '(or a Node 22 `npm run build`) first',
      );
    }
  }
  const headersPath = join(distRoot, '_headers');
  assert(
    existsSync(headersPath),
    'dist/_headers is missing; the production CSP cannot be applied without it',
  );
  const rules = parseHeaderRules(readFileSync(headersPath, 'utf8'));
  assert(rules.length > 0, 'dist/_headers contains no rules');

  const server = createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      );
    } catch {
      response.writeHead(400);
      response.end('bad request');
      return;
    }
    const filePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const target = resolve(distRoot, `.${filePath}`);
    if (
      !target.startsWith(`${distRoot}${sep}`) ||
      !existsSync(target) ||
      !statSync(target).isFile()
    ) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    const bytes = readFileSync(target);
    const headers = new Map([
      ['Content-Type', MIME_TYPES.get(extname(target)) ?? 'application/octet-stream'],
      ['Content-Length', String(bytes.length)],
    ]);
    for (const [name, value] of headersFor(rules, pathname)) {
      headers.set(name, value);
    }
    response.writeHead(200, Object.fromEntries(headers));
    response.end(bytes);
  });

  await new Promise((resolveListening, rejectListening) => {
    server.once('error', (error) => {
      rejectListening(
        new Error(
          `could not serve dist/ on 127.0.0.1:${port} (${error.code ?? error.message}); ` +
            'set SMOKE_PORT to a free port',
        ),
      );
    });
    server.listen(port, '127.0.0.1', resolveListening);
  });

  return {
    server,
    close: () =>
      new Promise((resolveClosed) => {
        server.closeAllConnections?.();
        server.close(() => resolveClosed());
      }),
  };
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(250);
  }
  throw new Error(`the FarmBot entry did not respond at ${url}`);
}

async function launchBrowser() {
  const attempts = [];
  try {
    return { browser: await chromium.launch(), mode: 'playwright-chromium' };
  } catch (error) {
    attempts.push(`bundled chromium: ${error.message}`);
  }
  try {
    return { browser: await chromium.launch({ channel: 'chrome' }), mode: 'system-chrome' };
  } catch (error) {
    attempts.push(`system chrome: ${error.message}`);
  }
  throw new Error(
    `No Chromium available. Install it with \`npx playwright install chromium\`.\n` +
      attempts.join('\n'),
  );
}

// --- first-paint asset discovery --------------------------------------------

function jsRefsFromHtml(html, entryHref) {
  return new Set(
    [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) =>
      basename(new URL(match[1], entryHref).pathname),
    ),
  );
}

function readLocalEntryInfo() {
  const html = readFileSync(join(root, 'dist/farmbot/index.html'), 'utf8');
  const assets = join(root, 'dist/assets');
  const jsFiles = readdirSync(assets).filter((file) => file.endsWith('.js'));
  const relateChunk = jsFiles.find((file) =>
    readFileSync(join(assets, file), 'utf8').includes('relate_bg'),
  );
  const relateWasm = readdirSync(assets)
    .filter((file) => file.endsWith('.wasm'))
    .find((file) => file.includes('relate_bg'));
  return {
    firstPaintChunks: jsRefsFromHtml(html, entryUrl),
    relateChunk: relateChunk ?? null,
    relateWasm: relateWasm ?? null,
  };
}

async function readLiveEntryInfo() {
  const response = await fetch(entryUrl);
  if (!response.ok) throw new Error(`${entryUrl} returned HTTP ${response.status}`);
  return {
    firstPaintChunks: jsRefsFromHtml(await response.text(), entryUrl),
    relateChunk: null,
    relateWasm: null,
  };
}

// --- browser helpers --------------------------------------------------------

async function prepareContext(browser, label) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener(
      'securitypolicyviolation',
      (event) => {
        window.__cspViolations.push({
          violatedDirective: event.violatedDirective,
          effectiveDirective: event.effectiveDirective,
          blockedURI: event.blockedURI,
          documentURI: event.documentURI,
          disposition: event.disposition,
          statusCode: event.statusCode,
          sourceFile: event.sourceFile,
          lineNumber: event.lineNumber,
          columnNumber: event.columnNumber,
        });
      },
      true,
    );
  });
  const requests = [];
  const responses = [];
  context.on('request', (request) => requests.push(request.url()));
  context.on('response', (response) =>
    responses.push({
      url: response.url(),
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
    }),
  );
  const pageErrors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return { label, context, page, requests, responses, pageErrors };
}

const readCspViolations = (page) =>
  page.evaluate(() => window.__cspViolations ?? []);

const externalRequests = (requests) => requests.filter((url) => isExternal(url));

function isRelateAssetUrl(url, entryInfo) {
  const pathname = pathOf(url);
  if (/\/relate_bg[^/]*\.wasm$/.test(pathname)) return true;
  if (/\/relate-loader[^/]*\.js$/.test(pathname)) return true;
  if (entryInfo.relateWasm && pathname.endsWith(`/${entryInfo.relateWasm}`)) return true;
  if (entryInfo.relateChunk && pathname.endsWith(`/${entryInfo.relateChunk}`)) return true;
  return false;
}

const isWasmUrl = (url) => /\.wasm$/.test(pathOf(url));

async function readTimings(page) {
  const text = await page.locator('[data-testid="timings"]').textContent();
  return JSON.parse(text);
}

const budgetRecords = [];

function checkBudget(label, measuredMs, budgetMs) {
  const measured = Number(measuredMs.toFixed(2));
  const ok = measured <= budgetMs;
  budgetRecords.push({ label, measuredMs: measured, budgetMs, ok, enforced: enforceBudget });
  if (!ok) {
    console.log(
      `budget miss: ${label} measured ${measured} ms, proposed budget ${budgetMs} ms ` +
        (enforceBudget
          ? '(enforced by SMOKE_FARMBOT_ENFORCE_BUDGET=1)'
          : '(budget not yet enforced)'),
    );
  }
  return ok;
}

async function readTable(page) {
  return page.evaluate(() => {
    const result = document.querySelector('[data-testid="result"]');
    if (!result) return null;
    const table = result.querySelector('table');
    if (!table) return { headers: [], rows: [] };
    return {
      headers: [...table.querySelectorAll('thead th')].map((cell) => cell.textContent ?? ''),
      rows: [...table.querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? ''),
      ),
    };
  });
}

async function main() {
  const committedSeedBytes = readFileSync(committedSeedPath);
  const committedSeedSha = sha256Hex(committedSeedBytes);
  assert(
    committedSeedSha === EXPECTED_SEED_SHA256,
    `the committed seed SHA-256 is ${committedSeedSha}, expected ${EXPECTED_SEED_SHA256}`,
  );

  const gold = JSON.parse(readFileSync(goldPath, 'utf8'));
  assert(gold.format === 'farmbot-default-results-v1', 'unexpected gold fixture format');
  assert(gold.seedDigest === EXPECTED_SEED_DIGEST, 'gold fixture seed digest is stale');
  assert(gold.seedBytes === committedSeedBytes.length, 'gold fixture seed byte length is stale');
  assert(
    JSON.stringify(gold.questions.map((question) => question.id)) ===
      JSON.stringify(QUESTION_IDS),
    'gold fixture must cover q1..q5 in order',
  );
  for (const question of gold.questions) {
    assert(
      question.rowCount === EXPECTED_ROW_COUNTS[question.id],
      `${question.id}: gold row count ${question.rowCount} is not the expected ${EXPECTED_ROW_COUNTS[question.id]}`,
    );
  }

  const tampered = Buffer.from(committedSeedBytes);
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;
  const tamperedSha = sha256Hex(tampered);
  assert(tamperedSha !== committedSeedSha, 'the tampered seed must change the digest');

  const summary = {
    ok: false,
    base,
    mode: useLive ? 'live' : 'local',
    node: process.version,
    browser: null,
    entry: entryUrl,
    cspHeader: null,
    seed: null,
    firstPaint: null,
    questions: [],
    timings: null,
    budgets: budgetRecords,
    tamperedSeed: null,
    cspViolations: null,
    nonSameOriginRequests: [],
    pageErrors: [],
    error: null,
  };

  let localServer = null;
  let browser = null;
  let happy = null;
  let tamper = null;

  try {
    if (useLive) {
      await waitForServer(entryUrl);
    } else {
      localServer = await startStaticServer();
    }
    const entryInfo = useLive ? await readLiveEntryInfo() : readLocalEntryInfo();
    assert(
      entryInfo.firstPaintChunks.size > 0,
      'the FarmBot entry HTML references no JS chunk',
    );

    const launched = await launchBrowser();
    browser = launched.browser;
    summary.browser = { mode: launched.mode, version: browser.version() };

    // Happy path: first paint, digest, five default questions, timings.
    happy = await prepareContext(browser, 'happy');
    const page = happy.page;
    const navigation = await page.goto(entryUrl, { waitUntil: 'load', timeout: 60000 });
    const documentCsp = navigation?.headers()['content-security-policy'] ?? '';
    if (!useLive) {
      assert(
        /default-src 'none'/.test(documentCsp),
        'the document response did not carry the production CSP header',
      );
      assert(
        /script-src 'self' 'wasm-unsafe-eval'/.test(documentCsp),
        `the document CSP script-src is wrong: ${documentCsp}`,
      );
      assert(
        /connect-src 'self'/.test(documentCsp),
        `the document CSP connect-src is wrong: ${documentCsp}`,
      );
    }
    summary.cspHeader = documentCsp || null;
    await page.waitForSelector('[data-testid="abi"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="run"]:not([disabled])', { timeout: 30000 });

    const chips = await page.evaluate(() =>
      ['q1', 'q2', 'q3', 'q4', 'q5'].map((id) => {
        const chip = document.querySelector(`[data-testid="question-${id}"]`);
        return {
          id,
          present: Boolean(chip),
          visible: Boolean(chip) && chip.getBoundingClientRect().height > 0,
        };
      }),
    );
    for (const chip of chips) {
      assert(chip.present, `question chip ${chip.id} is missing`);
      assert(chip.visible, `question chip ${chip.id} is not visible`);
    }

    const expectedDigest = (
      await page.locator('[data-testid="expected-digest"]').textContent()
    )?.trim();
    assert(
      expectedDigest === EXPECTED_SEED_DIGEST,
      `the page shows seed digest ${JSON.stringify(expectedDigest)}`,
    );

    // Let every first-paint request register before freezing the list.
    await delay(300);
    const firstPaintRequests = [...happy.requests];
    const relateBeforeRun = firstPaintRequests.filter((url) =>
      isRelateAssetUrl(url, entryInfo),
    );
    assert(
      relateBeforeRun.length === 0,
      `first paint requested the Relate engine: ${relateBeforeRun.join(', ')}`,
    );
    const unexpectedJs = firstPaintRequests.filter((url) => {
      const pathname = pathOf(url);
      if (!pathname.endsWith('.js')) return false;
      if (new URL(url).origin !== baseOrigin) return false;
      return !entryInfo.firstPaintChunks.has(basename(pathname));
    });
    assert(
      unexpectedJs.length === 0,
      `first paint requested a JS chunk the entry HTML does not reference: ${unexpectedJs.join(', ')}`,
    );
    summary.firstPaint = {
      requests: firstPaintRequests.map((url) => pathOf(url)),
      questionChips: chips.length,
      relateRequests: relateBeforeRun.length,
      unexpectedJs,
    };

    // The seed actually served to this origin must hash to the committed digest.
    const servedSeed = await page.evaluate(async () => {
      const response = await fetch(new URL('farmbot.seed.json', document.baseURI), {
        cache: 'no-store',
      });
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      return { status: response.status, url: response.url, bytes: bytes.byteLength, hex };
    });
    assert(servedSeed.status === 200, `served seed returned HTTP ${servedSeed.status}`);
    assert(
      new URL(servedSeed.url).origin === baseOrigin,
      `the seed must be fetched same-origin, got ${servedSeed.url}`,
    );
    assert(
      servedSeed.hex === EXPECTED_SEED_SHA256,
      `served seed SHA-256 is ${servedSeed.hex}, expected ${EXPECTED_SEED_SHA256}`,
    );
    assert(
      servedSeed.bytes === committedSeedBytes.length,
      `served seed is ${servedSeed.bytes} bytes, committed seed is ${committedSeedBytes.length}`,
    );

    for (const [index, question] of gold.questions.entries()) {
      const id = QUESTION_IDS[index];
      await page.click(`[data-testid="question-${id}"]`);
      await page.waitForSelector('[data-testid="run"]:not([disabled])', {
        timeout: 30000,
      });
      await page.click('[data-testid="run"]');
      await page.waitForFunction(
        ({ intentFile, rowCount }) => {
          const result = document.querySelector('[data-testid="result"]');
          const count = document.querySelector('[data-testid="row-count"]');
          return (
            Boolean(result) &&
            Boolean(count) &&
            result.textContent.includes(intentFile) &&
            Number(count.textContent) === rowCount
          );
        },
        { intentFile: question.intentFile, rowCount: question.rowCount },
        { timeout: 60000 },
      );
      await page.waitForSelector('[data-testid="run"]:not([disabled])', {
        timeout: 30000,
      });

      const table = await readTable(page);
      assert(table, `${id}: no result table`);
      assert(
        JSON.stringify(table.headers) === JSON.stringify(question.columns),
        `${id}: columns ${JSON.stringify(table.headers)} != ${JSON.stringify(question.columns)}`,
      );
      const expectedRows = question.rows
        .map((row) =>
          JSON.stringify(question.columns.map((column) => cellText(row[column]))),
        )
        .sort();
      const actualRows = table.rows.map((row) => JSON.stringify(row)).sort();
      assert(
        JSON.stringify(actualRows) === JSON.stringify(expectedRows),
        `${id}: on-screen rows differ from the gold oracle\n` +
          `  expected: ${expectedRows.join(' | ')}\n` +
          `  actual:   ${actualRows.join(' | ')}`,
      );
      const rowCount = Number(
        await page.locator('[data-testid="row-count"]').textContent(),
      );
      assert(rowCount === question.rowCount, `${id}: row-count is ${rowCount}`);

      const timings = await readTimings(page);
      const queryMs = timings.queries?.[id];
      assert(
        typeof queryMs === 'number' && Number.isFinite(queryMs),
        `${id}: query timing was not recorded (${JSON.stringify(timings)})`,
      );
      checkBudget(`query ${id}`, queryMs, QUERY_BUDGET_MS);
      if (index === 0) {
        assert(
          typeof timings.seedLoadMs === 'number' && Number.isFinite(timings.seedLoadMs),
          `seed load timing was not recorded (${JSON.stringify(timings)})`,
        );
        checkBudget('seed load', timings.seedLoadMs, SEED_BUDGET_MS);
      }

      summary.questions.push({
        id,
        intentFile: question.intentFile,
        columns: table.headers,
        rowCount,
        rowsMatchGold: true,
        queryMs: Number(queryMs.toFixed(2)),
      });
    }

    summary.timings = await readTimings(page);
    for (const id of QUESTION_IDS) {
      assert(
        typeof summary.timings.queries?.[id] === 'number',
        `${id}: missing query timing`,
      );
    }

    const verifiedDigest = (
      await page.locator('[data-testid="verified-digest"]').textContent()
    )?.trim();
    assert(
      verifiedDigest === EXPECTED_SEED_DIGEST,
      `the verified digest shown is ${JSON.stringify(verifiedDigest)}`,
    );
    const seedBytesShown = Number(
      await page.locator('[data-testid="seed-bytes"]').textContent(),
    );
    assert(
      seedBytesShown === committedSeedBytes.length,
      `the screen loaded ${seedBytesShown} seed bytes, expected ${committedSeedBytes.length}`,
    );
    summary.seed = {
      expectedDigest,
      servedSha256: servedSeed.hex,
      servedBytes: servedSeed.bytes,
      verifiedDigest,
      seedBytesShown,
    };

    const relateWasmRequests = happy.requests.filter(
      (url) => isWasmUrl(url) && /relate_bg/.test(pathOf(url)),
    );
    assert(
      relateWasmRequests.length > 0,
      'the first Run did not request the Relate WASM asset',
    );
    const wasmResponses = happy.responses.filter((response) => isWasmUrl(response.url));
    assert(wasmResponses.length > 0, 'no .wasm response was observed');
    for (const response of wasmResponses) {
      assert(
        new URL(response.url).origin === baseOrigin,
        `WASM must be served same-origin: ${response.url}`,
      );
      assert(response.status === 200, `WASM response ${response.url} was ${response.status}`);
      assert(
        response.contentType.startsWith('application/wasm'),
        `WASM response ${response.url} has content-type ${response.contentType}`,
      );
    }
    for (const url of relateWasmRequests) {
      assert(
        new URL(url).origin === baseOrigin,
        `the Relate WASM must be same-origin, got ${url}`,
      );
    }

    const happyCsp = await readCspViolations(page);
    assert(happyCsp.length === 0, `CSP violation(s): ${JSON.stringify(happyCsp)}`);
    assert(
      happy.pageErrors.length === 0,
      `page error(s): ${happy.pageErrors.join(' | ')}`,
    );
    const happyExternal = externalRequests(happy.requests);
    assert(
      happyExternal.length === 0,
      `non-same-origin request(s): ${happyExternal.join(', ')}`,
    );

    // Tampered seed: the digest check must run first and reject the bytes.
    tamper = await prepareContext(browser, 'tampered-seed');
    await tamper.context.route(
      (url) => url.pathname.endsWith('/farmbot/farmbot.seed.json'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: tampered,
        }),
    );
    await tamper.page.goto(entryUrl, { waitUntil: 'load', timeout: 60000 });
    await tamper.page.waitForSelector('[data-testid="abi"]', { timeout: 30000 });
    await tamper.page.waitForSelector('[data-testid="run"]:not([disabled])', {
      timeout: 30000,
    });
    const relateBeforeTamperedRun = tamper.requests.filter((url) =>
      isRelateAssetUrl(url, entryInfo),
    );
    assert(
      relateBeforeTamperedRun.length === 0,
      `the tampered-seed context requested Relate before Run: ${relateBeforeTamperedRun.join(', ')}`,
    );
    await tamper.page.click('[data-testid="run"]');
    await tamper.page.waitForSelector('[data-testid="error"]', { timeout: 30000 });

    const tamperState = await tamper.page.evaluate(() => ({
      errorText: document.querySelector('[data-testid="error"]')?.textContent ?? '',
      result: Boolean(document.querySelector('[data-testid="result"]')),
      rowCount: document.querySelector('[data-testid="row-count"]')?.textContent ?? null,
      bodyText: document.body.innerText,
    }));
    const expectedActualDigest = `farmbot-graph-v1 sha256:${tamperedSha}`;
    assert(
      tamperState.errorText.includes(EXPECTED_SEED_DIGEST),
      `the digest error does not show the expected digest: ${tamperState.errorText}`,
    );
    assert(
      tamperState.errorText.includes(expectedActualDigest),
      `the digest error does not show the tampered digest: ${tamperState.errorText}`,
    );
    assert(
      /do not match the committed digest/i.test(tamperState.errorText),
      `the digest error does not name the mismatch: ${tamperState.errorText}`,
    );
    assert(!tamperState.result, 'the tampered seed produced a result panel');
    assert(tamperState.rowCount === null, 'the tampered seed produced rows');
    assert(
      !/DEMO-|affected_products/.test(tamperState.bodyText),
      'desk-fan fixture content appeared on the FarmBot screen',
    );
    const relateAfterTamper = tamper.requests.filter((url) =>
      isRelateAssetUrl(url, entryInfo),
    );
    assert(
      relateAfterTamper.length === 0,
      `a rejected seed must not load Relate: ${relateAfterTamper.join(', ')}`,
    );
    const tamperCsp = await readCspViolations(tamper.page);
    assert(tamperCsp.length === 0, `tampered-seed CSP violation(s): ${JSON.stringify(tamperCsp)}`);
    const tamperExternal = externalRequests(tamper.requests);
    assert(
      tamperExternal.length === 0,
      `tampered-seed non-same-origin request(s): ${tamperExternal.join(', ')}`,
    );
    summary.tamperedSeed = {
      rejected: true,
      error: tamperState.errorText.replace(/\s+/g, ' ').trim().slice(0, 400),
      relateRequests: relateAfterTamper.length,
      rows: null,
      cspViolations: tamperCsp.length,
    };

    summary.cspViolations = { happy: happyCsp.length, tampered: tamperCsp.length };
    summary.pageErrors = happy.pageErrors;
    summary.nonSameOriginRequests = [
      ...new Set([...happyExternal, ...tamperExternal]),
    ];

    const missed = budgetRecords.filter((record) => !record.ok);
    if (enforceBudget && missed.length > 0) {
      throw new Error(
        `budget(s) missed with SMOKE_FARMBOT_ENFORCE_BUDGET=1: ${missed
          .map((record) => `${record.label} ${record.measuredMs} ms > ${record.budgetMs} ms`)
          .join(', ')}`,
      );
    }

    summary.ok = true;
    console.log(JSON.stringify(summary, null, 2));
    console.log(
      'smoke:farmbot OK (5 questions, seed digest verified, 0 CSP violations, 0 non-same-origin requests)',
    );
  } catch (error) {
    summary.error = error.message;
    for (const fixture of [happy, tamper]) {
      if (!fixture) continue;
      try {
        const violations = await readCspViolations(fixture.page);
        summary[`${fixture.label}CspViolations`] = violations;
      } catch {
        // The page may already be gone.
      }
    }
    console.log(JSON.stringify(summary, null, 2));
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // The browser may already be gone.
      }
    }
    if (localServer) {
      try {
        await localServer.close();
      } catch {
        // A leftover listener dies with the process.
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('smoke:farmbot FAILED:', error.message);
    process.exit(1);
  });
