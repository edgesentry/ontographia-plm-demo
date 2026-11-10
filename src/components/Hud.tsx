import type { MessageKey } from '../i18n';
import type { ExecutionResult, Intent } from '../lib/executor';

export interface HudResult {
  chipId: string;
  intent: Intent;
  cypher: string;
  params: Record<string, unknown>;
  execution: ExecutionResult;
}

export interface RunError {
  kind: 'compile' | 'executor';
  message: string;
}

interface HudProps {
  result: HudResult | null;
  error: RunError | null;
  t: (key: MessageKey) => string;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function Hud({ result, error, t }: HudProps) {
  return (
    <section className="panel hud" aria-labelledby="hud-heading" data-testid="hud">
      <div className="hud-head">
        <h2 id="hud-heading">{t('hudHeading')}</h2>
        {result && (
          <span className="badge-verified" data-testid="verified" role="status">
            {t('verified')}
          </span>
        )}
      </div>

      {error && (
        <div className="error-box" role="alert" data-testid="hud-error">
          <strong>{t('errorHeading')}</strong>
          <p>{t(error.kind === 'compile' ? 'compileError' : 'executorError')}</p>
          <pre>{error.message}</pre>
        </div>
      )}

      {!result && !error && <p className="muted">{t('hudEmpty')}</p>}

      {result && (
        <>
          <p className="badge-compiled">{t('compiledBadge')}</p>
          <p className="muted">{t('notExecutedNote')}</p>

          <h3>{t('intentLabel')}</h3>
          <pre data-testid="hud-intent">{JSON.stringify(result.intent, null, 2)}</pre>

          <h3>{t('queryLabel')}</h3>
          <pre data-testid="hud-cypher">{result.cypher}</pre>

          <h3>{t('paramsLabel')}</h3>
          <pre data-testid="hud-params">{JSON.stringify(result.params, null, 2)}</pre>

          <h3>
            {t('resultsLabel')} <span className="count">{result.execution.stats.returned}</span>
          </h3>
          {result.execution.rows.length === 0 ? (
            <p className="no-matches" data-testid="no-matches">
              {t('noMatches')}
            </p>
          ) : (
            <div className="table-wrap">
              <table data-testid="hud-results">
                <thead>
                  <tr>
                    {Object.keys(result.execution.rows[0]).map((column) => (
                      <th key={column} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.execution.rows.map((row, index) => (
                    <tr key={index}>
                      {Object.keys(result.execution.rows[0]).map((column) => (
                        <td key={column}>{formatValue(row[column])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>{t('pathLabel')}</h3>
          <p className="muted">
            {t('pathNodesLabel')}: {result.execution.pathNodeIds.length} ·{' '}
            {t('pathEdgesLabel')}: {result.execution.pathEdgeKeys.length}
          </p>
          <ul className="path-list" data-testid="path-nodes">
            {[...result.execution.pathNodeIds].sort().map((id) => (
              <li key={id} data-testid="path-node">
                <code>{id}</code>
              </li>
            ))}
          </ul>
          {result.execution.startNodeIds.length > 0 && (
            <p className="muted">
              {t('startNodeLabel')}: <code>{result.execution.startNodeIds.join(', ')}</code>
            </p>
          )}
          <h4>{t('pathEdgesLabel')}</h4>
          <pre data-testid="hud-path-edges">{result.execution.pathEdgeKeys.join('\n') || '—'}</pre>
        </>
      )}
    </section>
  );
}
