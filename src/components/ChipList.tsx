import type { Lang, MessageKey } from '../i18n';
import type { Chip } from '../lib/data';

interface ChipListProps {
  chips: Chip[];
  selectedId: string | null;
  disabled: boolean;
  lang: Lang;
  t: (key: MessageKey) => string;
  onSelect: (chip: Chip) => void;
}

export function ChipList({ chips, selectedId, disabled, lang, t, onSelect }: ChipListProps) {
  return (
    <section className="panel" aria-labelledby="chips-heading">
      <h2 id="chips-heading">{t('chipsHeading')}</h2>
      <p className="muted">{disabled ? t('chipsDisabled') : t('chipsHint')}</p>
      <div className="chip-list">
        {chips.map((chip) => {
          const label = lang === 'ja' ? chip.label_ja : chip.label_en;
          const description = lang === 'ja' ? chip.description_ja : chip.description_en;
          return (
            <button
              key={chip.chip_id}
              type="button"
              className={`chip${selectedId === chip.chip_id ? ' is-selected' : ''}`}
              data-testid={`chip-${chip.chip_id}`}
              data-chip-id={chip.chip_id}
              aria-pressed={selectedId === chip.chip_id}
              disabled={disabled}
              onClick={() => onSelect(chip)}
            >
              <span className="chip-label">{label}</span>
              <span className="chip-description">{description}</span>
              <span className="chip-hint">
                {t('laneHintsLabel')}: {chip.lane_hints.join(', ')}
              </span>
            </button>
          );
        })}
      </div>
      <p className="muted small">{t('laneHintsNote')}</p>
    </section>
  );
}
