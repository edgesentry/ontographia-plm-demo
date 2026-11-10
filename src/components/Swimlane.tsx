import type { MessageKey } from '../i18n';
import type { GraphNode } from '../lib/executor';
import { LANES, laneOf, nodeCaption, nodeMeta } from '../lib/data';

interface SwimlaneProps {
  nodes: GraphNode[];
  highlighted: Set<string>;
  startNodes: Set<string>;
  hintedLanes: Set<string>;
  t: (key: MessageKey) => string;
}

export function Swimlane({ nodes, highlighted, startNodes, hintedLanes, t }: SwimlaneProps) {
  return (
    <section className="panel" aria-labelledby="swimlane-heading">
      <h2 id="swimlane-heading">{t('swimlaneHeading')}</h2>
      <p className="muted">{t('swimlaneHelp')}</p>
      <p className="legend">
        <span className="legend-swatch" aria-hidden="true" /> {t('nodeOnPath')}
        <span className="legend-swatch legend-hint" aria-hidden="true" /> {t('hintedLaneLegend')}
      </p>
      <div className="swimlane-grid" data-testid="swimlane">
        {LANES.map((lane) => {
          const laneNodes = nodes.filter((node) => laneOf(node) === lane.id);
          const hinted = hintedLanes.has(lane.id);
          return (
            <div
              key={lane.id}
              className={`lane${hinted ? ' is-hinted' : ''}`}
              data-testid={`lane-${lane.id}`}
              data-lane={lane.id}
            >
              <h3 className="lane-title">
                {t(lane.labelKey)} <span className="lane-count">{laneNodes.length}</span>
              </h3>
              {lane.id === 'mbom' ? (
                <p className="lane-note" data-testid="mbom-note">
                  {t('mbomNote')}
                </p>
              ) : laneNodes.length === 0 ? (
                <p className="lane-empty">{t('laneEmpty')}</p>
              ) : null}
              <div className="lane-nodes">
                {laneNodes.map((node) => {
                  const isHighlighted = highlighted.has(node.id);
                  const isStart = startNodes.has(node.id);
                  const caption = nodeCaption(node);
                  const meta = nodeMeta(node);
                  return (
                    <article
                      key={node.id}
                      className={`node-card${isHighlighted ? ' is-highlighted' : ''}`}
                      data-node-id={node.id}
                      data-highlighted={isHighlighted ? 'true' : 'false'}
                    >
                      <div className="node-id">{node.id}</div>
                      {caption !== node.id && <div className="node-caption">{caption}</div>}
                      <div className="node-meta">
                        <span className="label-pill">{node.labels.join(' · ')}</span>
                        {meta !== node.id && meta !== caption && <span>{meta}</span>}
                      </div>
                      {isHighlighted && (
                        <div className="node-flags">
                          {isStart && <span className="flag">{t('nodeStart')}</span>}
                          <span className="flag">{t('nodeOnPath')}</span>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
