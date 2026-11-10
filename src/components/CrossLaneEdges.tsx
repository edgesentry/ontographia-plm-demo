import type { MessageKey } from '../i18n';
import { edgeKey, type FixtureGraph } from '../lib/executor';
import { laneOf, type LaneId } from '../lib/data';

const LANE_LABELS: Record<LaneId, MessageKey> = {
  ebom: 'laneEbom',
  mbom: 'laneMbom',
  sbom: 'laneSbom',
  bop: 'laneBop',
};

interface CrossLaneEdgesProps {
  graph: FixtureGraph;
  pathEdges: Set<string>;
  t: (key: MessageKey) => string;
}

export function CrossLaneEdges({ graph, pathEdges, t }: CrossLaneEdgesProps) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const crossLane = graph.edges
    .map((edge) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      const fromLane = from ? laneOf(from) : null;
      const toLane = to ? laneOf(to) : null;
      return { edge, fromLane, toLane };
    })
    .filter(({ fromLane, toLane }) => fromLane && toLane && fromLane !== toLane);

  return (
    <section className="panel" aria-labelledby="cross-lane-heading">
      <h2 id="cross-lane-heading">{t('crossLaneHeading')}</h2>
      <p className="muted">{t('crossLaneHelp')}</p>
      {crossLane.length === 0 ? (
        <p className="muted">{t('noCrossLaneEdges')}</p>
      ) : (
        <ul className="cross-lane-list" data-testid="cross-lane-edges">
          {crossLane.map(({ edge, fromLane, toLane }) => {
            const key = edgeKey(edge);
            const onPath = pathEdges.has(key);
            return (
              <li
                key={key}
                className={`cross-lane-edge${onPath ? ' is-on-path' : ''}`}
                data-testid="cross-lane-edge"
                data-edge-key={key}
              >
                <span className="lane-tag">{t(LANE_LABELS[fromLane!])}</span>
                <code>{edge.from}</code>
                <span className="edge-type">{edge.type}</span>
                <span aria-hidden="true">→</span>
                <code>{edge.to}</code>
                <span className="lane-tag">{t(LANE_LABELS[toLane!])}</span>
                {onPath && <span className="flag">{t('edgeOnPath')}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
