// Headless browser smoke test for the built demo.
//
// Uses Playwright's Chromium when installed, otherwise falls back to the system
// Google Chrome channel. Run after `npm run verify` (which produces dist/).
// Set SMOKE_BASE_URL to check a live deploy instead of spawning `vite preview`.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

const isExternal = (url) => {
  const parsed = new URL(url);
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin !== baseOrigin
  );
};

const isModelHost = (url) => {
  const hostname = new URL(url).hostname;
  return (
    hostname === 'huggingface.co' ||
    hostname === 'hf.co' ||
    hostname.endsWith('.hf.co') ||
    hostname === 'raw.githubusercontent.com'
  );
};

/** Locate the tiny lazy WebLLM boundary chunk emitted by the production build. */
function findLazyWebllmChunk() {
  const assets = join(root, 'dist/assets');
  if (!existsSync(assets)) throw new Error('dist/assets is missing; run `npm run verify` first');
  const files = readdirSync(assets).filter((file) => file.endsWith('.js'));
  const chunk = files.find((file) =>
    readFileSync(join(assets, file), 'utf8').includes('ontographia-webllm-package-v1'),
  );
  if (!chunk) throw new Error('lazy WebLLM chunk not found in dist/assets');
  return chunk;
}

const expected = {
  affected_products: {
    path: ['DEMO-BRKT-01', 'DEMO-FAN-100', 'DEMO-FAN-200', 'DEMO-FAN-300'],
    ripple: ['DEMO-BRKT-01', 'DEMO-FAN-100', 'DEMO-FAN-200', 'DEMO-FAN-300'],
    rows: 3,
  },
  affected_bop: {
    path: ['OP-BRKT-MOUNT', 'WC-LINE-A'],
    ripple: ['OP-BRKT-MOUNT', 'WC-LINE-A'],
    rows: 1,
  },
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
    // The executor's pathNodeIds insertion order interleaves each assembly with
    // the customer reached from it; the ripple follows that order (start first).
    ripple: [
      'DEMO-BRKT-01',
      'DEMO-FAN-100',
      'CUST-EU-01',
      'DEMO-FAN-200',
      'CUST-NA-01',
      'DEMO-FAN-300',
      'CUST-APAC-01',
    ],
    rows: 3,
  },
  alternatives: {
    path: ['DEMO-BRKT-01', 'DEMO-BRKT-02'],
    ripple: ['DEMO-BRKT-01', 'DEMO-BRKT-02'],
    rows: 1,
  },
  residual_risk: {
    path: ['DEMO-ECO-FAN-01', 'DEMO-BRKT-01', 'DEMO-FAN-100', 'DEMO-FAN-200', 'DEMO-FAN-300'],
    ripple: ['DEMO-ECO-FAN-01', 'DEMO-BRKT-01', 'DEMO-FAN-100', 'DEMO-FAN-200', 'DEMO-FAN-300'],
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
      ripple: Array.from(document.querySelectorAll('[data-node-id][data-highlighted="true"]')).map(
        (element) => {
          const style = getComputedStyle(element);
          return {
            id: element.getAttribute('data-node-id'),
            index: element.getAttribute('data-ripple-index'),
            start: element.getAttribute('data-ripple-start') === 'true',
            animationName: style.animationName,
          };
        },
      ),
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

    // Free-text consent gate. WebGPU capability detection is stubbed on so the
    // consent card is reachable, but consent is never granted: no model host
    // and no lazy WebLLM chunk may be requested.
    const consentContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    await consentContext.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: { requestAdapter: async () => ({}) },
      });
    });
    const consentRequests = [];
    consentContext.on('request', (request) => consentRequests.push(request.url()));
    const consentPage = await consentContext.newPage();
    await consentPage.goto(base, { waitUntil: 'load' });
    await consentPage.waitForSelector('[data-testid="free-text-consent"]', { timeout: 20000 });
    const consentState = await consentPage.evaluate(() => ({
      consent: Boolean(document.querySelector('[data-testid="free-text-consent"]')),
      input: Boolean(document.querySelector('[data-testid="free-text-input"]')),
      runDisabled: document.querySelector('[data-testid="free-text-convert"]')?.disabled ?? null,
      modelText: document.querySelector('[data-testid="free-text-consent"]')?.textContent ?? '',
    }));
    assert(consentState.consent, 'free-text consent gate is missing');
    assert(consentState.input, 'free-text input is missing before consent');
    assert(consentState.runDisabled === true, 'free-text run must be disabled before consent');
    for (const needle of ['Llama-3.2-1B-Instruct-q4f16_1-MLC', '879.04 MB', '695,242,752']) {
      assert(
        consentState.modelText.includes(needle),
        `consent gate must show ${JSON.stringify(needle)}`,
      );
    }
    await consentPage.fill('[data-testid="free-text-input"]', 'Which products are affected?');
    await consentPage.evaluate(() => {
      document.querySelector('[data-testid="free-text-convert"]')?.click();
    });
    await delay(500);
    const consentModelRequests = consentRequests.filter((url) => isModelHost(url));
    assert(
      consentModelRequests.length === 0,
      `consent gate requested a model host: ${consentModelRequests.join(', ')}`,
    );
    assert(
      !consentRequests.some(
        (url) => url.includes('webllm-package') || /\/lib-[^/]+\.js$/.test(url),
      ),
      `consent gate loaded the lazy WebLLM chunk: ${consentRequests.join(', ')}`,
    );
    assert(
      !consentRequests.some((url) => isExternal(url)),
      `consent gate made an external request: ${consentRequests.join(', ')}`,
    );
    await consentPage.selectOption('[data-testid="lang-toggle"]', 'ja');
    await consentPage.waitForFunction(() => document.documentElement.lang === 'ja', undefined, {
      timeout: 5000,
    });
    const keptFreeText = await consentPage
      .locator('[data-testid="free-text-input"]')
      .inputValue();
    assert(
      keptFreeText === 'Which products are affected?',
      'language toggle cleared in-progress free-text',
    );
    await consentContext.close();

    // Remembered consent (returning visit): the cached view may offer Load, but
    // first paint must still make zero model-host, HF, raw.githubusercontent,
    // or lazy WebLLM chunk requests.
    let rememberedConsent = null;
    {
      const cachedContext = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      });
      await cachedContext.addInitScript(() => {
        Object.defineProperty(navigator, 'gpu', {
          configurable: true,
          value: { requestAdapter: async () => ({}) },
        });
        try {
          window.localStorage.setItem(
            'ontographia.freeTextConsent.v1',
            'Llama-3.2-1B-Instruct-q4f16_1-MLC',
          );
        } catch {
          // Storage may be unavailable; the assertion below will catch the miss.
        }
      });
      const cachedRequests = [];
      cachedContext.on('request', (request) => cachedRequests.push(request.url()));
      const cachedPage = await cachedContext.newPage();
      const cachedErrors = [];
      cachedPage.on('pageerror', (error) => cachedErrors.push(error.message));
      await cachedPage.goto(base, { waitUntil: 'load' });
      await cachedPage.waitForSelector('[data-testid="free-text-consent"]', { timeout: 20000 });
      const cachedState = await cachedPage.evaluate(() => ({
        cachedBody: document.querySelector('[data-testid="free-text-consent"]')?.textContent ?? '',
        load: Boolean(document.querySelector('[data-testid="free-text-load"]')),
        consentButton: Boolean(
          document.querySelector('[data-testid="free-text-consent-button"]'),
        ),
        input: Boolean(document.querySelector('[data-testid="free-text-input"]')),
      }));
      assert(cachedState.load, 'remembered consent must offer the cached Load action');
      assert(
        !cachedState.consentButton,
        'remembered consent must not ask for consent again',
      );
      assert(
        cachedState.cachedBody.includes('You allowed this model on this browser before'),
        `remembered consent body is missing: ${cachedState.cachedBody}`,
      );
      assert(cachedState.input, 'free-text input is missing on a remembered-consent visit');
      const cachedModelRequests = cachedRequests.filter((url) => isModelHost(url));
      assert(
        cachedModelRequests.length === 0,
        `remembered-consent first paint requested a model host: ${cachedModelRequests.join(', ')}`,
      );
      assert(
        !cachedRequests.some((url) => /webllm-package|\/lib-[^/]+\.js$/.test(url)),
        `remembered-consent first paint loaded a lazy model chunk: ${cachedRequests.join(', ')}`,
      );
      assert(
        !cachedRequests.some((url) => isExternal(url)),
        `remembered-consent first paint made an external request: ${cachedRequests.join(', ')}`,
      );
      assert(cachedErrors.length === 0, `remembered-consent page errors: ${cachedErrors.join(' | ')}`);
      rememberedConsent = {
        cached: true,
        requests: {
          total: cachedRequests.length,
          external: cachedRequests.filter((url) => isExternal(url)).length,
          modelHosts: cachedModelRequests.length,
          lazyChunks: cachedRequests.filter((url) => /webllm-package|\/lib-[^/]+\.js$/.test(url))
            .length,
        },
      };
      await cachedContext.close();
    }

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

      const rippleNodes = [...state.ripple].sort(
        (left, right) => Number(left.index) - Number(right.index),
      );
      assert(
        rippleNodes.length === expectation.ripple.length,
        `${chipId} expected ${expectation.ripple.length} rippling nodes, got ${rippleNodes.length}`,
      );
      assert(
        rippleNodes.every((node) => node.index !== null),
        `${chipId} highlighted path node is missing data-ripple-index`,
      );
      assert(
        JSON.stringify(rippleNodes.map((node) => node.index)) ===
          JSON.stringify(expectation.ripple.map((_, index) => String(index))),
        `${chipId} data-ripple-index must form 0..${expectation.ripple.length - 1}`,
      );
      assert(
        JSON.stringify(rippleNodes.map((node) => node.id)) === JSON.stringify(expectation.ripple),
        `${chipId} ripple order mismatch\n  expected: ${expectation.ripple.join(', ')}\n  actual:   ${rippleNodes
          .map((node) => node.id)
          .join(', ')}`,
      );
      assert(rippleNodes[0].start, `${chipId} start node must carry data-ripple-start and pulse first`);
      assert(
        rippleNodes.filter((node) => node.start).length === 1,
        `${chipId} expected exactly one data-ripple-start node`,
      );
      assert(
        rippleNodes.every((node) => node.animationName === 'node-ripple'),
        `${chipId} path nodes must carry the ripple animation (got ${rippleNodes
          .map((node) => node.animationName)
          .join(', ')})`,
      );

      if (chipId === 'residual_risk') {
        assert(
          results.alternatives?.rippleOrder[0] === 'DEMO-BRKT-01',
          'alternatives ripple must have started at DEMO-BRKT-01 before the switch',
        );
        assert(
          !state.highlighted.includes('DEMO-BRKT-02'),
          'residual_risk kept a leftover alternatives highlight after the switch',
        );
      }

      results[chipId] = {
        rows: state.rows,
        pathNodes: actualPath,
        rippleOrder: rippleNodes.map((node) => node.id),
        rippleStart: rippleNodes[0].id,
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

    // prefers-reduced-motion: the full static highlight and ripple indices stay,
    // but no pulse animation is attached.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.click('[data-testid="chip-affected_products"]');
    await page.waitForFunction(
      () => {
        const table = document.querySelector('[data-testid="hud-results"]');
        const rows = table ? table.querySelectorAll('tbody tr').length : 0;
        return (
          Boolean(document.querySelector('[data-testid="verified"]')) &&
          rows === 3 &&
          document.querySelectorAll('[data-node-id][data-highlighted="true"]').length > 0
        );
      },
      undefined,
      { timeout: 10000 },
    );
    const reducedMotion = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll('[data-node-id][data-highlighted="true"]'),
      );
      return {
        highlighted: nodes.map((element) => element.getAttribute('data-node-id')).sort(),
        missingIndex: nodes.filter((element) => element.getAttribute('data-ripple-index') === null)
          .length,
        animation: nodes.map((element) => {
          const style = getComputedStyle(element);
          return {
            id: element.getAttribute('data-node-id'),
            name: style.animationName,
            duration: style.animationDuration,
          };
        }),
      };
    });
    assert(
      JSON.stringify(reducedMotion.highlighted) ===
        JSON.stringify([...expected.affected_products.path].sort()),
      `reduced motion dropped the static highlight set: ${reducedMotion.highlighted.join(', ')}`,
    );
    assert(reducedMotion.missingIndex === 0, 'reduced motion dropped data-ripple-index');
    assert(
      reducedMotion.animation.every(
        (entry) => entry.name === 'none' || entry.duration === '0s',
      ),
      `reduced motion must not animate path nodes: ${reducedMotion.animation
        .map((entry) => `${entry.id}=${entry.name}/${entry.duration}`)
        .join(', ')}`,
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });

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

    // WebGPU missing: free-text is disabled with a ja+en notice, no model is
    // fetched, and all five chips still run.
    const noGpuContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    await noGpuContext.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    });
    const noGpuRequests = [];
    noGpuContext.on('request', (request) => noGpuRequests.push(request.url()));
    const noGpuPage = await noGpuContext.newPage();
    const noGpuErrors = [];
    noGpuPage.on('pageerror', (error) => noGpuErrors.push(error.message));
    await noGpuPage.goto(base, { waitUntil: 'load' });
    await noGpuPage.waitForSelector('[data-testid="webgpu-notice"]', { timeout: 20000 });
    await noGpuPage.waitForSelector('[data-testid="chip-affected_products"]:not([disabled])', {
      timeout: 20000,
    });
    const noGpuState = await noGpuPage.evaluate(() => ({
      notice: document.querySelector('[data-testid="webgpu-notice"]')?.textContent ?? '',
      inputDisabled: document.querySelector('[data-testid="free-text-input"]')?.disabled ?? null,
      runDisabled: document.querySelector('[data-testid="free-text-convert"]')?.disabled ?? null,
      consent: Boolean(document.querySelector('[data-testid="free-text-consent"]')),
      chips: document.querySelectorAll('[data-chip-id]').length,
    }));
    assert(noGpuState.notice.length > 0, 'WebGPU notice is empty');
    assert(
      /WebGPU is not available/.test(noGpuState.notice),
      'English WebGPU notice is missing',
    );
    assert(
      noGpuState.inputDisabled === true && noGpuState.runDisabled === true,
      'free-text must be disabled without WebGPU',
    );
    assert(!noGpuState.consent, 'the consent card must not appear without WebGPU');
    assert(noGpuState.chips === 5, `expected 5 chips without WebGPU, got ${noGpuState.chips}`);

    await noGpuPage.selectOption('[data-testid="lang-toggle"]', 'ja');
    await noGpuPage.waitForFunction(() => document.documentElement.lang === 'ja', undefined, {
      timeout: 5000,
    });
    const noGpuNoticeJa = await noGpuPage.locator('[data-testid="webgpu-notice"]').textContent();
    assert(
      noGpuNoticeJa && noGpuNoticeJa.includes('WebGPU を利用できない'),
      'Japanese WebGPU notice is missing',
    );

    const noGpuChips = {};
    for (const [chipId, expectation] of Object.entries(expected)) {
      await noGpuPage.click(`[data-testid="chip-${chipId}"]`);
      await noGpuPage.waitForFunction(
        ({ expectedRows, id }) => {
          const selected = document.querySelector('.chip.is-selected');
          const table = document.querySelector('[data-testid="hud-results"]');
          const rows = table ? table.querySelectorAll('tbody tr').length : 0;
          return (
            selected?.getAttribute('data-chip-id') === id &&
            Boolean(document.querySelector('[data-testid="verified"]')) &&
            rows === expectedRows
          );
        },
        { expectedRows: expectation.rows, id: chipId },
        { timeout: 10000 },
      );
      const highlighted = await noGpuPage.evaluate(
        () =>
          document.querySelectorAll('[data-node-id][data-highlighted="true"]').length,
      );
      assert(highlighted > 0, `${chipId} did not highlight nodes without WebGPU`);
      noGpuChips[chipId] = { rows: expectation.rows, highlighted };
    }
    const noGpuModelRequests = noGpuRequests.filter((url) => isModelHost(url));
    assert(
      noGpuModelRequests.length === 0,
      `WebGPU-missing page requested a model host: ${noGpuModelRequests.join(', ')}`,
    );
    assert(
      !noGpuRequests.some((url) => url.includes('webllm-package') || /\/lib-[^/]+\.js$/.test(url)),
      'WebGPU-missing page loaded the lazy WebLLM chunk',
    );
    assert(noGpuErrors.length === 0, `WebGPU-missing page errors: ${noGpuErrors.join(' | ')}`);
    await noGpuContext.close();

    // Invalid Intent rejected without downloading the model. A test-only route
    // replaces the tiny lazy WebLLM boundary chunk with a stub; the real
    // package chunk (lib-*.js) must never be requested.
    let invalidIntent = null;
    let proposalGate = null;
    let loadCancel = null;
    if (!useLive) {
      const lazyChunk = findLazyWebllmChunk();
      const stubSource = [
        "export const WEBLLM_PACKAGE_TAG = 'ontographia-webllm-package-v1';",
        'class StubEngine {',
        '  constructor(config) { this.config = config || {}; }',
        '  async reload() {',
        "    if (this.config.initProgressCallback) this.config.initProgressCallback({ progress: 1, text: 'stub model ready' });",
        '  }',
        '  async unload() {}',
        '}',
        'StubEngine.prototype.chat = { completions: { create: async () => {',
        '  const output = globalThis.__ONTOGRAPHIA_SMOKE_MODEL_OUTPUT__;',
        "  return { choices: [{ message: { content: String(output == null ? '' : output) } }] };",
        '} } };',
        'export async function createIntentEngine(config) { return new StubEngine(config); }',
      ].join('\n');

      const invalidContext = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      });
      await invalidContext.addInitScript(() => {
        Object.defineProperty(navigator, 'gpu', {
          configurable: true,
          value: { requestAdapter: async () => ({}) },
        });
      });
      const invalidRequests = [];
      invalidContext.on('request', (request) => invalidRequests.push(request.url()));
      await invalidContext.route(`**/assets/${lazyChunk}`, (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', body: stubSource }),
      );
      const invalidPage = await invalidContext.newPage();
      const invalidErrors = [];
      invalidPage.on('pageerror', (error) => invalidErrors.push(error.message));
      await invalidPage.goto(base, { waitUntil: 'load' });
      await invalidPage.waitForSelector('[data-testid="chip-affected_products"]:not([disabled])', {
        timeout: 20000,
      });

      await invalidPage.click('[data-testid="free-text-consent-button"]');
      await invalidPage.fill('[data-testid="free-text-input"]', 'Which products are affected?');
      await invalidPage.waitForFunction(
        () => {
          const run = document.querySelector('[data-testid="free-text-convert"]');
          return Boolean(run) && !run.disabled;
        },
        undefined,
        { timeout: 15000 },
      );

      const extraKeyIntent = {
        start: { class: 'Part', alias: 'part' },
        traverse: [],
        filter: [
          { alias: 'part', property: 'part_number', op: 'eq', value: 'DEMO-BRKT-01' },
        ],
        return: [{ alias: 'part', property: 'part_number', as_name: 'part_number' }],
        limit: 20,
        optional: false,
        cypher: 'MATCH (n) RETURN n',
      };
      const cases = [
        { label: 'invalid JSON', output: 'not json at all', needle: 'invalid JSON' },
        { label: 'Cypher string', output: 'MATCH (n) RETURN n', needle: 'invalid JSON' },
        {
          label: 'extra key object',
          output: JSON.stringify(extraKeyIntent),
          needle: 'unknown key',
        },
      ];
      const invalidRecords = [];
      for (const testCase of cases) {
        await invalidPage.click('[data-testid="chip-affected_products"]');
        await invalidPage.waitForFunction(
          () =>
            Boolean(document.querySelector('[data-testid="verified"]')) &&
            document.querySelectorAll('[data-node-id][data-highlighted="true"]').length > 0,
          undefined,
          { timeout: 10000 },
        );
        await invalidPage.waitForFunction(
          () => !document.querySelector('[data-testid="free-text-error"]'),
          undefined,
          { timeout: 5000 },
        );

        await invalidPage.evaluate((output) => {
          globalThis.__ONTOGRAPHIA_SMOKE_MODEL_OUTPUT__ = output;
        }, testCase.output);
        await invalidPage.click('[data-testid="free-text-convert"]');
        await invalidPage.waitForFunction(
          () => Boolean(document.querySelector('[data-testid="free-text-error"]')),
          undefined,
          { timeout: 10000 },
        );
        await delay(200);
        const after = await invalidPage.evaluate(() => ({
          freeTextError: document.querySelector('[data-testid="free-text-error"]')?.textContent ?? '',
          hudError: document.querySelector('[data-testid="hud-error"]')?.textContent ?? '',
          verified: Boolean(document.querySelector('[data-testid="verified"]')),
          results: Boolean(document.querySelector('[data-testid="hud-results"]')),
          highlights: document.querySelectorAll('[data-node-id][data-highlighted="true"]').length,
          proposal: Boolean(document.querySelector('[data-testid="free-text-proposal"]')),
          runDisabled: document.querySelector('[data-testid="free-text-convert"]')?.disabled ?? null,
        }));
        assert(!after.verified, `${testCase.label} showed the Verified badge`);
        assert(!after.results, `${testCase.label} left a results table`);
        assert(after.highlights === 0, `${testCase.label} left ${after.highlights} highlighted nodes`);
        assert(!after.proposal, `${testCase.label} showed a proposal for rejected output`);
        assert(
          after.freeTextError.length > 0 && after.hudError.length > 0,
          `${testCase.label} did not show both free-text and HUD errors`,
        );
        assert(
          after.freeTextError.includes(testCase.needle),
          `${testCase.label} error did not mention ${JSON.stringify(testCase.needle)}: ${after.freeTextError}`,
        );
        assert(
          after.freeTextError.includes('Nothing was compiled or executed'),
          `${testCase.label} did not render freeTextRejectedBody: ${after.freeTextError}`,
        );
        assert(after.runDisabled === false, `${testCase.label} must leave the run action available`);
        invalidRecords.push({
          case: testCase.label,
          error: after.freeTextError.slice(0, 200),
          verified: after.verified,
          results: after.results,
          highlights: after.highlights,
          proposal: after.proposal,
        });
      }

      const lastEnError = await invalidPage
        .locator('[data-testid="free-text-error"]')
        .textContent();
      await invalidPage.selectOption('[data-testid="lang-toggle"]', 'ja');
      await invalidPage.waitForFunction(() => document.documentElement.lang === 'ja', undefined, {
        timeout: 5000,
      });
      const lastJaError = await invalidPage
        .locator('[data-testid="free-text-error"]')
        .textContent();
      assert(
        lastJaError && lastJaError !== lastEnError && /拒否|失敗|スキーマ/.test(lastJaError),
        'invalid Intent error did not switch to Japanese',
      );

      const invalidModelRequests = invalidRequests.filter((url) => isModelHost(url));
      assert(
        invalidModelRequests.length === 0,
        `stub flow requested a model host: ${invalidModelRequests.join(', ')}`,
      );
      assert(
        !invalidRequests.some((url) => /\/lib-[^/]+\.js$/.test(url)),
        'stub flow fetched the real WebLLM package chunk',
      );
      assert(invalidErrors.length === 0, `invalid-Intent page errors: ${invalidErrors.join(' | ')}`);
      invalidIntent = { lazyChunk, cases: invalidRecords, jaError: lastJaError?.slice(0, 200) };
      await invalidContext.close();

      // SF-1: Convert only proposes. Nothing executes (no Verified badge, no
      // results, no path highlights) until the explicit Run. Cancel discards
      // the proposal and keeps an already-finished run.
      const goldProductsIntent = JSON.stringify(
        JSON.parse(
          readFileSync(
            join(root, 'vendor/ontographia/data/intents/01_affected_products.json'),
            'utf8',
          ),
        ),
      );

      const gateContext = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      });
      await gateContext.addInitScript(() => {
        Object.defineProperty(navigator, 'gpu', {
          configurable: true,
          value: { requestAdapter: async () => ({}) },
        });
      });
      const gateRequests = [];
      gateContext.on('request', (request) => gateRequests.push(request.url()));
      await gateContext.route(`**/assets/${lazyChunk}`, (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', body: stubSource }),
      );
      const gatePage = await gateContext.newPage();
      const gateErrors = [];
      gatePage.on('pageerror', (error) => gateErrors.push(error.message));
      await gatePage.goto(base, { waitUntil: 'load' });
      await gatePage.waitForSelector('[data-testid="chip-affected_products"]:not([disabled])', {
        timeout: 20000,
      });
      await gatePage.click('[data-testid="free-text-consent-button"]');
      await gatePage.fill('[data-testid="free-text-input"]', 'Which products are affected?');
      await gatePage.waitForFunction(
        () => {
          const convert = document.querySelector('[data-testid="free-text-convert"]');
          return Boolean(convert) && !convert.disabled;
        },
        undefined,
        { timeout: 15000 },
      );
      await gatePage.evaluate((output) => {
        globalThis.__ONTOGRAPHIA_SMOKE_MODEL_OUTPUT__ = output;
      }, goldProductsIntent);
      await gatePage.click('[data-testid="free-text-convert"]');
      await gatePage.waitForSelector('[data-testid="free-text-proposal"]', { timeout: 10000 });
      const afterConvert = await snapshot(gatePage);
      assert(!afterConvert.verified, 'Convert showed the Verified badge before Run');
      assert(
        afterConvert.rows === 0 && afterConvert.results === '',
        'Convert left a results table before Run',
      );
      assert(
        afterConvert.highlighted.length === 0,
        `Convert highlighted ${afterConvert.highlighted.length} nodes before Run`,
      );
      const proposalText = await gatePage
        .locator('[data-testid="free-text-proposal"]')
        .textContent();
      assert(
        proposalText.includes('Which products are affected?'),
        `proposal did not name the matched template: ${proposalText}`,
      );
      assert(
        !proposalText.includes('Modified / custom Intent'),
        'a matching gold Intent must not be labelled custom',
      );
      const proposalPath = await gatePage
        .locator('[data-testid="free-text-proposal-path"]')
        .textContent();
      for (const needle of ['Part', 'CONTAINS (in)', 'Assembly']) {
        assert(
          proposalPath.includes(needle),
          `proposal path is missing ${JSON.stringify(needle)}: ${proposalPath}`,
        );
      }

      await gatePage.selectOption('[data-testid="lang-toggle"]', 'ja');
      await gatePage.waitForFunction(() => document.documentElement.lang === 'ja', undefined, {
        timeout: 5000,
      });
      const keptProposal = await gatePage.evaluate(() => ({
        text: document.querySelector('[data-testid="free-text-input"]')?.value ?? '',
        proposal: Boolean(document.querySelector('[data-testid="free-text-proposal"]')),
        path: document.querySelector('[data-testid="free-text-proposal-path"]')?.textContent ?? '',
      }));
      assert(
        keptProposal.text === 'Which products are affected?',
        'language toggle cleared in-progress free-text',
      );
      assert(keptProposal.proposal, 'language toggle cleared the pending proposal');
      assert(keptProposal.path.includes('経路'), 'language toggle did not localize the proposal');

      await gatePage.click('[data-testid="free-text-proposal-run"]');
      await gatePage.waitForFunction(
        () => {
          const table = document.querySelector('[data-testid="hud-results"]');
          return (
            Boolean(document.querySelector('[data-testid="verified"]')) &&
            Boolean(table) &&
            table.querySelectorAll('tbody tr').length === 3
          );
        },
        undefined,
        { timeout: 10000 },
      );
      const afterRun = await snapshot(gatePage);
      assert(afterRun.verified, 'Run did not show the Verified badge');
      assert(afterRun.rows === 3, `Run expected 3 rows, got ${afterRun.rows}`);
      assert(
        JSON.stringify(afterRun.highlighted) ===
          JSON.stringify([...expected.affected_products.path].sort()),
        `Run highlight mismatch: ${afterRun.highlighted.join(', ')}`,
      );
      assert(afterRun.cypher.includes('CYPHER 25'), 'Run HUD is missing compiled Cypher');
      const proposalAfterRun = await gatePage.evaluate(() =>
        Boolean(document.querySelector('[data-testid="free-text-proposal"]')),
      );
      assert(!proposalAfterRun, 'the proposal must be cleared after Run');

      await gatePage.click('[data-testid="free-text-convert"]');
      await gatePage.waitForSelector('[data-testid="free-text-proposal"]', { timeout: 10000 });
      await gatePage.click('[data-testid="free-text-proposal-cancel"]');
      await gatePage.waitForFunction(
        () => !document.querySelector('[data-testid="free-text-proposal"]'),
        undefined,
        { timeout: 5000 },
      );
      const afterCancel = await snapshot(gatePage);
      assert(afterCancel.verified, 'cancelling a proposal cleared the Verified badge');
      assert(afterCancel.rows === 3, 'cancelling a proposal cleared the finished results');
      assert(
        JSON.stringify(afterCancel.highlighted) === JSON.stringify(afterRun.highlighted),
        'cancelling a proposal changed the finished highlights',
      );

      // The same rule applies to a finished chip run: cancelling a proposal
      // must not clear the selected chip, results, or highlights.
      await gatePage.click('[data-testid="chip-affected_products"]');
      await gatePage.waitForFunction(
        () => {
          const table = document.querySelector('[data-testid="hud-results"]');
          const selected = document.querySelector('.chip.is-selected');
          return (
            selected?.getAttribute('data-chip-id') === 'affected_products' &&
            Boolean(document.querySelector('[data-testid="verified"]')) &&
            Boolean(table) &&
            table.querySelectorAll('tbody tr').length === 3
          );
        },
        undefined,
        { timeout: 10000 },
      );
      await gatePage.click('[data-testid="free-text-convert"]');
      await gatePage.waitForSelector('[data-testid="free-text-proposal"]', { timeout: 10000 });
      await gatePage.click('[data-testid="free-text-proposal-cancel"]');
      await gatePage.waitForFunction(
        () => !document.querySelector('[data-testid="free-text-proposal"]'),
        undefined,
        { timeout: 5000 },
      );
      const afterChipCancel = await snapshot(gatePage);
      assert(
        afterChipCancel.selected === 'affected_products' && afterChipCancel.pressed === 'true',
        'cancelling a proposal cleared the selected chip',
      );
      assert(
        afterChipCancel.verified && afterChipCancel.rows === 3,
        'cancelling a proposal cleared the finished chip result',
      );
      assert(
        JSON.stringify(afterChipCancel.highlighted) ===
          JSON.stringify([...expected.affected_products.path].sort()),
        'cancelling a proposal changed the finished chip highlights',
      );
      const gateModelRequests = gateRequests.filter((url) => isModelHost(url));
      assert(
        gateModelRequests.length === 0,
        `proposal flow requested a model host: ${gateModelRequests.join(', ')}`,
      );
      assert(
        !gateRequests.some((url) => /\/lib-[^/]+\.js$/.test(url)),
        'proposal flow fetched the real WebLLM package chunk',
      );
      assert(gateErrors.length === 0, `proposal flow page errors: ${gateErrors.join(' | ')}`);
      proposalGate = {
        afterConvert: {
          verified: afterConvert.verified,
          rows: afterConvert.rows,
          highlights: afterConvert.highlighted.length,
        },
        matchedTemplate: proposalText.includes('Which products are affected?'),
        path: proposalPath.trim().slice(0, 200),
        keptOnLanguageToggle: keptProposal.proposal,
        afterRun: {
          verified: afterRun.verified,
          rows: afterRun.rows,
          highlights: afterRun.highlighted,
        },
        cancelKeptResult: {
          verified: afterCancel.verified,
          rows: afterCancel.rows,
          highlightsKept:
            JSON.stringify(afterCancel.highlighted) === JSON.stringify(afterRun.highlighted),
        },
        cancelKeptChipResult: {
          chip: afterChipCancel.selected,
          verified: afterChipCancel.verified,
          rows: afterChipCancel.rows,
          highlightsKept:
            JSON.stringify(afterChipCancel.highlighted) ===
            JSON.stringify([...expected.affected_products.path].sort()),
        },
        requests: {
          total: gateRequests.length,
          modelHosts: gateModelRequests.length,
        },
      };
      await gateContext.close();

      // N-4: cancel during model loading returns to the remembered-consent
      // state and must not clear an already-finished chip result. The stub load
      // never resolves, so no real model is downloaded.
      const pendingStubSource = [
        "export const WEBLLM_PACKAGE_TAG = 'ontographia-webllm-package-v1';",
        'class StubEngine {',
        '  constructor(config) { this.config = config || {}; }',
        '  reload() {',
        "    if (this.config.initProgressCallback) this.config.initProgressCallback({ progress: 0.42, text: 'stub download pending' });",
        '    return new Promise(() => {});',
        '  }',
        '  async unload() {}',
        '}',
        'StubEngine.prototype.chat = { completions: { create: async () => ({ choices: [{ message: { content: "" } }] }) } };',
        'export async function createIntentEngine(config) { return new StubEngine(config); }',
      ].join('\n');

      const cancelContext = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      });
      await cancelContext.addInitScript(() => {
        Object.defineProperty(navigator, 'gpu', {
          configurable: true,
          value: { requestAdapter: async () => ({}) },
        });
      });
      const cancelRequests = [];
      cancelContext.on('request', (request) => cancelRequests.push(request.url()));
      await cancelContext.route(`**/assets/${lazyChunk}`, (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', body: pendingStubSource }),
      );
      const cancelPage = await cancelContext.newPage();
      const cancelErrors = [];
      cancelPage.on('pageerror', (error) => cancelErrors.push(error.message));
      await cancelPage.goto(base, { waitUntil: 'load' });
      await cancelPage.waitForSelector('[data-testid="chip-affected_products"]:not([disabled])', {
        timeout: 20000,
      });
      await cancelPage.click('[data-testid="chip-affected_products"]');
      await cancelPage.waitForFunction(
        () => {
          const table = document.querySelector('[data-testid="hud-results"]');
          return (
            Boolean(document.querySelector('[data-testid="verified"]')) &&
            Boolean(table) &&
            table.querySelectorAll('tbody tr').length === 3
          );
        },
        undefined,
        { timeout: 10000 },
      );
      await cancelPage.click('[data-testid="free-text-consent-button"]');
      await cancelPage.waitForSelector('[data-testid="free-text-progress"]', { timeout: 10000 });
      await cancelPage.click('[data-testid="free-text-cancel"]');
      await cancelPage.waitForSelector('[data-testid="free-text-load"]', { timeout: 5000 });
      const afterLoadCancel = await cancelPage.evaluate(() => ({
        cached: Boolean(document.querySelector('[data-testid="free-text-load"]')),
        consentButton: Boolean(
          document.querySelector('[data-testid="free-text-consent-button"]'),
        ),
        cancelled: Boolean(document.querySelector('[data-testid="free-text-cancelled"]')),
        verified: Boolean(document.querySelector('[data-testid="verified"]')),
        rows:
          document.querySelector('[data-testid="hud-results"]')?.querySelectorAll('tbody tr')
            .length ?? 0,
        highlights: document.querySelectorAll('[data-node-id][data-highlighted="true"]').length,
      }));
      assert(afterLoadCancel.cached, 'load cancel must return to the cached consent view');
      assert(!afterLoadCancel.consentButton, 'load cancel must not ask for consent again');
      assert(afterLoadCancel.cancelled, 'load cancel notice is missing');
      assert(
        afterLoadCancel.verified && afterLoadCancel.rows === 3,
        'load cancel cleared the finished chip result',
      );
      assert(
        afterLoadCancel.highlights === expected.affected_products.path.length,
        `load cancel changed the finished highlights (${afterLoadCancel.highlights})`,
      );
      const cancelModelRequests = cancelRequests.filter((url) => isModelHost(url));
      assert(
        cancelModelRequests.length === 0,
        `load-cancel flow requested a model host: ${cancelModelRequests.join(', ')}`,
      );
      assert(
        !cancelRequests.some((url) => /\/lib-[^/]+\.js$/.test(url)),
        'load-cancel flow fetched the real WebLLM package chunk',
      );
      assert(cancelErrors.length === 0, `load-cancel flow page errors: ${cancelErrors.join(' | ')}`);
      loadCancel = {
        view: 'cached',
        notice: afterLoadCancel.cancelled,
        keptChipResult: {
          verified: afterLoadCancel.verified,
          rows: afterLoadCancel.rows,
          highlights: afterLoadCancel.highlights,
        },
        requests: {
          total: cancelRequests.length,
          modelHosts: cancelModelRequests.length,
        },
      };
      await cancelContext.close();
    }

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
          ripple: {
            orders: Object.fromEntries(
              Object.entries(results).map(([chipId, result]) => [chipId, result.rippleOrder]),
            ),
            reducedMotion: {
              highlighted: reducedMotion.highlighted,
              animation: reducedMotion.animation,
            },
          },
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
          freeText: {
            consentGate: consentState,
            consentRequests: {
              total: consentRequests.length,
              external: consentRequests.filter((url) => isExternal(url)).length,
            },
            webgpuMissing: {
              notice: noGpuState.notice,
              noticeJa: noGpuNoticeJa,
              inputDisabled: noGpuState.inputDisabled,
              runDisabled: noGpuState.runDisabled,
              chips: noGpuChips,
              requests: noGpuRequests.length,
            },
            invalidIntent,
            rememberedConsent,
            proposalGate,
            loadCancel,
          },
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
