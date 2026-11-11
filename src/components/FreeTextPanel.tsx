import type { MessageKey } from '../i18n';

export type FreeTextPhase =
  | 'checking'
  | 'unsupported'
  | 'consent'
  | 'cached'
  | 'loading'
  | 'ready'
  | 'generating'
  | 'error';

export type FreeTextErrorKind = 'load' | 'generate' | 'invalid' | 'compile' | 'executor';

export interface FreeTextError {
  kind: FreeTextErrorKind;
  message: string;
}

export type FreeTextNotice = 'cancelled' | null;

interface FreeTextPanelProps {
  phase: FreeTextPhase;
  progress: number;
  progressText: string;
  notice: FreeTextNotice;
  error: FreeTextError | null;
  value: string;
  runDisabled: boolean;
  onValueChange: (value: string) => void;
  onConsent: () => void;
  onLoad: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onRun: () => void;
  t: (key: MessageKey) => string;
}

function errorBodyKey(kind: FreeTextErrorKind): MessageKey {
  switch (kind) {
    case 'invalid':
      return 'freeTextInvalidBody';
    case 'compile':
      return 'freeTextCompileBody';
    case 'executor':
      return 'freeTextExecutorBody';
    case 'generate':
      return 'freeTextGenerateBody';
    case 'load':
    default:
      return 'freeTextLoadFailed';
  }
}

export function FreeTextPanel({
  phase,
  progress,
  progressText,
  notice,
  error,
  value,
  runDisabled,
  onValueChange,
  onConsent,
  onLoad,
  onCancel,
  onRetry,
  onRun,
  t,
}: FreeTextPanelProps) {
  const inputDisabled =
    phase === 'checking' ||
    phase === 'unsupported' ||
    phase === 'loading' ||
    phase === 'generating';
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  const outputRejected =
    error?.kind === 'invalid' || error?.kind === 'compile' || error?.kind === 'executor';

  return (
    <section
      className="panel free-text-panel"
      aria-labelledby="free-text-heading"
      data-testid="free-text-panel"
    >
      <h2 id="free-text-heading">{t('freeTextHeading')}</h2>
      <p className="muted">{t('freeTextIntro')}</p>

      {phase === 'checking' && (
        <p role="status" data-testid="free-text-checking">
          {t('freeTextChecking')}
        </p>
      )}

      {phase === 'unsupported' && (
        <div className="notice-box" role="status" data-testid="webgpu-notice">
          {t('webgpuNotice')}
        </div>
      )}

      {(phase === 'consent' || phase === 'cached') && (
        <div className="consent-box" data-testid="free-text-consent">
          <h3>{t('freeTextConsentTitle')}</h3>
          <dl className="free-text-meta">
            <div>
              <dt>{t('freeTextModelLabel')}</dt>
              <dd>
                <code>Llama-3.2-1B-Instruct-q4f16_1-MLC</code>
              </dd>
            </div>
            <div>
              <dt>{t('freeTextVramLabel')}</dt>
              <dd>{t('freeTextVramValue')}</dd>
            </div>
            <div>
              <dt>{t('freeTextDownloadLabel')}</dt>
              <dd>{t('freeTextDownloadValue')}</dd>
            </div>
          </dl>
          <p>{phase === 'cached' ? t('freeTextCachedBody') : t('freeTextConsentBody')}</p>
          <p className="muted small">{t('freeTextDownloadSource')}</p>
          <div className="free-text-actions">
            {phase === 'cached' ? (
              <button type="button" data-testid="free-text-load" onClick={onLoad}>
                {t('freeTextLoadButton')}
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                data-testid="free-text-consent-button"
                onClick={onConsent}
              >
                {t('freeTextConsentButton')}
              </button>
            )}
          </div>
          <p className="muted small">{t('freeTextCacheNote')}</p>
        </div>
      )}

      {phase === 'loading' && (
        <div className="free-text-progress" data-testid="free-text-progress" role="status">
          <p>{t('freeTextLoading')}</p>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="muted small">
            {t('freeTextProgress')}: {percent}%{progressText ? ` — ${progressText}` : ''}
          </p>
          <button type="button" data-testid="free-text-cancel" onClick={onCancel}>
            {t('freeTextCancel')}
          </button>
        </div>
      )}

      {notice === 'cancelled' && (
        <p className="muted small" role="status" data-testid="free-text-cancelled">
          {t('freeTextCancelled')}
        </p>
      )}

      {error && (
        <div className="error-box" role="alert" data-testid="free-text-error">
          <strong>{t(outputRejected ? 'freeTextRejectedTitle' : 'freeTextErrorTitle')}</strong>
          <p>{t(errorBodyKey(error.kind))}</p>
          {error.message && <pre>{error.message}</pre>}
          {(error.kind === 'load' || error.kind === 'generate') && (
            <button type="button" data-testid="free-text-retry" onClick={onRetry}>
              {t('freeTextRetry')}
            </button>
          )}
        </div>
      )}

      <div className="free-text-form">
        <label htmlFor="free-text-input">{t('freeTextInputLabel')}</label>
        <textarea
          id="free-text-input"
          data-testid="free-text-input"
          value={value}
          rows={3}
          maxLength={2000}
          placeholder={t('freeTextPlaceholder')}
          disabled={inputDisabled}
          onChange={(event) => onValueChange(event.target.value)}
        />
        <div className="free-text-actions">
          <button
            type="button"
            className="primary"
            data-testid="free-text-run"
            disabled={runDisabled}
            onClick={onRun}
          >
            {t('freeTextRun')}
          </button>
          {phase === 'generating' && (
            <span className="muted small" role="status" data-testid="free-text-status">
              {t('freeTextGenerating')}
            </span>
          )}
        </div>
      </div>

      <p className="muted small">{t('freeTextPrivacy')}</p>
      <p className="muted small">{t('freeTextNoCypher')}</p>
    </section>
  );
}
