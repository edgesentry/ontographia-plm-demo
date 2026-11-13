import { useEffect, useMemo, useRef, useState } from 'react';
import { messages, type Lang, type MessageKey } from './i18n';
import {
  allowedValues,
  defaultFilterValue,
  farmbotOntology,
  intents,
  questions,
  SOURCE_PIN,
} from './data';
import { planQuestion } from './plan.mjs';
import { formatSeedDigest, SEED_DIGEST } from './seed-digest.mjs';
import { SeedFetchError, SeedRejectedError } from './seed';
import { openRelateSession, RelateTrapError, type SessionStep } from './session';
import { closeTrappedSession } from './session-cleanup.mjs';
import { loadOntographia, type Ontographia } from '../lib/ontographia';
import type {
  Intent,
  QuestionId,
  QuestionPlan,
  RelateEnvelope,
  RelateSession,
  SelectorDomain,
} from './types';

type EngineState =
  | { status: 'loading' }
  | { status: 'ready'; engine: Ontographia }
  | { status: 'error'; detail: string };

type RelateState =
  | { status: 'idle' }
  | { status: 'loading'; step: SessionStep }
  | { status: 'ready'; digest: string; byteLength: number; statements: number }
  | { status: 'trapped' };

type ScreenError =
  | { kind: 'compile'; detail: string }
  | { kind: 'seed-fetch'; detail: string }
  | { kind: 'seed-digest'; expected: string; actual: string }
  | { kind: 'relate-load'; detail: string }
  | { kind: 'relate-query'; detail: string }
  | { kind: 'wasm-trap'; detail: string }
  | { kind: 'limit'; limit: number; rows: number };

interface RunResult {
  questionId: QuestionId;
  intent: Intent;
  executed: string;
  params: Record<string, unknown>;
  distinctApplied: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
  digest: string;
}

/** Engine timings read by the browser smoke; milliseconds from `performance`. */
interface ScreenTimings {
  seedLoadMs: number | null;
  queries: Partial<Record<QuestionId, number>>;
}

const QUESTION_LABEL_KEYS: Record<QuestionId, MessageKey> = {
  q1: 'q1Label',
  q2: 'q2Label',
  q3: 'q3Label',
  q4: 'q4Label',
  q5: 'q5Label',
};

const QUESTION_TEXT_KEYS: Record<QuestionId, MessageKey> = {
  q1: 'q1Question',
  q2: 'q2Question',
  q3: 'q3Question',
  q4: 'q4Question',
  q5: 'q5Question',
};

const SELECTOR_LABEL_KEYS: Record<SelectorDomain, MessageKey> = {
  part_names_in_assembly_chapters: 'selectorPart',
  part_names_in_all_three_structure_kinds: 'selectorPart',
  category_slugs_in_kits: 'selectorCategory',
};

const ERROR_MESSAGE_KEYS: Record<ScreenError['kind'], MessageKey> = {
  compile: 'compileError',
  'seed-fetch': 'seedFetchError',
  'seed-digest': 'seedDigestError',
  'relate-load': 'relateLoadError',
  'relate-query': 'relateQueryError',
  'wasm-trap': 'wasmTrapError',
  limit: 'limitError',
};

function detailText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialFilterValues(): Record<QuestionId, string | null> {
  const values: Record<QuestionId, string | null> = {
    q1: null,
    q2: null,
    q3: null,
    q4: null,
    q5: null,
  };
  for (const question of questions) {
    values[question.id] = defaultFilterValue(intents[question.id]);
  }
  return values;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function App() {
  const [lang, setLang] = useState<Lang>(() =>
    navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en',
  );
  const [engine, setEngine] = useState<EngineState>({ status: 'loading' });
  const [relate, setRelate] = useState<RelateState>({ status: 'idle' });
  const [selectedId, setSelectedId] = useState<QuestionId>('q1');
  const [filterValues, setFilterValues] =
    useState<Record<QuestionId, string | null>>(initialFilterValues);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<ScreenError | null>(null);
  const [timings, setTimings] = useState<ScreenTimings>({
    seedLoadMs: null,
    queries: {},
  });

  const sessionRef = useRef<RelateSession | null>(null);
  const sessionPromise = useRef<Promise<RelateSession> | null>(null);
  const trappedRef = useRef(false);
  const runToken = useRef(0);
  const timingMarkId = useRef(0);

  // Marks around the engine work only: seed fetch/digest/load for the session,
  // and `session.execute` for a query. React render time is outside both.
  const startTiming = (prefix: string): string => {
    timingMarkId.current += 1;
    const markName = `${prefix}:start:${timingMarkId.current}`;
    performance.mark(markName);
    return markName;
  };

  const finishTiming = (prefix: string, startMark: string): number => {
    timingMarkId.current += 1;
    const endMark = `${prefix}:end:${timingMarkId.current}`;
    performance.mark(endMark);
    return performance.measure(prefix, startMark, endMark).duration;
  };

  const t = (key: MessageKey) => messages[lang][key];

  // The Ontographia engine is loaded after first paint so the first painted
  // frame of /farmbot/ stays free of WASM fetches.
  useEffect(() => {
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      loadOntographia().then(
        (loaded) => {
          if (!cancelled) setEngine({ status: 'ready', engine: loaded });
        },
        (loadError: unknown) => {
          if (!cancelled) setEngine({ status: 'error', detail: detailText(loadError) });
        },
      );
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(
    () => () => {
      sessionRef.current?.close();
      sessionRef.current = null;
    },
    [],
  );

  const question = questions.find((candidate) => candidate.id === selectedId) ?? questions[0];
  const selectorValue = question.selector
    ? (filterValues[question.id] ?? defaultFilterValue(intents[question.id]) ?? '')
    : null;
  const selectorOptions = useMemo(
    () => (question.selector ? allowedValues[question.selector] : []),
    [question.selector],
  );

  const clearRun = () => {
    runToken.current += 1;
    setResult(null);
    setError(null);
  };

  const selectQuestion = (id: QuestionId) => {
    if (id === selectedId) return;
    setSelectedId(id);
    clearRun();
  };

  const selectFilterValue = (value: string) => {
    setFilterValues((current) => ({ ...current, [question.id]: value }));
    clearRun();
  };

  const ensureSession = (): Promise<RelateSession> => {
    if (sessionRef.current) return Promise.resolve(sessionRef.current);
    if (trappedRef.current) {
      return Promise.reject(new Error('Relate trapped; reload the page to continue.'));
    }
    if (!sessionPromise.current) {
      setRelate({ status: 'loading', step: 'seed' });
      const seedLoadMark = startTiming('farmbot:seed-load');
      sessionPromise.current = openRelateSession((step) =>
        setRelate({ status: 'loading', step }),
      )
        .then((session) => {
          const seedLoadMs = finishTiming('farmbot:seed-load', seedLoadMark);
          setTimings((current) => ({ ...current, seedLoadMs }));
          sessionRef.current = session;
          setRelate({
            status: 'ready',
            digest: session.digest,
            byteLength: session.byteLength,
            statements: session.statements,
          });
          return session;
        })
        .catch((openError: unknown) => {
          sessionPromise.current = null;
          setRelate({ status: 'idle' });
          throw openError;
        });
    }
    return sessionPromise.current;
  };

  const trapSession = (session: RelateSession, trapError: unknown) => {
    closeTrappedSession(session, trapError, (trap) => {
      sessionRef.current = null;
      sessionPromise.current = null;
      trappedRef.current = true;
      setRelate({ status: 'trapped' });
      setError(trap);
    });
  };

  const run = async () => {
    if (engine.status !== 'ready' || running) return;
    const questionToRun = question;
    const intent: Intent = structuredClone(intents[questionToRun.id]);
    if (questionToRun.selector) {
      const value = filterValues[questionToRun.id] ?? defaultFilterValue(intents[questionToRun.id]);
      if (intent.filter?.[0] && value !== null) intent.filter[0].value = value;
    }

    const token = runToken.current + 1;
    runToken.current = token;
    setRunning(true);
    setResult(null);
    setError(null);

    try {
      let plan: QuestionPlan;
      try {
        plan = planQuestion(engine.engine, farmbotOntology, intent, questionToRun.distinct);
      } catch (compileError) {
        setError({ kind: 'compile', detail: detailText(compileError) });
        return;
      }

      let session: RelateSession;
      try {
        session = await ensureSession();
      } catch (openError) {
        if (runToken.current !== token) return;
        if (openError instanceof SeedRejectedError) {
          setError({
            kind: 'seed-digest',
            expected: SEED_DIGEST,
            actual: formatSeedDigest(openError.actualHex),
          });
        } else if (openError instanceof SeedFetchError) {
          setError({ kind: 'seed-fetch', detail: openError.message });
        } else if (openError instanceof RelateTrapError) {
          trappedRef.current = true;
          sessionPromise.current = null;
          setRelate({ status: 'trapped' });
          setError({ kind: 'wasm-trap', detail: openError.message });
        } else if (trappedRef.current) {
          setError({ kind: 'wasm-trap', detail: detailText(openError) });
        } else {
          setError({ kind: 'relate-load', detail: detailText(openError) });
        }
        return;
      }
      if (runToken.current !== token) return;

      let envelope: RelateEnvelope;
      const queryPrefix = `farmbot:query:${questionToRun.id}`;
      const queryMark = startTiming(queryPrefix);
      try {
        envelope = session.execute(plan.executed, plan.params);
      } catch (executeError) {
        finishTiming(queryPrefix, queryMark);
        if (session.isTrap(executeError)) {
          trapSession(session, executeError);
        } else {
          setError({ kind: 'relate-query', detail: detailText(executeError) });
        }
        return;
      }
      const queryMs = finishTiming(queryPrefix, queryMark);
      setTimings((current) => ({
        ...current,
        queries: { ...current.queries, [questionToRun.id]: queryMs },
      }));

      if (envelope.error) {
        setError({ kind: 'relate-query', detail: envelope.error });
        return;
      }

      const rows = envelope.rows ?? [];
      if (rows.length >= intent.limit) {
        setError({ kind: 'limit', limit: intent.limit, rows: rows.length });
        return;
      }

      setResult({
        questionId: questionToRun.id,
        intent,
        executed: plan.executed,
        params: plan.params,
        distinctApplied: plan.distinctApplied,
        columns: envelope.columns ?? intent.return.map((entry) => entry.as_name),
        rows,
        digest: session.digest,
      });
    } finally {
      setRunning(false);
    }
  };

  const relateStatus = (): string => {
    switch (relate.status) {
      case 'idle':
        return t('relateIdle');
      case 'loading':
        return relate.step === 'seed'
          ? t('relateLoadingSeed')
          : relate.step === 'wasm'
            ? t('relateLoadingWasm')
            : t('relateSeeding');
      case 'ready':
        return t('relateReady');
      case 'trapped':
        return t('relateTrapped');
    }
  };

  const runDisabled =
    engine.status !== 'ready' || running || relate.status === 'trapped';

  return (
    <main>
      <div hidden data-testid="timings">
        {JSON.stringify(timings)}
      </div>
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

      {engine.status === 'loading' && (
        <p role="status" className="muted small">
          {t('loadingEngine')}
        </p>
      )}
      {engine.status === 'error' && (
        <div role="alert" className="error-box">
          <p>
            {t('engineFailed')}: {engine.detail}
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            {t('retry')}
          </button>
        </div>
      )}
      {engine.status === 'ready' && (
        <p className="muted small" data-testid="abi">
          {t('engineLabel')}: {engine.engine.abiVersion}
        </p>
      )}

      <section className="panel">
        <h2>{t('questionsHeading')}</h2>
        <p className="muted small">{t('questionsHint')}</p>
        <p className="note">{t('quantityNote')}</p>
        <div className="chip-list">
          {questions.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={`chip${candidate.id === selectedId ? ' is-selected' : ''}`}
              data-testid={`question-${candidate.id}`}
              aria-pressed={candidate.id === selectedId}
              onClick={() => selectQuestion(candidate.id)}
            >
              <span className="chip-label">{t(QUESTION_LABEL_KEYS[candidate.id])}</span>
              <span className="chip-description">{t(QUESTION_TEXT_KEYS[candidate.id])}</span>
            </button>
          ))}
        </div>

        {question.selector && (
          <label className="farmbot-selector">
            <span>{t(SELECTOR_LABEL_KEYS[question.selector])}</span>
            <select
              data-testid="filter-value"
              value={selectorValue ?? ''}
              onChange={(event) => selectFilterValue(event.target.value)}
            >
              {selectorOptions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <span className="muted small">{t('selectorHint')}</span>
          </label>
        )}

        <div className="farmbot-actions">
          <button
            type="button"
            className="primary"
            data-testid="run"
            onClick={run}
            disabled={runDisabled}
          >
            {running ? t('running') : t('run')}
          </button>
          <span className="muted small" role="status">
            {relateStatus()}
          </span>
        </div>
      </section>

      {error && (
        <div role="alert" className="error-box" data-testid="error">
          <p>{t(ERROR_MESSAGE_KEYS[error.kind])}</p>
          {error.kind === 'seed-digest' ? (
            <dl className="farmbot-meta">
              <dt>{t('digestExpectedLabel')}</dt>
              <dd>
                <code>{error.expected}</code>
              </dd>
              <dt>{t('digestActualLabel')}</dt>
              <dd>
                <code>{error.actual}</code>
              </dd>
            </dl>
          ) : error.kind === 'limit' ? (
            <p className="small">
              {t('limitNote')}: {error.limit} / {t('rowsFoundNote')}: {error.rows}
            </p>
          ) : (
            <pre>{error.detail}</pre>
          )}
        </div>
      )}

      {result && (
        <section className="panel" data-testid="result">
          <h2>{t('resultHeading')}</h2>
          <dl className="farmbot-meta">
            <dt>{t('intentLabel')}</dt>
            <dd>
              {t(QUESTION_LABEL_KEYS[result.questionId])} (
              {questions.find((candidate) => candidate.id === result.questionId)?.intentFile})
            </dd>
            <dt>{t('limitLabel')}</dt>
            <dd>{result.intent.limit}</dd>
            <dt>{t('receivedDigestLabel')}</dt>
            <dd>
              <code>{result.digest}</code>
            </dd>
            <dt>{t('sourcePinLabel')}</dt>
            <dd>
              <code>{SOURCE_PIN}</code>
            </dd>
          </dl>

          <h3>{t('intentLabel')}</h3>
          <pre data-testid="intent">{JSON.stringify(result.intent, null, 2)}</pre>

          <h3>{t('executedCypherLabel')}</h3>
          <pre data-testid="cypher">{result.executed}</pre>

          <h3>{t('paramsLabel')}</h3>
          <pre>{JSON.stringify(result.params, null, 2)}</pre>

          {result.distinctApplied && <p className="note">{t('distinctNote')}</p>}

          <h3>
            {t('rowsHeading')}{' '}
            <span className="count" data-testid="row-count">
              {result.rows.length}
            </span>
          </h3>
          {result.rows.length === 0 ? (
            <p className="no-matches">{t('noRows')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {result.columns.map((column) => (
                      <th key={column} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index}>
                      {result.columns.map((column) => (
                        <td key={column}>{cellText(row[column])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="panel farmbot-about">
        <h2>{t('aboutHeading')}</h2>
        <p className="small">{t('aboutBody')}</p>
        <dl className="farmbot-meta">
          <dt>{t('digestLabel')}</dt>
          <dd>
            <code data-testid="expected-digest">{SEED_DIGEST}</code>
          </dd>
          <dt>{t('sourcePinLabel')}</dt>
          <dd>
            <code>{SOURCE_PIN}</code>
          </dd>
          {relate.status === 'ready' && (
            <>
              <dt>{t('receivedDigestLabel')}</dt>
              <dd>
                <code data-testid="verified-digest">{relate.digest}</code>
              </dd>
              <dt>{t('seedBytesLabel')}</dt>
              <dd data-testid="seed-bytes">{relate.byteLength}</dd>
              <dt>{t('statementsLabel')}</dt>
              <dd>{relate.statements}</dd>
            </>
          )}
        </dl>
        <p className="small">
          <a href="../">{t('parentEntry')}</a>
        </p>
      </section>
    </main>
  );
}
