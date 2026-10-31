import { type RefObject, useEffect, useMemo, useRef } from "react";
import { classLabel, kindLabel } from "../model/language";
import { chainGroups, RANKS, rankOf } from "../model/layout";
import { percent } from "../model/time";
import type { Graph } from "../model/trace";
import type { Snapshot, SnapshotNode } from "../snapshot";
import { AnchorMark, ClassMark, UpstreamMark } from "../ui/Marks";
import type { ViewKeys } from "./ChainView";

const ROW_HEIGHT = 58;

function Row({ node, graph, selected }: { node: SnapshotNode; graph: Graph; selected: boolean }) {
  const sounding = graph.soundings.get(node.id) ?? 0;
  const upstream = node.upstreamChanged.length > 0;
  return (
    <li className="leg" data-cls={node.class}>
      <a
        className="leg__link"
        href={`#/node/${encodeURIComponent(node.id)}`}
        data-row
        data-selected={selected || undefined}
      >
        <span className="leg__glyph">
          <ClassMark cls={node.class} size={22} />
        </span>
        <span className="leg__body">
          <span className="leg__title">{node.title}</span>
          <span className="leg__sub">
            {kindLabel(node.kind)}
            {node.class !== "fresh" && <span className="leg__state"> · {classLabel(node.class)}</span>}
            {upstream && <span> · upstream changed</span>}
          </span>
        </span>
        <span className="leg__flags">
          {node.pinned_to_code && <AnchorMark size={13} />}
          {upstream && <UpstreamMark size={13} />}
          {sounding > 0 && <span className="leg__sounding">{sounding}</span>}
        </span>
      </a>
    </li>
  );
}

/**
 * The chain as a vertical passage plan: the same order, marks and soundings as
 * the chart, in a shape that fits a phone and reads well in a screen reader.
 */
export function PassageList({
  snapshot,
  graph,
  selected,
  keysRef,
  failed,
}: {
  snapshot: Snapshot;
  graph: Graph;
  selected: string | null;
  keysRef: RefObject<ViewKeys | null>;
  failed: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => chainGroups(snapshot), [snapshot]);

  useEffect(() => {
    keysRef.current = (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
      const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
      const index = rows.indexOf(document.activeElement as HTMLElement);
      const next = rows[Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1))];
      next?.focus();
      return true;
    };
    return () => {
      keysRef.current = null;
    };
  }, [keysRef]);

  const share = Math.max(0, Math.min(0.95, snapshot.summary.unchartedShare));
  const fogHeight = (snapshot.nodes.length * ROW_HEIGHT * share) / (1 - share);

  return (
    <div className="passage" ref={root} id="main-focus" tabIndex={-1}>
      {failed && (
        <p className="passage__note">
          The chart layout could not be computed, so the chain is shown as a list. Nothing is missing.
        </p>
      )}
      {groups.map((group) => (
        <section key={group.id} className="passage__chain">
          <h2 className="passage__title">{group.title}</h2>
          {RANKS.map(({ rank, label, letter }) => {
            const nodes = group.nodes.filter((node) => rankOf(node.kind) === rank);
            if (nodes.length === 0) return null;
            return (
              <div key={rank} className="passage__rank">
                <h3 className="passage__rank-title">
                  <span className="meridian__letter">{letter}</span>
                  {label}
                </h3>
                <ol className="passage__legs">
                  {nodes.map((node) => (
                    <Row key={node.id} node={node} graph={graph} selected={node.id === selected} />
                  ))}
                </ol>
              </div>
            );
          })}
        </section>
      ))}
      {share > 0 && (
        <section
          className="passage__fog"
          style={{ minHeight: Math.min(fogHeight, 900) }}
          aria-label={`Uncharted: ${percent(snapshot.summary.unchartedShare)} percent of the repository`}
        >
          <svg className="passage__stipple" width="100%" height="100%" aria-hidden="true">
            <rect width="100%" height="100%" fill="url(#mk-stipple-small)" />
          </svg>
          <h2 className="passage__fog-title">
            Uncharted <span className="passage__fog-share">{percent(snapshot.summary.unchartedShare)}%</span>
          </h2>
          <ul className="passage__fog-list">
            {snapshot.uncharted.slice(0, 12).map((entry) => (
              <li key={entry.path}>
                <span>{entry.path}</span>
                <span className="passage__fog-lines">{entry.lines.toLocaleString("en")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
