// Headed WebGPU smoke test: real model download through system Chrome.
//
// Unlike `npm run smoke`, this script downloads the WebLLM model weights
// (about 695 MB) into a throwaway browser profile and asserts that the
// download completes under the production CSP. It always uses the system
// Google Chrome channel with WebGPU (Metal on macOS); there is no headless or
// bundled-Chromium fallback because the model needs a real GPU adapter.
//
// Run after `npm run verify` (which produces dist/) or point it at a live
// deploy with SMOKE_BASE_URL.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const liveBase = process.env.SMOKE_BASE_URL?.trim();
const port = Number(process.env.SMOKE_PORT ?? 4174);
const base = (liveBase || `http://127.0.0.1:${port}`).replace(/\/?$/, '/');
const useLive = Boolean(liveBase);
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const readyTimeoutMs = 4 * 60 * 1000;
// The documented download is 695,242,752 bytes. CDN shards can change, so the
// floor is deliberately loose; it only proves a substantial model download.
const minWeightBytes = 100 * 1024 * 1024;
const minWeightResponsesWithoutLength = 5;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** Hosts that serve WebLLM model weights (repository metadata + CDN shards). */
const isWeightHost = (hostname) =>
  hostname === 'huggingface.co' || hostname === 'hf.co' || hostname.endsWith('.hf.co');

/** Hosts allowed to serve the WebLLM model (weights and the model_lib WASM). */
const isModelHost = (hostname) =>
  isWeightHost(hostname) || hostname === 'raw.githubusercontent.com';

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

async function readUi(page) {
  return page.evaluate(() => {
    const input = document.querySelector('[data-testid="free-text-input"]');
    return {
      consentButton: Boolean(
        document.querySelector('[data-testid="free-text-consent-button"]'),
      ),
      loadButton: Boolean(document.querySelector('[data-testid="free-text-load"]')),
      noticeText: document.querySelector('[data-testid="webgpu-notice"]')?.textContent ?? '',
      errorText: document.querySelector('[data-testid="free-text-error"]')?.textContent ?? '',
      progressText:
        document.querySelector('[data-testid="free-text-progress"]')?.textContent ?? '',
      inputVisible: Boolean(input) && input.getBoundingClientRect().height > 0,
      inputDisabled: input ? input.disabled : null,
      convert: Boolean(document.querySelector('[data-testid="free-text-convert"]')),
      cspViolations: window.__cspViolations || [],
    };
  });
}

async function readWebGpu(page) {
  return page.evaluate(async () => {
    const result = {
      hasNavigatorGpu: typeof navigator.gpu !== 'undefined' && Boolean(navigator.gpu),
      adapter: null,
      adapterError: null,
      userAgent: navigator.userAgent,
    };
    if (!navigator.gpu) return result;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        result.adapter = { available: false };
        return result;
      }
      const info = adapter.info || {};
      result.adapter = {
        available: true,
        isFallbackAdapter: adapter.isFallbackAdapter ?? null,
        info: {
          vendor: info.vendor || null,
          architecture: info.architecture || null,
          device: info.device || null,
          description: info.description || null,
        },
      };
    } catch (error) {
      result.adapterError = String(error);
    }
    return result;
  });
}

async function main() {
  if (!useLive && !existsSync(join(root, 'dist/index.html'))) {
    throw new Error('dist/index.html is missing; run `npm run verify` (or `npm run build`) first');
  }

  let server;
  if (!useLive) {
    server = spawn(
      'npx',
      ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so the preview and its esbuild child can be stopped
        // together; otherwise the script can hang on inherited stdio.
        detached: process.platform !== 'win32',
      },
    );
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'ontographia-smoke-webgpu-'));
  const summary = {
    ok: false,
    base,
    browser: 'system-chrome',
    headless: false,
    cleanProfile: true,
    webgpu: null,
    consentClicked: false,
    modelReady: false,
    readyElapsedSeconds: null,
    totalElapsedSeconds: null,
    downloads: null,
    cspViolations: null,
    failedModelRequests: [],
    pageErrors: [],
    error: null,
  };
  const startedAt = Date.now();

  // Request tracking is installed before navigation.
  const responses = [];
  const failedRequests = [];
  const pageErrors = [];
  let context;

  try {
    if (!useLive) await waitForServer();
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chrome',
        headless: false,
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      });
    } catch (error) {
      throw new Error(
        `Could not launch headed system Chrome (channel "chrome"). ` +
          `Install Google Chrome and make sure WebGPU works on this machine.\n${error.message}`,
      );
    }

    // Capture CSP violations for the whole life of every document in this
    // context, before the first navigation.
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

    context.on('response', (response) => {
      responses.push({
        url: response.url(),
        host: hostOf(response.url()),
        status: response.status(),
        contentLength: response.headers()['content-length'] ?? null,
        contentType: response.headers()['content-type'] ?? '',
      });
    });
    context.on('requestfailed', (request) => {
      failedRequests.push({
        url: request.url(),
        host: hostOf(request.url()),
        failure: request.failure()?.errorText ?? null,
        resourceType: request.resourceType(),
      });
    });

    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(base, { waitUntil: 'load', timeout: 60000 });

    const webgpu = await readWebGpu(page);
    summary.webgpu = webgpu;
    assert(webgpu.hasNavigatorGpu, 'navigator.gpu is missing; this smoke needs a WebGPU browser');
    assert(
      webgpu.adapter?.available,
      `WebGPU adapter unavailable: ${webgpu.adapterError ?? JSON.stringify(webgpu.adapter)}`,
    );

    await page.waitForSelector(
      '[data-testid="free-text-consent-button"], [data-testid="free-text-load"], [data-testid="webgpu-notice"], [data-testid="free-text-error"]',
      { timeout: 30000 },
    );
    const before = await readUi(page);
    assert(!before.noticeText, `WebGPU notice is visible: ${before.noticeText.trim()}`);
    assert(!before.errorText, `free-text error before consent: ${before.errorText.trim()}`);
    assert(
      before.consentButton,
      before.loadButton
        ? 'only the cached Load action appeared: the browser profile was not clean'
        : 'the free-text consent button did not appear',
    );

    await page.click('[data-testid="free-text-consent-button"]');
    summary.consentClicked = true;
    const downloadStartedAt = Date.now();

    // Poll for readiness so the first error or WebGPU notice fails immediately
    // instead of waiting out the full timeout.
    let ui = null;
    while (Date.now() < downloadStartedAt + readyTimeoutMs) {
      ui = await readUi(page);
      assert(
        !ui.noticeText,
        `WebGPU notice appeared while loading the model: ${ui.noticeText.trim()}`,
      );
      assert(!ui.errorText, `free-text error while loading the model: ${ui.errorText.trim()}`);
      if (ui.inputVisible && ui.inputDisabled === false && ui.convert && !ui.progressText) break;
      await delay(500);
    }
    assert(
      ui && ui.inputVisible && ui.inputDisabled === false && ui.convert && !ui.progressText,
      `the model was not ready within ${readyTimeoutMs / 1000}s; last progress: ${
        ui?.progressText?.trim().slice(0, 300) ?? '(none)'
      }`,
    );
    summary.modelReady = true;
    summary.readyElapsedSeconds = (Date.now() - downloadStartedAt) / 1000;

    // Model weights: 200 responses from the Hugging Face repository and its
    // CDN shard hosts, measured with content-length where the CDN provides it.
    const weightResponses = responses.filter(
      (response) => isWeightHost(response.host) && response.status === 200,
    );
    const weightBytes = weightResponses.reduce((total, response) => {
      const length = Number(response.contentLength);
      return Number.isFinite(length) && length > 0 ? total + length : total;
    }, 0);
    const measuredWeightResponses = weightResponses.filter((response) => {
      const length = Number(response.contentLength);
      return Number.isFinite(length) && length > 0;
    }).length;
    const wasmLibResponses = responses.filter(
      (response) => response.host === 'raw.githubusercontent.com' && response.status === 200,
    );
    const hosts = Array.from(new Set(weightResponses.map((response) => response.host))).sort();

    assert(weightResponses.length > 0, 'no successful model-weight response was observed');
    if (measuredWeightResponses > 0) {
      assert(
        weightBytes >= minWeightBytes,
        `measured model-weight download is too small: ${weightBytes} bytes`,
      );
    } else {
      assert(
        weightResponses.length >= minWeightResponsesWithoutLength,
        `no content-length was reported and only ${weightResponses.length} weight response(s) were seen`,
      );
    }
    assert(
      wasmLibResponses.length > 0,
      'no successful model_lib response from raw.githubusercontent.com was observed',
    );

    const modelHostFailures = [];
    for (const failure of failedRequests) {
      if (isModelHost(failure.host)) modelHostFailures.push({ ...failure, kind: 'requestfailed' });
    }
    for (const response of responses) {
      if (isModelHost(response.host) && response.status >= 400) {
        modelHostFailures.push({
          url: response.url,
          host: response.host,
          failure: `HTTP ${response.status}`,
          kind: 'response',
        });
      }
    }
    summary.downloads = {
      weightResponses: weightResponses.length,
      measuredWeightResponses,
      weightBytes,
      weightMegabytes:
        measuredWeightResponses > 0 ? Number((weightBytes / 1_000_000).toFixed(1)) : null,
      weightHosts: hosts,
      wasmLibResponses: wasmLibResponses.length,
      wasmLibUrls: wasmLibResponses.map((response) => response.url),
    };
    summary.failedModelRequests = modelHostFailures;
    assert(
      modelHostFailures.length === 0,
      `model-host request(s) failed: ${modelHostFailures
        .map((entry) => `${entry.host} ${entry.failure}`)
        .join(', ')}`,
    );

    const cspViolations = await page.evaluate(() => window.__cspViolations || []);
    summary.cspViolations = cspViolations;
    summary.cspViolationCount = cspViolations.length;
    assert(cspViolations.length === 0, `CSP violation(s): ${JSON.stringify(cspViolations)}`);

    summary.pageErrors = pageErrors;
    assert(pageErrors.length === 0, `page error(s): ${pageErrors.join(' | ')}`);
    summary.ok = true;
    summary.totalElapsedSeconds = (Date.now() - startedAt) / 1000;

    console.log(JSON.stringify(summary, null, 2));
    console.log('smoke:webgpu OK');
  } catch (error) {
    summary.error = error.message;
    summary.totalElapsedSeconds = (Date.now() - startedAt) / 1000;
    if (context) {
      try {
        const page = context.pages()[0];
        if (page) {
          summary.cspViolations = await page.evaluate(() => window.__cspViolations || []);
          summary.cspViolationCount = summary.cspViolations.length;
          // Failure screenshots go outside the deleted profile, and are never committed.
          const screenshotPath = join(
            mkdtempSync(join(tmpdir(), 'ontographia-smoke-webgpu-fail-')),
            'failure.png',
          );
          await page.screenshot({ path: screenshotPath });
          summary.screenshot = screenshotPath;
        }
      } catch {
        // Best effort only; the original failure is what matters.
      }
    }
    console.log(JSON.stringify(summary, null, 2));
    throw error;
  } finally {
    try {
      if (context) await context.close();
    } catch {
      // Chrome may already be gone.
    }
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // A leftover temp profile is harmless.
    }
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
    console.error('smoke:webgpu FAILED:', error.message);
    process.exit(1);
  });
