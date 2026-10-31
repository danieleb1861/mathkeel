import {
  type Node,
  type NodeProps,
  type NodeTypes,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  ViewportPortal,
} from "@xyflow/react";
import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { runElk } from "../data/elk";
import { classLabel, classSentence, kindLabel, statusLabel } from "../model/language";
import {
  type ChartLayout,
  layoutChart,
  MARK_HEIGHT,
  MARK_WIDTH,
  type PlacedEdge,
  type PlacedNode,
  RULE_Y,
  topologyKey,
} from "../model/layout";
import { ago, percent, wakeStrength } from "../model/time";
import { type Graph, relatedTo } from "../model/trace";
import type { Activity, NodeClass, Snapshot, SnapshotNode } from "../snapshot";
import { AnchorMark, ClassMark, FogSample, UpstreamMark, WakeSample } from "../ui/Marks";
import { Tex } from "../ui/Tex";
import { arcPath, fogPath, roundedPath, shoreline } from "./chart-geometry";
import { FormulaSheet } from "./FormulaSheet";
import { PassageList } from "./PassageList";

export type ViewKeys = (event: KeyboardEvent) => boolean;

const FAR_ZOOM = 0.5;
const READABLE_ZOOM = 0.52;
const MINIMAP_FROM = 60;
/** Below this a formula stops shrinking and fades out at the edge of its mark. */
const FORMULA_MIN_SCALE = 0.62;

interface MarkData extends Record<string, unknown> {
  node: SnapshotNode;
  formula: string | null;
  sounding: number;
  selected: boolean;
  dim: boolean;
}

type MarkNode = Node<MarkData, "mark">;

/** One line of mathematics, shrunk to its mark; the Readout gives it in full. */
function MarkFormula({ latex }: { latex: string }) {
  const box = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const fit = (): void => {
      const outer = box.current;
      const inner = outer?.firstElementChild as HTMLElement | null | undefined;
      if (!outer || !inner) return;
      const scale = Math.min(1, outer.clientWidth / inner.offsetWidth, outer.clientHeight / inner.offsetHeight);
      const shown = Math.max(scale, FORMULA_MIN_SCALE);
      inner.style.transform = `scale(${shown})`;
      outer.toggleAttribute("data-cut", inner.offsetWidth * shown > outer.clientWidth);
    };
    fit();
    void document.fonts?.ready.then(fit);
  }, [latex]);
  return (
    <span className="mark__formula" ref={box}>
      <Tex latex={latex} />
    </span>
  );
}

const ChartMark = memo(function ChartMark({ data }: NodeProps<MarkNode>) {
  const { node, formula, sounding, selected, dim } = data;
  const upstream = node.upstreamChanged.length > 0;
  return (
    <div
      className="mark"
      data-cls={node.class}
      data-selected={selected || undefined}
      data-dim={dim || undefined}
      data-upstream={upstream || undefined}
      data-formula={formula ? true : undefined}
    >
      <span className="mark__title">{node.title}</span>
      <span className="mark__rule" />
      <span className="mark__glyph">
        <ClassMark cls={node.class} size={22} />
      </span>
      <span className="mark__sub">
        {kindLabel(node.kind)}
        {node.class !== "fresh" && <span className="mark__state"> · {classLabel(node.class)}</span>}
      </span>
      <span className="mark__flags">
        {node.pinned_to_code && <AnchorMark size={13} />}
        {upstream && <UpstreamMark size={13} />}
        {sounding > 0 && <span className="mark__sounding">{sounding}</span>}
      </span>
      {formula && <MarkFormula latex={formula} />}
    </div>
  );
});

const NODE_TYPES: NodeTypes = { mark: ChartMark };

function useChartLayout(snapshot: Snapshot, formulas: boolean) {
  const key = useMemo(() => `${formulas}|${topologyKey(snapshot)}`, [snapshot, formulas]);
  const [state, setState] = useState<{ key: string; layout: ChartLayout | null; failed: boolean }>({
    key: "",
    layout: null,
    failed: false,
  });
  const latest = useRef(snapshot);
  latest.current = snapshot;

  useEffect(() => {
    let cancelled = false;
    layoutChart(latest.current, runElk, formulas).then(
      (layout) => {
        if (!cancelled) setState({ key, layout, failed: false });
      },
      () => {
        if (!cancelled) setState({ key, layout: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, formulas]);

  return state.key === key ? state : { key, layout: state.layout, failed: false };
}

function edgeTone(edge: PlacedEdge, graph: Graph): NodeClass | null {
  const source = graph.byId.get(edge.source);
  const target = graph.byId.get(edge.target);
  if (!source || !target) return null;
  if (source.class !== "fresh") {
    return target.upstreamChanged.includes(edge.source) ? source.class : null;
  }
  const carries = source.upstreamChanged.filter((id) => target.upstreamChanged.includes(id));
  for (const cls of ["alert", "review", "queue"] as const) {
    if (carries.some((id) => graph.byId.get(id)?.class === cls)) return cls;
  }
  return null;
}

function Edges({
  edges,
  graph,
  related,
  selected,
}: {
  edges: readonly PlacedEdge[];
  graph: Graph;
  related: ReadonlySet<string> | null;
  selected: string | null;
}) {
  const rendered = useMemo(
    () =>
      edges.map((edge) => {
        const from = edge.points[0];
        const to = edge.points[edge.points.length - 1];
        const path =
          edge.kind === "arc" && from && to ? arcPath(from, to) : roundedPath(edge.points);
        return { edge, path, tone: edgeTone(edge, graph) };
      }),
    [edges, graph],
  );
  return (
    <g className="edges">
      {rendered.map(({ edge, path, tone }) => {
        const onPath = related ? related.has(edge.source) && related.has(edge.target) : false;
        return (
          <path
            key={edge.id}
            d={path}
            className="edge"
            data-kind={edge.kind}
            data-tone={tone ?? undefined}
            data-on={onPath || edge.source === selected || edge.target === selected || undefined}
            data-dim={(related !== null && !onPath) || undefined}
          />
        );
      })}
    </g>
  );
}

function Wake({
  activity,
  placed,
  now,
}: {
  activity: readonly Activity[];
  placed: ReadonlyMap<string, PlacedNode>;
  now: number;
}) {
  const seen = useRef<Set<string> | null>(null);
  const tracks = activity.flatMap((item) => {
    const strength = wakeStrength(item.changedAt, now);
    if (strength === 0) return [];
    const stops = item.touches
      .flatMap((id) => placed.get(id) ?? [])
      .map((node) => ({ x: node.x + 11, y: node.y + RULE_Y }))
      .sort((a, b) => a.x - b.x || a.y - b.y);
    const start = stops[0];
    if (!start) return [];
    const points = stops.length === 1 ? [{ x: start.x - 54, y: start.y + 18 }, start] : stops;
    const key = `${item.path}@${item.changedAt}`;
    return [{ key, item, strength, points, fresh: seen.current !== null && !seen.current.has(key) }];
  });

  useEffect(() => {
    seen.current = new Set(tracks.map((track) => track.key));
  });

  return (
    <g className="wakes">
      {tracks.map(({ key, strength, points, fresh }) => {
        const d = roundedPath(points, 26);
        return (
          <g key={key} className="wake" style={{ opacity: strength }} data-new={fresh || undefined}>
            <path className="wake__band" d={d} pathLength={1} />
            <path className="wake__line" d={d} />
            {points.map((point) => (
              <circle key={`${point.x},${point.y}`} className="wake__tick" cx={point.x} cy={point.y} r={2.2} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

function FogLayer({ layout }: { layout: ChartLayout }) {
  const fog = layout.fog;
  if (!fog) return null;
  return (
    <g className="fog">
      <path d={fogPath(fog)} fill="url(#mk-stipple)" className="fog__body" />
      <path d={`M${shoreline(fog)}`} className="fog__shore" />
      <path d={`M${shoreline(fog, -7)}`} className="fog__shore fog__shore--outer" />
      {fog.slices.slice(1).map((slice) => (
        <path
          key={slice.path}
          d={`M${fog.x + 22} ${slice.y}H${fog.x + fog.width}`}
          className="fog__divide"
        />
      ))}
    </g>
  );
}

function FogLabels({ layout }: { layout: ChartLayout }) {
  const fog = layout.fog;
  if (!fog) return null;
  return (
    <div
      className="fog-labels"
      style={{ left: fog.x + 26, top: fog.y, width: Math.max(fog.width - 34, 120), height: fog.height }}
    >
      {fog.slices
        .filter((slice) => slice.height >= 44)
        .map((slice) => (
          <p
            key={slice.path}
            className="fog-label"
            style={{ top: slice.y + 8, maxHeight: Math.max(slice.height - 12, 22) }}
          >
            <span className="fog-label__path">{slice.path}</span>
            <span className="fog-label__lines">{slice.lines.toLocaleString("en")} lines</span>
          </p>
        ))}
    </div>
  );
}

function Bands({ layout, graph }: { layout: ChartLayout; graph: Graph }) {
  return (
    <div className="bands">
      {layout.bands.map((band, index) => {
        const nodes = layout.nodes.filter((node) => node.chain === band.id);
        const open = nodes.filter((node) => graph.byId.get(node.id)?.class !== "fresh").length;
        return (
          <div key={band.id} className="band" style={{ top: band.y, width: layout.width }}>
            {index > 0 && <span className="band__limit" />}
            <h2 className="band__title">{band.title}</h2>
            <span className="band__meta">
              {nodes.length} nodes{open > 0 ? `, ${open} open` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Neatline({ layout }: { layout: ChartLayout }) {
  const [x, y, zoom] = useStore((state) => state.transform);
  const period = 72 * zoom;
  const offsetX = ((x % period) + period) % period;
  const offsetY = ((y % period) + period) % period;
  const fogShare = percent(layout.fog?.share ?? 0);
  return (
    <div className="neatline" aria-hidden="true">
      <svg width="0" height="0" className="neatline__defs">
        <defs>
          <pattern id="mk-ticks-x" width={period} height="6" patternUnits="userSpaceOnUse" x={offsetX} y="0">
            <rect width={period / 2} height="6" className="neatline__tick" />
          </pattern>
          <pattern id="mk-ticks-y" width="6" height={period} patternUnits="userSpaceOnUse" x="0" y={offsetY}>
            <rect width="6" height={period / 2} className="neatline__tick" />
          </pattern>
        </defs>
      </svg>
      <svg className="neatline__edge neatline__edge--top">
        <rect width="100%" height="100%" fill="url(#mk-ticks-x)" />
      </svg>
      <svg className="neatline__edge neatline__edge--bottom">
        <rect width="100%" height="100%" fill="url(#mk-ticks-x)" />
      </svg>
      <svg className="neatline__edge neatline__edge--left">
        <rect width="100%" height="100%" fill="url(#mk-ticks-y)" />
      </svg>
      <svg className="neatline__edge neatline__edge--right">
        <rect width="100%" height="100%" fill="url(#mk-ticks-y)" />
      </svg>
      <div className="meridians">
        {layout.columns.map((column) => (
          <span
            key={column.rank}
            className="meridian"
            style={{ transform: `translateX(${x + column.x * zoom}px)` }}
          >
            <span className="meridian__letter">{column.letter}</span>
            {column.label}
          </span>
        ))}
        {layout.fog && (
          <span
            className="meridian meridian--fog"
            style={{ transform: `translateX(${x + layout.fog.x * zoom + 26 * zoom}px)` }}
          >
            Uncharted {fogShare}%
          </span>
        )}
      </div>
    </div>
  );
}

function ZoomControls({ onFit }: { onFit: () => void }) {
  const { zoomIn, zoomOut } = useReactFlow();
  return (
    <div className="zoom" role="group" aria-label="Chart zoom">
      <span className="zoom__scale" title="Current chart scale">
        <ScaleWord />
      </span>
      <button type="button" aria-label="Zoom in" onClick={() => void zoomIn({ duration: 120 })}>
        +
      </button>
      <button type="button" aria-label="Zoom out" onClick={() => void zoomOut({ duration: 120 })}>
        −
      </button>
      <button type="button" aria-label="Fit the whole chart" onClick={onFit}>
        Fit
      </button>
    </div>
  );
}

function ScaleWord() {
  const zoom = useStore((state) => state.transform[2]);
  return <>{`1 : ${(1 / zoom).toFixed(2)}`}</>;
}

function nearest(ids: readonly string[], from: PlacedNode, placed: ReadonlyMap<string, PlacedNode>): string | null {
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const other = placed.get(id);
    if (!other) continue;
    const gap = Math.abs(other.y - from.y) + Math.abs(other.x - from.x) * 0.1;
    if (gap < distance) {
      best = id;
      distance = gap;
    }
  }
  return best;
}

function stepVertical(from: PlacedNode, nodes: readonly PlacedNode[], direction: 1 | -1): string | null {
  const ahead = nodes.filter(
    (node) => node.x === from.x && (node.y - from.y) * direction > 0,
  );
  const pool = ahead.length > 0 ? ahead : nodes.filter((node) => (node.y - from.y) * direction > 0);
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const node of pool) {
    const gap = Math.abs(node.y - from.y) + Math.abs(node.x - from.x);
    if (gap < distance) {
      best = node.id;
      distance = gap;
    }
  }
  return best;
}

function firstStop(snapshot: Snapshot): string | null {
  for (const cls of ["alert", "review", "queue"] as const) {
    const hit = snapshot.nodes.find((node) => node.class === cls);
    if (hit) return hit.id;
  }
  return snapshot.nodes[0]?.id ?? null;
}

function Chart({
  snapshot,
  graph,
  layout,
  selected,
  onSelect,
  onInspect,
  now,
  keysRef,
  frameRef,
}: {
  snapshot: Snapshot;
  graph: Graph;
  layout: ChartLayout;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onInspect: (id: string) => void;
  now: number;
  keysRef: RefObject<ViewKeys | null>;
  frameRef: RefObject<HTMLDivElement | null>;
}) {
  const flow = useReactFlow();
  const [ready, setReady] = useState(false);
  const zoom = useStore((state) => state.transform[2]);
  const placed = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]);
  const related = useMemo(
    () => (selected && graph.byId.has(selected) ? relatedTo(selected, graph) : null),
    [selected, graph],
  );

  const nodes = useMemo<MarkNode[]>(
    () =>
      layout.nodes.flatMap((node) => {
        const source = graph.byId.get(node.id);
        if (!source) return [];
        return [
          {
            id: node.id,
            type: "mark" as const,
            position: { x: node.x, y: node.y },
            width: MARK_WIDTH,
            height: node.height,
            draggable: false,
            connectable: false,
            selectable: false,
            focusable: false,
            data: {
              node: source,
              formula: node.height > MARK_HEIGHT ? (source.latex ?? null) : null,
              sounding: graph.soundings.get(node.id) ?? 0,
              selected: node.id === selected,
              dim: related !== null && !related.has(node.id),
            },
          },
        ];
      }),
    [layout, graph, selected, related],
  );

  const reduced = useMemo(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    [],
  );
  const duration = reduced ? 0 : 180;

  const fit = useCallback(
    (animate = true) => {
      const frame = frameRef.current;
      if (!frame) return;
      // Clear of the neatline and the meridian ruler. Very large fog may run
      // off the sheet: its size stays true, and the marks stay readable.
      const left = 40;
      const top = 36;
      const right = 14;
      const bottom = 14;
      const fogShare = layout.fog ? Math.min(layout.fog.width, layout.width * 0.5) : 0;
      const sheet = layout.width + fogShare + 28;
      const widthFit = (frame.clientWidth - left - right) / sheet;
      const heightFit = (frame.clientHeight - top - bottom) / Math.max(layout.height, 1);
      // A tall map keeps a useful scale and scrolls, rather than shrinking to dust.
      const zoom = Math.min(widthFit, Math.max(heightFit, READABLE_ZOOM), 1.15);
      const spare = Math.max(0, frame.clientWidth - left - right - sheet * zoom);
      void flow.setViewport(
        { x: left + spare / 2 + 28 * zoom, y: top, zoom },
        { duration: animate ? duration : 0 },
      );
    },
    [flow, frameRef, layout, duration],
  );

  useEffect(() => {
    if (ready) fit(false);
  }, [ready, fit]);

  const bringIntoView = useCallback(
    (id: string) => {
      const node = placed.get(id);
      const frame = frameRef.current;
      if (!node || !frame) return;
      const { x, y, zoom: scale } = flow.getViewport();
      const left = node.x * scale + x;
      const top = node.y * scale + y;
      const margin = 48;
      const outside =
        left < margin ||
        top < margin ||
        left + MARK_WIDTH * scale > frame.clientWidth - margin ||
        top + node.height * scale > frame.clientHeight - margin;
      if (outside) {
        void flow.setCenter(node.x + MARK_WIDTH / 2, node.y + RULE_Y, { zoom: scale, duration });
      }
    },
    [flow, placed, frameRef, duration],
  );

  useEffect(() => {
    if (selected) bringIntoView(selected);
  }, [selected, bringIntoView]);

  useEffect(() => {
    keysRef.current = (event) => {
      if (event.key === "+" || event.key === "=") {
        void flow.zoomIn({ duration });
        return true;
      }
      if (event.key === "-") {
        void flow.zoomOut({ duration });
        return true;
      }
      if (event.key === "0") {
        fit();
        return true;
      }
      const from = selected ? placed.get(selected) : undefined;
      if (event.key.startsWith("Arrow")) {
        if (!from) {
          onSelect(firstStop(snapshot));
          return true;
        }
        let next: string | null = null;
        if (event.key === "ArrowRight") next = nearest(graph.children.get(from.id) ?? [], from, placed);
        if (event.key === "ArrowLeft") next = nearest(graph.parents.get(from.id) ?? [], from, placed);
        if (event.key === "ArrowDown") next = stepVertical(from, layout.nodes, 1);
        if (event.key === "ArrowUp") next = stepVertical(from, layout.nodes, -1);
        if (next) onSelect(next);
        return true;
      }
      if (event.key === "Enter" && from) {
        onInspect(from.id);
        return true;
      }
      return false;
    };
    return () => {
      keysRef.current = null;
    };
  }, [flow, keysRef, selected, placed, graph, layout, snapshot, onSelect, onInspect, fit, duration]);

  return (
    <div className="chart-flow" data-far={zoom < FAR_ZOOM || undefined}>
      <ReactFlow<MarkNode>
        nodes={nodes}
        edges={[]}
        nodeTypes={NODE_TYPES}
        minZoom={0.08}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnScroll
        zoomOnDoubleClick={false}
        disableKeyboardA11y
        onlyRenderVisibleElements={layout.nodes.length > 120}
        proOptions={{ hideAttribution: true }}
        onInit={() => setReady(true)}
        onNodeClick={(_, node) => onSelect(node.id)}
        onNodeDoubleClick={(_, node) => onInspect(node.id)}
        onPaneClick={() => onSelect(null)}
      >
        <ViewportPortal>
          <div className="chart-layers">
            <svg
              className="chart-svg"
              width={layout.width + (layout.fog?.width ?? 0)}
              height={Math.max(layout.height, 1)}
              aria-hidden="true"
            >
              <defs>
                <pattern id="mk-stipple" width="7" height="7" patternUnits="userSpaceOnUse">
                  <circle cx="1.5" cy="1.5" r="0.75" className="stipple-dot" />
                  <circle cx="5" cy="5" r="0.75" className="stipple-dot" />
                </pattern>
              </defs>
              <FogLayer layout={layout} />
              <Wake activity={snapshot.activity} placed={placed} now={now} />
              <Edges edges={layout.edges} graph={graph} related={related} selected={selected} />
            </svg>
            <Bands layout={layout} graph={graph} />
            <FogLabels layout={layout} />
          </div>
        </ViewportPortal>
        <Neatline layout={layout} />
        {layout.nodes.length >= MINIMAP_FROM && (
          <MiniMap
            className="inset"
            pannable
            zoomable
            ariaLabel="Chart inset"
            nodeClassName={(node) => `inset__mark inset__mark--${(node.data as MarkData).node.class}`}
          />
        )}
        <ZoomControls onFit={() => fit()} />
      </ReactFlow>
    </div>
  );
}

function Readout({
  node,
  graph,
  onInspect,
}: {
  node: SnapshotNode;
  graph: Graph;
  onInspect: (id: string) => void;
}) {
  const sounding = graph.soundings.get(node.id) ?? 0;
  return (
    <div className="readout" data-cls={node.class}>
      <ClassMark cls={node.class} size={24} />
      <div className="readout__text">
        <p className="readout__title">{node.title}</p>
        <p className="readout__line">
          {kindLabel(node.kind)} · {classLabel(node.class)} · {statusLabel(node.status, node.pinned_to_code)}
          {sounding > 0 ? ` · ${sounding} downstream` : ""}
        </p>
      </div>
      <div className="readout__tex">{node.latex ? <Tex latex={node.latex} /> : null}</div>
      <a className="readout__open" href={`#/node/${encodeURIComponent(node.id)}`} onClick={(event) => {
        event.preventDefault();
        onInspect(node.id);
      }}>
        Inspect
      </a>
    </div>
  );
}

function Legend({ snapshot }: { snapshot: Snapshot }) {
  const { summary } = snapshot;
  const classes: NodeClass[] = ["fresh", "queue", "review", "alert"];
  return (
    <div className="legend" role="group" aria-label="Legend">
      <h2 className="legend__title">Legend</h2>
      <ul className="legend__items">
        {classes.map((cls) => (
          <li key={cls} className="legend__item" data-cls={cls} title={classSentence(cls)}>
            <ClassMark cls={cls} size={18} />
            <span>{classLabel(cls)}</span>
          </li>
        ))}
        <li className="legend__item" title="A result this node depends on changed. This is not an alert.">
          <UpstreamMark size={14} />
          <span>Upstream changed</span>
        </li>
        <li className="legend__item" title="An ambiguity was settled by reading the code. It matches current behaviour.">
          <AnchorMark size={14} />
          <span>Pinned to code</span>
        </li>
        <li className="legend__item" title="How many results sit downstream of this node.">
          <span className="legend__sounding">7</span>
          <span>Sounding: downstream</span>
        </li>
        <li className="legend__item" title="Files changed recently. The wake fades with time.">
          <WakeSample />
          <span>Wake</span>
        </li>
        <li
          className="legend__item"
          title={`Repository lines in no mapped module: ${percent(summary.unchartedShare)}%. The stippled area is that share of the chart.`}
        >
          <FogSample />
          <span>Uncharted to scale</span>
        </li>
      </ul>
    </div>
  );
}

export function ChainView({
  snapshot,
  graph,
  selected,
  onSelect,
  onInspect,
  now,
  phone,
  keysRef,
}: {
  snapshot: Snapshot;
  graph: Graph;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onInspect: (id: string) => void;
  now: number;
  phone: boolean;
  keysRef: RefObject<ViewKeys | null>;
}) {
  const [mode, setMode] = useState<"chart" | "formulas" | "passage">(phone ? "passage" : "chart");
  const [legendOpen, setLegendOpen] = useState(false);
  const [formulas, setFormulas] = useState(true);
  const hasFormulas = snapshot.nodes.some((entry) => entry.latex);
  const state = useChartLayout(snapshot, formulas);
  const frameRef = useRef<HTMLDivElement>(null);
  const node = selected ? (graph.byId.get(selected) ?? null) : null;

  useEffect(() => setMode(phone ? "passage" : "chart"), [phone]);

  if (snapshot.nodes.length === 0) return <BlankChart snapshot={snapshot} />;

  const showFormulas = mode === "formulas";
  const showPassage = !showFormulas && (mode === "passage" || state.failed);
  const showChart = !showFormulas && !showPassage;

  return (
    <div className="chain" data-mode={showFormulas ? "formulas" : showPassage ? "passage" : "chart"}>
      <h1 className="sr-only">Chain of {snapshot.repo.name}</h1>
      {showFormulas ? (
        <FormulaSheet snapshot={snapshot} selected={selected} keysRef={keysRef} />
      ) : showPassage ? (
        <PassageList snapshot={snapshot} graph={graph} selected={selected} keysRef={keysRef} failed={state.failed} />
      ) : (
        <div
          ref={frameRef}
          className="chart"
          role="application"
          aria-roledescription="chart of the mathematics"
          aria-label="Chain. Arrow keys follow the chain, Enter opens the Inspector."
          tabIndex={0}
          id="main-focus"
        >
          {state.layout ? (
            <ReactFlowProvider>
              <Chart
                snapshot={snapshot}
                graph={graph}
                layout={state.layout}
                selected={selected}
                onSelect={onSelect}
                onInspect={onInspect}
                now={now}
                keysRef={keysRef}
                frameRef={frameRef}
              />
            </ReactFlowProvider>
          ) : (
            <p className="chart__laying">Laying out {snapshot.nodes.length} marks</p>
          )}
        </div>
      )}
      <p className="sr-only" role="status">
        {node ? `${node.title}. ${kindLabel(node.kind)}. ${classLabel(node.class)}.` : ""}
      </p>
      <div className="margin" data-legend={legendOpen || undefined}>
        <button
          type="button"
          className="margin__fold"
          aria-expanded={legendOpen}
          onClick={() => setLegendOpen((open) => !open)}
        >
          Legend
        </button>
        {node && showChart ? (
          <Readout node={node} graph={graph} onInspect={onInspect} />
        ) : (
          <Legend snapshot={snapshot} />
        )}
        {showChart && hasFormulas && (
          <div className="margin__mode" role="group" aria-label="What each mark shows">
            <button type="button" aria-pressed={!formulas} onClick={() => setFormulas(false)}>
              Titles
            </button>
            <button type="button" aria-pressed={formulas} onClick={() => setFormulas(true)}>
              Equations
            </button>
          </div>
        )}
        <div className="margin__mode" role="group" aria-label="Chain layout">
          <button type="button" aria-pressed={showChart} onClick={() => setMode("chart")}>
            Chart
          </button>
          <button type="button" aria-pressed={showFormulas} onClick={() => setMode("formulas")}>
            Formulas
          </button>
          <button type="button" aria-pressed={showPassage} onClick={() => setMode("passage")}>
            List
          </button>
        </div>
      </div>
      <WakeLog snapshot={snapshot} now={now} />
    </div>
  );
}

function WakeLog({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const recent = snapshot.activity.filter((item) => wakeStrength(item.changedAt, now) > 0);
  if (recent.length === 0) return null;
  return (
    <ul className="sr-only" aria-label="Recent activity">
      {recent.map((item) => (
        <li key={`${item.path}${item.changedAt}`}>
          {item.path} changed {ago(item.changedAt, now)}, touching {item.touches.length} nodes
        </li>
      ))}
    </ul>
  );
}

function BlankChart({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="blank" id="main-focus" tabIndex={-1}>
      <div className="blank__sheet">
        <p className="blank__word" aria-hidden="true">
          Unsurveyed
        </p>
        <h1 className="blank__title">No mathematics mapped yet</h1>
        <p className="blank__body">
          {snapshot.repo.name} has no mapped nodes, so this chart is blank rather than clear. Nothing here means
          that anything has been reviewed.
        </p>
        <ol className="blank__steps">
          <li>
            <code>mathkeel init</code>
            <span>creates .mathkeel/</span>
          </li>
          <li>
            <code>mathkeel map lint</code>
            <span>checks the nodes you add to the map</span>
          </li>
          <li>
            <code>mathkeel map freeze</code>
            <span>records hashes and the inventory</span>
          </li>
        </ol>
      </div>
    </div>
  );
}
