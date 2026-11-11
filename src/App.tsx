import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChipList } from './components/ChipList';
import { CrossLaneEdges } from './components/CrossLaneEdges';
import {
  FreeTextPanel,
  type FreeTextError,
  type FreeTextNotice,
  type FreeTextPhase,
} from './components/FreeTextPanel';
import { Hud, type HudResult, type RunError } from './components/Hud';
import { Swimlane } from './components/Swimlane';
import { messages, type Lang, type MessageKey } from './i18n';
import { executeIntent } from './lib/executor';
import { chips, graph, ontology, resolveIntentByPath, type Chip } from './lib/data';
import {
  canonicalIntent,
  parseIntentJson,
  validateIntent,
  type ValidIntent,
} from './lib/intent-schema';
import { loadOntographia, type Ontographia } from './lib/ontographia';
import {
  INTENT_MODEL_ID,
  INTENT_ROUTE_TEMPLATES,
  loadIntentModel,
  type LoadedIntentModel,
} from './lib/webllm';

type EngineState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; og: Ontographia };

type GpuLike = { requestAdapter(): Promise<unknown> };

interface CompiledIntent {
  query: string;
  params: Record<string, unknown>;
}

/**
 * A validated Intent that has been compiled but not executed. It only becomes a
 * run when the user confirms it in the free-text panel.
 */
interface FreeTextProposal {
  intent: ValidIntent;
  cypher: CompiledIntent;
  templateFile: string | null;
}

const CONSENT_KEY = 'ontographia.freeTextConsent.v1';
const FREE_TEXT_CHIP_ID = 'free-text';

/** Canonical form of each closed-set template, keyed by gold Intent filename. */
const TEMPLATE_CANONICAL = new Map<string, string>();
for (const template of INTENT_ROUTE_TEMPLATES) {
  const validated = validateIntent(template.intent);
  if (validated.ok) TEMPLATE_CANONICAL.set(template.file, canonicalIntent(validated.value));
}

/** Return the gold template this Intent matches exactly, or null when modified. */
function matchRouteTemplate(intent: ValidIntent): string | null {
  const canonical = canonicalIntent(intent);
  for (const [file, expected] of TEMPLATE_CANONICAL) {
    if (canonical === expected) return file;
  }
  return null;
}

/** Readable start -> traverse summary for the confirm step. */
function summarizeIntentPath(intent: ValidIntent): string {
  const parts = [intent.start.class];
  for (const step of intent.traverse) {
    parts.push(`${step.relationship} (${step.direction})`, step.to.class);
  }
  return parts.join(' → ');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Local capability check only; it does not fetch anything. */
async function detectWebGpu(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

function hasStoredConsent(): boolean {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === INTENT_MODEL_ID;
  } catch {
    return false;
  }
}

function storeConsent(): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, INTENT_MODEL_ID);
  } catch {
    // Storage can be unavailable (private mode, disabled cookies). The model
    // still loads for this tab; only the remembered-consent shortcut is lost.
  }
}

export function App() {
  const [lang, setLang] = useState<Lang>(() =>
    navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en',
  );
  const [engine, setEngine] = useState<EngineState>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [result, setResult] = useState<HudResult | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);
  const runToken = useRef(0);

  const [freeTextPhase, setFreeTextPhase] = useState<FreeTextPhase>('checking');
  const [freeTextProgress, setFreeTextProgress] = useState(0);
  const [freeTextProgressText, setFreeTextProgressText] = useState('');
  const [freeTextNotice, setFreeTextNotice] = useState<FreeTextNotice>(null);
  const [freeTextError, setFreeTextError] = useState<FreeTextError | null>(null);
  const [freeTextValue, setFreeTextValue] = useState('');
  const [freeTextProposal, setFreeTextProposal] = useState<FreeTextProposal | null>(null);
  const modelRef = useRef<LoadedIntentModel | null>(null);
  const modelAbortRef = useRef<AbortController | null>(null);
  const modelLoadToken = useRef(0);

  const t = (key: MessageKey) => messages[lang][key];

  const load = useCallback(() => {
    runToken.current += 1;
    setEngine({ status: 'loading' });
    setResult(null);
    setRunError(null);
    loadOntographia().then(
      (og) => setEngine({ status: 'ready', og }),
      (error: unknown) => setEngine({ status: 'error', message: errorText(error) }),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // WebGPU capability check only. No model chunk, weights, or model_lib is
  // requested here; a model load starts only from an explicit consent action.
  useEffect(() => {
    let cancelled = false;
    detectWebGpu().then((supported) => {
      if (cancelled) return;
      if (!supported) {
        setFreeTextPhase('unsupported');
        return;
      }
      setFreeTextPhase(hasStoredConsent() ? 'cached' : 'consent');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      modelLoadToken.current += 1;
      modelAbortRef.current?.abort();
      if (modelRef.current) void modelRef.current.unload();
      modelRef.current = null;
    },
    [],
  );

  const loadModel = useCallback(() => {
    modelAbortRef.current?.abort();
    const token = modelLoadToken.current + 1;
    modelLoadToken.current = token;
    const abort = new AbortController();
    modelAbortRef.current = abort;
    setFreeTextError(null);
    setFreeTextNotice(null);
    setFreeTextProposal(null);
    setFreeTextPhase('loading');
    setFreeTextProgress(0);
    setFreeTextProgressText('');

    loadIntentModel({
      signal: abort.signal,
      onProgress: (report) => {
        if (modelLoadToken.current !== token) return;
        setFreeTextProgress(report.progress);
        setFreeTextProgressText(report.text);
      },
    }).then(
      (model) => {
        if (modelLoadToken.current !== token || abort.signal.aborted) {
          void model.unload();
          return;
        }
        const previous = modelRef.current;
        modelRef.current = model;
        if (previous) void previous.unload();
        setFreeTextProgress(1);
        setFreeTextPhase('ready');
      },
      (error: unknown) => {
        if (modelLoadToken.current !== token) return;
        if (abort.signal.aborted) {
          setFreeTextPhase(hasStoredConsent() ? 'cached' : 'consent');
          setFreeTextNotice('cancelled');
          return;
        }
        setFreeTextPhase('error');
        setFreeTextError({ kind: 'load', message: errorText(error) });
      },
    );
  }, []);

  const grantConsent = useCallback(() => {
    storeConsent();
    loadModel();
  }, [loadModel]);

  const cancelModelLoad = useCallback(() => {
    modelLoadToken.current += 1;
    modelAbortRef.current?.abort();
    modelAbortRef.current = null;
    setFreeTextProgress(0);
    setFreeTextProgressText('');
    setFreeTextPhase(hasStoredConsent() ? 'cached' : 'consent');
    setFreeTextNotice('cancelled');
  }, []);

  const runChip = async (chip: Chip) => {
    if (engine.status !== 'ready') return;
    if (freeTextPhase === 'generating') setFreeTextPhase('ready');
    setFreeTextProposal(null);
    if (
      freeTextError &&
      (freeTextError.kind === 'invalid' ||
        freeTextError.kind === 'compile' ||
        freeTextError.kind === 'executor')
    ) {
      setFreeTextError(null);
    }
    const token = runToken.current + 1;
    runToken.current = token;
    setSelectedId(chip.chip_id);
    // Clear the previous run first so highlights/results never linger into a
    // new (or failing) run. Yield once so React can paint the cleared state.
    setResult(null);
    setRunError(null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (runToken.current !== token) return;

    let cypher: { query: string; params: Record<string, unknown> };
    let intent: object;
    try {
      intent = resolveIntentByPath(chip.intent_path) as object;
      cypher = engine.og.buildCypher(ontology, intent, {
        dialect: 'cypher25',
        ontologyPathHint: 'plm.native.yaml',
      });
    } catch (error) {
      setRunError({ kind: 'compile', message: errorText(error) });
      return;
    }

    try {
      const execution = executeIntent(graph, intent, ontology);
      if (runToken.current !== token) return;
      setResult({ chipId: chip.chip_id, intent: execution.intent, cypher: cypher.query, params: cypher.params, execution });
    } catch (error) {
      setRunError({ kind: 'executor', message: errorText(error) });
    }
  };

  const runFreeTextConvert = async () => {
    const text = freeTextValue.trim();
    const model = modelRef.current;
    if (!text || !model || freeTextPhase !== 'ready' || engine.status !== 'ready') return;

    const token = runToken.current + 1;
    runToken.current = token;
    setFreeTextPhase('generating');
    setFreeTextError(null);
    setFreeTextNotice(null);
    setFreeTextProposal(null);

    let raw: string;
    try {
      raw = await model.generate(text);
    } catch (error) {
      if (runToken.current !== token) return;
      // A generation/OOM failure keeps an already-finished chip result visible.
      setFreeTextPhase('error');
      setFreeTextError({ kind: 'generate', message: errorText(error) });
      return;
    }
    if (runToken.current !== token) return;

    // Rejection clears any previous run: the model output is untrusted, and a
    // rejected attempt must never leave stale highlights on screen.
    const reject = (kind: 'invalid' | 'compile', message: string) => {
      setResult(null);
      setRunError(null);
      setSelectedId(null);
      setFreeTextPhase('ready');
      setFreeTextError({ kind, message });
      setRunError({ kind, message });
    };

    const parsed = parseIntentJson(raw);
    if (!parsed.ok) {
      reject('invalid', parsed.error);
      return;
    }

    const validated = validateIntent(parsed.value);
    if (!validated.ok) {
      reject('invalid', validated.errors.join('; '));
      return;
    }

    let cypher: CompiledIntent;
    try {
      cypher = engine.og.buildCypher(ontology, validated.value, {
        dialect: 'cypher25',
        ontologyPathHint: 'plm.native.yaml',
      });
    } catch (error) {
      reject('compile', errorText(error));
      return;
    }

    // Convert only compiles a proposal. It never calls executeIntent, so no
    // HUD result, Verified badge, ripple, or highlight is produced yet.
    setFreeTextPhase('ready');
    setFreeTextProposal({
      intent: validated.value,
      cypher,
      templateFile: matchRouteTemplate(validated.value),
    });
  };

  const runFreeTextProposal = () => {
    const proposal = freeTextProposal;
    if (!proposal || engine.status !== 'ready') return;

    const token = runToken.current + 1;
    runToken.current = token;
    setFreeTextError(null);
    setFreeTextNotice(null);
    // Clear the previous run first so highlights/results never linger into a
    // new (or failing) run.
    setResult(null);
    setRunError(null);
    setSelectedId(null);

    try {
      const execution = executeIntent(graph, proposal.intent, ontology);
      if (runToken.current !== token) return;
      setResult({
        chipId: FREE_TEXT_CHIP_ID,
        intent: execution.intent,
        cypher: proposal.cypher.query,
        params: proposal.cypher.params,
        execution,
      });
      setFreeTextProposal(null);
      setFreeTextPhase('ready');
    } catch (error) {
      const message = errorText(error);
      setFreeTextProposal(null);
      setFreeTextPhase('ready');
      setFreeTextError({ kind: 'executor', message });
      setRunError({ kind: 'executor', message });
    }
  };

  /** Discard the proposal WITHOUT running it; a finished chip result stays. */
  const cancelFreeTextProposal = () => {
    setFreeTextProposal(null);
  };

  const pathNodes = useMemo(() => new Set(result?.execution.pathNodeIds ?? []), [result]);
  const startNodes = useMemo(() => new Set(result?.execution.startNodeIds ?? []), [result]);
  const pathEdges = useMemo(() => new Set(result?.execution.pathEdgeKeys ?? []), [result]);
  // Ripple order: start nodes first (lowest indices), then the executor's
  // pathNodeIds insertion order for the rest. Never sort the ids.
  const rippleIndex = useMemo(() => {
    const execution = result?.execution;
    if (!execution) return new Map<string, number>();
    const onPath = new Set(execution.pathNodeIds);
    const order: string[] = [];
    for (const id of execution.startNodeIds) {
      if (onPath.has(id) && !order.includes(id)) order.push(id);
    }
    for (const id of execution.pathNodeIds) {
      if (!order.includes(id)) order.push(id);
    }
    return new Map(order.map((id, index) => [id, index]));
  }, [result]);
  const selectedChip = chips.find((chip) => chip.chip_id === selectedId) ?? null;
  const hintedLanes = new Set(selectedChip?.lane_hints ?? []);
  const chipsDisabled = engine.status !== 'ready';
  const freeTextProposalView = useMemo(() => {
    if (!freeTextProposal) return null;
    const chip = freeTextProposal.templateFile
      ? (chips.find(
          (candidate) =>
            (candidate.intent_path.split(/[\\/]/).pop() ?? '') === freeTextProposal.templateFile,
        ) ?? null)
      : null;
    return {
      path: summarizeIntentPath(freeTextProposal.intent),
      templateLabel: chip ? (lang === 'ja' ? chip.label_ja : chip.label_en) : null,
      templateDescription: chip
        ? lang === 'ja'
          ? chip.description_ja
          : chip.description_en
        : null,
    };
  }, [freeTextProposal, lang]);
  const freeTextConvertDisabled =
    engine.status !== 'ready' ||
    freeTextPhase !== 'ready' ||
    freeTextValue.trim().length === 0 ||
    freeTextProposal !== null;
  const changeFreeTextValue = (value: string) => {
    setFreeTextValue(value);
    // The proposal belongs to the text that produced it; editing discards it.
    setFreeTextProposal(null);
  };

  return (
    <main>
      <header className="app-header">
        <div>
          <h1>{t('title')}</h1>
          <p>{t('subtitle')}</p>
        </div>
        <label className="lang-label">
          {t('language')}{' '}
          <select
            data-testid="lang-toggle"
            value={lang}
            onChange={(event) => setLang(event.target.value as Lang)}
          >
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
        </label>
      </header>

      <p className="note disclaimer" data-testid="disclaimer">
        {t('disclaimer')}
      </p>

      {engine.status === 'loading' && (
        <p role="status" data-testid="loading">
          {t('loading')}
        </p>
      )}
      {engine.status === 'error' && (
        <div role="alert" className="error-box" data-testid="load-error">
          <p>
            {t('loadError')}: {engine.message}.
          </p>{' '}
          <button type="button" onClick={load}>
            {t('retry')}
          </button>
        </div>
      )}
      {engine.status === 'ready' && (
        <p className="muted small">
          {t('abiLabel')}: {engine.og.abiVersion}
        </p>
      )}

      <ChipList
        chips={chips}
        selectedId={selectedId}
        disabled={chipsDisabled}
        lang={lang}
        t={t}
        onSelect={runChip}
      />

      <FreeTextPanel
        phase={freeTextPhase}
        progress={freeTextProgress}
        progressText={freeTextProgressText}
        notice={freeTextNotice}
        error={freeTextError}
        value={freeTextValue}
        convertDisabled={freeTextConvertDisabled}
        proposal={freeTextProposalView}
        onValueChange={changeFreeTextValue}
        onConsent={grantConsent}
        onLoad={loadModel}
        onCancel={cancelModelLoad}
        onRetry={loadModel}
        onConvert={runFreeTextConvert}
        onRunProposal={runFreeTextProposal}
        onCancelProposal={cancelFreeTextProposal}
        t={t}
      />

      <Swimlane
        nodes={graph.nodes}
        highlighted={pathNodes}
        startNodes={startNodes}
        hintedLanes={hintedLanes}
        rippleIndex={rippleIndex}
        t={t}
      />

      <CrossLaneEdges graph={graph} pathEdges={pathEdges} t={t} />

      <Hud result={result} error={runError} t={t} />

      {selectedId === null && result === null && runError === null && engine.status === 'ready' && (
        <p className="muted small">{t('selectChip')}</p>
      )}
    </main>
  );
}
