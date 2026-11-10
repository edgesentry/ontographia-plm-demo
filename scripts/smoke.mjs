// Headless browser smoke test for the built demo.
//
// Uses Playwright's Chromium when installed, otherwise falls back to the system
// Google Chrome channel. Run after `npm run verify` (which produces dist/).
// Set SMOKE_BASE_URL to check a live deploy instead of spawning `vite preview`.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const liveBase = process.env.SMOKE_BASE_URL?.trim();
const port = Number(process.env.SMOKE_PORT ?? 4173);
const base = (liveBase || `http://127.0.0.1:${port}`).replace(/\/?$/, '/');
const baseOrigin = new URL(base).origin;
const useLive = Boolean(liveBase);
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const expected = {
  affected_products: {
    path: ['DEMO-BRKT-01', 'DEMO-FAN-100', 'DEMO-FAN-200', 'DEMO-FAN-300'],
    rows: 3,
  },
  affected_bop: { path: ['OP-BRKT-MOUNT', 'WC-LINE-A'], rows: 1 },
  affected_customers: {
    path: [
      'DEMO-BRKT-01',
      'DEMO-FAN-100',
      'DEMO-FAN-200',
      'DEMO-FAN-300',
      'CUST-EU-01',
      'CUST-NA-01',
      'CUST-APAC-01',
    ],
    rows: 3,
  },
  alternatives: { path: ['DEMO-BRKT-01', 'DEMO-BRKT-02'], rows: 1 },
  residual_risk: {
    path: ['DEMO-ECO-FAN-01', 'DEMO-BRKT-01', 'DEMO-FAN-100', 'DEMO-FAN-200', 'DEMO-FAN-300'],
    rows: 4,
  },
};

const snapshot = (page) =>
  page.evaluate(() => {
    const selected = document.querySelector('.chip.is-selected');
    const table = document.querySelector('[data-testid="hud-results"]');
    return {
      lang: document.documentElement.lang,
      selected: selected?.getAttribute('data-chip-id') ?? null,
      pressed: selected?.getAttribute('aria-pressed') ?? null,
      highlighted: Array.from(document.querySelectorAll('[data-node-id][data-highlighted="true"]'))
        .map((element) => element.getAttribute('data-node-id'))
        .sort(),
      intent: document.querySelector('[data-testid="hud-intent"]')?.textContent ?? '',
      cypher: document.querySelector('[data-testid="hud-cypher"]')?.textContent ?? '',
      params: document.querySelector('[data-testid="hud-params"]')?.textContent ?? '',
      results: table?.textContent ?? document.querySelector('[data-testid="no-matches"]')?.textContent ?? '',
      disclaimer: document.querySelector('[data-testid="disclaimer"]')?.textContent ?? '',
      rows: table ? table.querySelectorAll('tbody tr').length : 0,
      verified: Boolean(document.querySelector('[data-testid="verified"]')),
    };
  });

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(base);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(250);
  }
  throw new Error(`vite preview did not respond at ${base}`);
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
  throw new Error(`No Chromium/Chrome available.\n${attempts.join('\n')}`);
}

async function main() {
  if (!useLive && !existsSync(join(root, 'dist/index.html'))) {
    throw new Error('dist/index.html is missing; run `npm run verify` (or `npm run build`) first');
  }

  let server;
  let serverLog = '';
  if (!useLive) {
    server = spawn(
      'npx',
      ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so the preview and its esbuild child can be stopped
        // together; otherwise CI can hang on inherited stdio after the checks pass.
        detached: process.platform !== 'win32',
      },
    );
    server.stdout.on('data', (chunk) => {
      serverLog += chunk.toString();
    });
    server.stderr.on('data', (chunk) => {
      serverLog += chunk.toString();
    });
  }

  let browser;
  try {
    if (!useLive) await waitForServer();
    const launched = await launchBrowser();
    browser = launched.browser;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });

    const requests = [];
    const responses = [];
    const pageErrors = [];
    context.on('request', (request) => requests.push(request.url()));
    context.on('response', (response) =>
      responses.push({
        url: response.url(),
        status: response.status(),
        contentType: response.headers()['content-type'] ?? '',
      }),
    );

    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('[data-testid="chip-affected_products"]:not([disabled])', {
      timeout: 20000,
    });

    const mbomNote = await page.locator('[data-testid="mbom-note"]').textContent();
    assert(mbomNote && mbomNote.trim().length > 0, 'MBOM lane note is missing');
    const mbomNodes = await page.evaluate(
      () =>
        document.querySelectorAll('[data-testid="lane-mbom"] [data-node-id]').length,
    );
    assert(mbomNodes === 0, `MBOM lane must stay empty, found ${mbomNodes} nodes`);

    const structure = await page.evaluate(() => ({
      lanes: Array.from(document.querySelectorAll('[data-testid="swimlane"] [data-lane]')).map(
        (element) => element.getAttribute('data-lane'),
      ),
      nodes: document.querySelectorAll('[data-node-id]').length,
      chips: document.querySelectorAll('[data-chip-id]').length,
    }));
    assert(
      JSON.stringify(structure.lanes) === JSON.stringify(['ebom', 'mbom', 'sbom', 'bop']),
      `lane order must be EBOM, MBOM, SBOM, BOP; got ${structure.lanes.join(', ')}`,
    );
    assert(structure.nodes === 18, `expected 18 rendered nodes, got ${structure.nodes}`);
    assert(structure.chips === 5, `expected 5 chips, got ${structure.chips}`);

    const edgeText = (await page.locator('[data-testid="cross-lane-edge"]').allTextContents()).join(' ');
    for (const type of ['ORDERED_BY', 'CONSUMES', 'PRODUCES']) {
      assert(edgeText.includes(type), `cross-lane edges must include ${type}`);
    }

    const results = {};
    for (const [chipId, expectation] of Object.entries(expected)) {
      const selector = `[data-testid="chip-${chipId}"]`;
      await page.click(selector);
      await page.waitForFunction(
        ({ expectedRows }) => {
          const table = document.querySelector('[data-testid="hud-results"]');
          const rows = table ? table.querySelectorAll('tbody tr').length : 0;
          const verified = Boolean(document.querySelector('[data-testid="verified"]'));
          const highlighted = document.querySelectorAll(
            '[data-node-id][data-highlighted="true"]',
          ).length;
          return verified && highlighted > 0 && rows === expectedRows;
        },
        { expectedRows: expectation.rows },
        { timeout: 10000 },
      );

      const state = await snapshot(page);
      const actualPath = [...state.highlighted].sort();
      const wantedPath = [...expectation.path].sort();
      assert(
        JSON.stringify(actualPath) === JSON.stringify(wantedPath),
        `${chipId} highlight mismatch\n  expected: ${wantedPath.join(', ')}\n  actual:   ${actualPath.join(', ')}`,
      );
      assert(state.verified, `${chipId} did not show the Verified badge`);
      assert(state.cypher.includes('CYPHER 25'), `${chipId} HUD is missing compiled Cypher`);
      assert(state.params.trim().length > 1, `${chipId} HUD is missing bound parameters`);
      assert(state.intent.trim().startsWith('{'), `${chipId} HUD is missing the resolved Intent`);
      assert(state.rows === expectation.rows, `${chipId} expected ${expectation.rows} rows, got ${state.rows}`);
      results[chipId] = {
        rows: state.rows,
        pathNodes: actualPath,
        verified: state.verified,
        cypherFirstLine: state.cypher.split('\n')[0],
      };
    }

    const beforeToggle = await snapshot(page);
    const toggleTarget = beforeToggle.lang === 'ja' ? 'en' : 'ja';
    await page.selectOption('[data-testid="lang-toggle"]', toggleTarget);
    await page.waitForFunction(
      (target) => document.documentElement.lang === target,
      toggleTarget,
      { timeout: 5000 },
    );
    const afterToggle = await snapshot(page);
    assert(afterToggle.lang === toggleTarget, 'language toggle did not update <html lang>');
    assert(
      afterToggle.selected === beforeToggle.selected && afterToggle.pressed === 'true',
      'language toggle cleared the selected chip',
    );
    assert(afterToggle.cypher === beforeToggle.cypher, 'language toggle cleared the Cypher');
    assert(afterToggle.results === beforeToggle.results, 'language toggle cleared the results');
    assert(
      JSON.stringify(afterToggle.highlighted) === JSON.stringify(beforeToggle.highlighted),
      'language toggle cleared the node highlights',
    );
    assert(afterToggle.disclaimer !== beforeToggle.disclaimer, 'disclaimer did not switch language');
    assert(
      toggleTarget === 'ja'
        ? afterToggle.disclaimer.includes('Intent エグゼキュータ')
        : afterToggle.disclaimer.includes('Intent executor'),
      'disclaimer language is wrong after toggle',
    );

    const wasmResponses = responses.filter((response) => response.url.endsWith('.wasm'));
    assert(wasmResponses.length > 0, 'no .wasm response observed');
    for (const response of wasmResponses) {
      assert(
        new URL(response.url).origin === baseOrigin,
        `WASM must be fetched same-origin: ${response.url}`,
      );
      assert(response.status === 200, `WASM response status ${response.status}`);
      assert(
        response.contentType.startsWith('application/wasm'),
        `WASM response MIME is ${response.contentType}, expected application/wasm`,
      );
    }

    const externalRequests = requests.filter((url) => {
      const parsed = new URL(url);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin !== baseOrigin;
    });
    assert(externalRequests.length === 0, `outbound request(s) detected: ${externalRequests.join(', ')}`);
    assert(pageErrors.length === 0, `page error(s): ${pageErrors.join(' | ')}`);

    // WASM load failure: retry remains available, chips are disabled, and no
    // success state (Verified badge, results, highlights) leaks through.
    const failureContext = await browser.newContext();
    const failed = await failureContext.newPage();
    await failed.route('**/*.wasm', (route) => route.abort());
    await failed.goto(base, { waitUntil: 'load' });
    await failed.waitForSelector('[data-testid="load-error"]', { timeout: 20000 });
    const failureState = await failed.evaluate(() => ({
      retry: Boolean(document.querySelector('[data-testid="load-error"] button')),
      chips: document.querySelectorAll('[data-chip-id]').length,
      allChipsDisabled: Array.from(document.querySelectorAll('[data-chip-id]')).every(
        (chip) => chip.disabled,
      ),
      verified: Boolean(document.querySelector('[data-testid="verified"]')),
      results: Boolean(document.querySelector('[data-testid="hud-results"]')),
      highlights: document.querySelectorAll('[data-node-id][data-highlighted="true"]').length,
      errorText: document.querySelector('[data-testid="load-error"]')?.textContent ?? '',
      retryLabel:
        document.querySelector('[data-testid="load-error"] button')?.textContent?.trim() ?? '',
    }));
    assert(failureState.retry, 'WASM load failure must keep the retry button');
    assert(failureState.chips === 5 && failureState.allChipsDisabled, 'chips must be disabled after WASM load failure');
    assert(!failureState.verified, 'Verified badge leaked after WASM load failure');
    assert(!failureState.results && failureState.highlights === 0, 'stale results/highlights after WASM load failure');
    const { errorText, retryLabel } = failureState;
    assert(retryLabel.length > 0, 'WASM load failure must keep the retry label');
    assert(!/fetchRetry/i.test(errorText), `load-error text glues the exception to Retry: ${errorText}`);
    const retryIndex = errorText.lastIndexOf(retryLabel);
    assert(retryIndex > 0, `Retry label must follow the error message: ${JSON.stringify(errorText)}`);
    const beforeRetry = errorText.slice(0, retryIndex);
    assert(
      beforeRetry.trim().length > 0,
      `load-error text is missing the error message: ${JSON.stringify(errorText)}`,
    );
    assert(
      /[\s.,;:!?、。]$/.test(beforeRetry),
      `error message and Retry must be separated by punctuation or whitespace: ${JSON.stringify(errorText)}`,
    );
    await failureContext.close();

    const mobile = await context.newPage();
    mobile.on('pageerror', (error) => pageErrors.push(`mobile: ${error.message}`));
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.goto(base, { waitUntil: 'load' });
    await mobile.waitForSelector('[data-testid="chip-affected_customers"]:not([disabled])', {
      timeout: 20000,
    });
    await mobile.click('[data-testid="chip-affected_customers"]');
    await mobile.waitForSelector('[data-testid="verified"]', { timeout: 10000 });
    const mobileLayout = await mobile.evaluate(() => ({
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      laneColumns: getComputedStyle(document.querySelector('[data-testid="swimlane"]')).gridTemplateColumns
        .split(' ')
        .filter(Boolean).length,
      chipOverflow: Array.from(document.querySelectorAll('.chip')).some(
        (chip) => chip.getBoundingClientRect().right > window.innerWidth + 1,
      ),
    }));
    assert(
      mobileLayout.scrollWidth <= mobileLayout.viewportWidth + 1,
      `mobile page scrolls horizontally: ${mobileLayout.scrollWidth} > ${mobileLayout.viewportWidth}`,
    );
    assert(!mobileLayout.chipOverflow, 'a chip overflows the mobile viewport');
    await mobile.close();

    console.log(
      JSON.stringify(
        {
          ok: true,
          base,
          browser: launched.mode,
          chips: results,
          languageToggle: {
            from: beforeToggle.lang,
            to: afterToggle.lang,
            keptChip: afterToggle.selected,
            keptCypher: afterToggle.cypher === beforeToggle.cypher,
            keptResults: afterToggle.results === beforeToggle.results,
            keptHighlights:
              JSON.stringify(afterToggle.highlighted) === JSON.stringify(beforeToggle.highlighted),
          },
          mbom: { nodes: mbomNodes, note: mbomNote.trim() },
          structure,
          wasmFailure: failureState,
          wasm: {
            sameOrigin: true,
            responses: wasmResponses.map((response) => ({
              status: response.status,
              contentType: response.contentType,
              file: response.url.split('/').pop(),
            })),
          },
          requests: { total: requests.length, external: externalRequests.length },
          mobile: mobileLayout,
          pageErrors,
        },
        null,
        2,
      ),
    );
    console.log('smoke OK');
  } finally {
    if (browser) await browser.close();
    if (server) {
      try {
        if (process.platform !== 'win32' && server.pid) {
          process.kill(-server.pid, 'SIGTERM');
        } else {
          server.kill('SIGTERM');
        }
      } catch {
        server.kill('SIGTERM');
      }
      server.stdout.destroy();
      server.stderr.destroy();
    }
    await delay(200);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('smoke FAILED:', error.message);
    process.exit(1);
  });
