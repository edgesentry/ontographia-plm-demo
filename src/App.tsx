import { useCallback, useEffect, useState } from 'react';
import { messages, type Lang, type MessageKey } from './i18n';
import { loadOntographia, type CypherResult, type Ontographia } from './lib/ontographia';
import ontologyYaml from '../vendor/ontographia/data/plm.native.yaml?raw';
import fixedIntent from '../vendor/ontographia/data/intents/01_affected_products.json';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; og: Ontographia };

export function App() {
  const [lang, setLang] = useState<Lang>(navigator.language.startsWith('ja') ? 'ja' : 'en');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [result, setResult] = useState<CypherResult | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const t = (k: MessageKey) => messages[lang][k];

  const load = useCallback(() => {
    setState({ status: 'loading' });
    loadOntographia().then(
      (og) => setState({ status: 'ready', og }),
      (e: unknown) => setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
  }, []);

  useEffect(load, [load]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const compile = () => {
    if (state.status !== 'ready') return;
    try {
      setCompileError(null);
      setResult(
        state.og.buildCypher(ontologyYaml, fixedIntent, {
          dialect: 'cypher25',
          ontologyPathHint: 'plm.native.yaml',
        }),
      );
    } catch (e) {
      setResult(null);
      setCompileError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main>
      <header>
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
        <label>
          {t('language')}{' '}
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
        </label>
      </header>

      {state.status === 'loading' && <p role="status">{t('loading')}</p>}
      {state.status === 'error' && (
        <div role="alert">
          <p>
            {t('error')}: {state.message}
          </p>
          <button onClick={load}>{t('retry')}</button>
        </div>
      )}
      {state.status === 'ready' && (
        <section>
          <h2>{t('smokeHeading')}</h2>
          <p className="note">{t('disclaimer')}</p>
          <p>
            {t('abiLabel')}: {state.og.abiVersion}
          </p>
          <h3>{t('intentLabel')}</h3>
          <pre>{JSON.stringify(fixedIntent, null, 2)}</pre>
          <button onClick={compile}>{t('compile')}</button>
          {compileError && (
            <p role="alert">
              {t('compileError')}: {compileError}
            </p>
          )}
          {result && (
            <>
              <h3>{t('queryLabel')}</h3>
              <pre>{result.query}</pre>
              <h3>{t('paramsLabel')}</h3>
              <pre>{JSON.stringify(result.params, null, 2)}</pre>
            </>
          )}
        </section>
      )}
    </main>
  );
}
