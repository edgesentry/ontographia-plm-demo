import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChipList } from './components/ChipList';
import { CrossLaneEdges } from './components/CrossLaneEdges';
import { Hud, type HudResult, type RunError } from './components/Hud';
import { Swimlane } from './components/Swimlane';
import { messages, type Lang, type MessageKey } from './i18n';
import { executeIntent } from './lib/executor';
import { chips, graph, ontology, resolveIntentByPath, type Chip } from './lib/data';
import { loadOntographia, type Ontographia } from './lib/ontographia';

type EngineState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; og: Ontographia };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const runChip = async (chip: Chip) => {
    if (engine.status !== 'ready') return;
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

  const pathNodes = useMemo(() => new Set(result?.execution.pathNodeIds ?? []), [result]);
  const startNodes = useMemo(() => new Set(result?.execution.startNodeIds ?? []), [result]);
  const pathEdges = useMemo(() => new Set(result?.execution.pathEdgeKeys ?? []), [result]);
  const selectedChip = chips.find((chip) => chip.chip_id === selectedId) ?? null;
  const hintedLanes = new Set(selectedChip?.lane_hints ?? []);
  const chipsDisabled = engine.status !== 'ready';

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
            {t('loadError')}: {engine.message}
          </p>
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

      <Swimlane
        nodes={graph.nodes}
        highlighted={pathNodes}
        startNodes={startNodes}
        hintedLanes={hintedLanes}
        t={t}
      />

      <CrossLaneEdges graph={graph} pathEdges={pathEdges} t={t} />

      <Hud result={result} error={runError} t={t} />

      {selectedId === null && engine.status === 'ready' && (
        <p className="muted small">{t('selectChip')}</p>
      )}
    </main>
  );
}
