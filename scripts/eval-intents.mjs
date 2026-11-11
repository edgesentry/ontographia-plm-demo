// Local, opt-in free-text prompt-set check. NOT a benchmark and NOT part of
// `npm run verify` / `npm run smoke`: it downloads the ~695 MB model once and
// needs a WebGPU-capable browser. Run it explicitly with:
//
//   npm run verify   # produce dist/
//   npm run eval:intents
//
// It opens the real consent flow, loads the real model, and drives the real UI
// for every prompt in src/data/intentPromptSet.ts. Output is JSON counts; no
// numbers are inferred.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.EVAL_PORT ?? 4180);
const base = `http://127.0.0.1:${port}/`;
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function loadTsModule(relativePath) {
  const source = readFileSync(join(root, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relativePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

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
  try {
    return await chromium.launch();
  } catch {
    // fall through to the system Chrome channel
  }
  return chromium.launch({ channel: 'chrome' });
}

async function main() {
  if (!existsSync(join(root, 'dist/index.html'))) {
    throw new Error('dist/index.html is missing; run `npm run verify` (or `npm run build`) first');
  }

  const goldFiles = [
    '01_affected_products.json',
    '02_affected_bop.json',
    '03_affected_customers.json',
    '04_alternatives.json',
    '05_residual_risk.json',
  ];
  const goldByFile = new Map();
  for (const file of goldFiles) {
    const intent = JSON.parse(
      readFileSync(join(root, 'vendor/ontographia/data/intents', file), 'utf8'),
    );
    goldByFile.set(file, intent);
  }
  const { validateIntent, canonicalIntent } = await loadTsModule('src/lib/intent-schema.ts');
  const { intentPromptSet } = await loadTsModule('src/data/intentPromptSet.ts');
  const goldCanonical = new Map();
  for (const [file, intent] of goldByFile) {
    const validated = validateIntent(intent);
    if (!validated.ok) throw new Error(`gold Intent ${file} is invalid: ${validated.errors.join('; ')}`);
    goldCanonical.set(file, canonicalIntent(validated.value));
  }

  const server = spawn(
    'npx',
    ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );
  let serverLog = '';
  server.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });

  let browser;
  try {
    await waitForServer();
    browser = await launchBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(base, { waitUntil: 'load' });
    const webgpu = await page.evaluate(async () => {
      if (!navigator.gpu) return false;
      try {
        return Boolean(await navigator.gpu.requestAdapter());
      } catch {
        return false;
      }
    });
    if (!webgpu) {
      console.log(
        JSON.stringify(
          { ran: false, reason: 'WebGPU unavailable in this browser session', prompts: intentPromptSet.length },
          null,
          2,
        ),
      );
      return;
    }

    await page.waitForSelector('[data-testid="free-text-consent"]', { timeout: 30000 });
    await page.click('[data-testid="free-text-consent-button"]');
    // The first run downloads and initializes the model. Give it a generous
    // window; print progress so a timeout is diagnosable.
    const progressSeen = [];
    const progressTimer = setInterval(async () => {
      try {
        const text = await page.evaluate(
          () => document.querySelector('[data-testid="free-text-progress"]')?.textContent ?? '',
        );
        if (text) progressSeen.push(text.trim());
      } catch {
        // page busy or closing
      }
    }, 5000);
    await page.waitForFunction(
      () => {
        const input = document.querySelector('[data-testid="free-text-input"]');
        return Boolean(input) && !input.disabled;
      },
      undefined,
      { timeout: 900000 },
    );
    clearInterval(progressTimer);

    const results = [];
    let stoppedEarly = false;
    for (const prompt of intentPromptSet) {
      await page.fill('[data-testid="free-text-input"]', prompt.text);
      const run = page.locator('[data-testid="free-text-run"]');
      await run.waitFor({ state: 'visible', timeout: 10000 });
      if (await run.isDisabled()) {
        results.push({ ...prompt, outcome: 'reject', detail: 'run action disabled (model unavailable)' });
        stoppedEarly = true;
        break;
      }
      await run.click();
      const outcome = await page.waitForFunction(
        () => {
          if (document.querySelector('[data-testid="verified"]')) return 'ok';
          if (document.querySelector('[data-testid="free-text-error"]')) return 'error';
          return false;
        },
        undefined,
        { timeout: 120000 },
      );
      const state = await outcome.jsonValue();
      if (state === 'ok') {
        const rawIntent = await page.locator('[data-testid="hud-intent"]').textContent();
        const parsed = JSON.parse(rawIntent ?? '{}');
        const validated = validateIntent(parsed);
        if (!validated.ok) {
          results.push({ ...prompt, outcome: 'reject', detail: `schema: ${validated.errors.join('; ')}` });
          continue;
        }
        const actual = canonicalIntent(validated.value);
        const expected = goldCanonical.get(prompt.intent_file);
        results.push({
          ...prompt,
          outcome: actual === expected ? 'gold-match' : 'misclassification',
          intent: validated.value,
        });
      } else {
        const detail = await page.locator('[data-testid="free-text-error"]').textContent();
        const text = (detail ?? '').slice(0, 300);
        const outcome = /could not compile it/i.test(text) ? 'compile-reject' : 'reject';
        results.push({ ...prompt, outcome, detail: text });
      }
    }

    const schemaPass = results.filter((entry) =>
      ['gold-match', 'misclassification', 'compile-reject'].includes(entry.outcome),
    ).length;
    const goldMatch = results.filter((entry) => entry.outcome === 'gold-match').length;
    const misclassification = results.filter(
      (entry) => entry.outcome === 'misclassification',
    ).length;
    const compileReject = results.filter((entry) => entry.outcome === 'compile-reject').length;
    const reject =
      results.filter((entry) => entry.outcome === 'reject').length + compileReject;
    const counts = {
      prompts: results.length,
      schemaPass,
      goldMatch,
      misclassification,
      reject,
      compileReject,
      note: 'schemaPass includes schema-valid Intents that the WASM compiler then rejected; reject counts those plus parse/schema rejects.',
    };
    const perIntent = {};
    for (const file of goldFiles) {
      const entries = results.filter((entry) => entry.intent_file === file);
      perIntent[file] = {
        prompts: entries.length,
        schemaPass: entries.filter((entry) =>
          ['gold-match', 'misclassification', 'compile-reject'].includes(entry.outcome),
        ).length,
        goldMatch: entries.filter((entry) => entry.outcome === 'gold-match').length,
        misclassification: entries.filter((entry) => entry.outcome === 'misclassification').length,
        reject:
          entries.filter((entry) => entry.outcome === 'reject').length +
          entries.filter((entry) => entry.outcome === 'compile-reject').length,
        compileReject: entries.filter((entry) => entry.outcome === 'compile-reject').length,
      };
    }

    console.log(
      JSON.stringify(
        {
          ran: true,
          base,
          model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
          counts,
          perIntent,
          stoppedEarly,
          results,
          progressSamples: progressSeen.slice(-5),
          pageErrors,
        },
        null,
        2,
      ),
    );
  } finally {
    if (browser) await browser.close();
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
    if (serverLog.trim()) process.stderr.write(serverLog);
    await delay(200);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('eval FAILED:', error.message);
    process.exit(1);
  });
