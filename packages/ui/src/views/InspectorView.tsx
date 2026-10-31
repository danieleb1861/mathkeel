import { type RefObject, useEffect, useMemo } from "react";
import { diffWords } from "../model/diff";
import {
  acceptCommand,
  anchorLabel,
  classLabel,
  classSentence,
  contractStateLabel,
  kindLabel,
  needsAcceptance,
  proofLabel,
  statusLadder,
  verdictLabel,
} from "../model/language";
import { ago, stamp } from "../model/time";
import { type Graph, levels } from "../model/trace";
import type { Anchor, Snapshot, SnapshotNode } from "../snapshot";
import { CopyCommand } from "../ui/CopyCommand";
import { AnchorMark, ClassMark, UpstreamMark } from "../ui/Marks";
import { Tex } from "../ui/Tex";
import type { ViewKeys } from "./ChainView";

function nodeHref(id: string): string {
  return `#/node/${encodeURIComponent(id)}`;
}

function DiffText({ before, after, side }: { before: string; after: string; side: "before" | "after" }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "same") return <span key={index}>{part.text}</span>;
        if (part.type === "removed") return side === "before" ? <del key={index}>{part.text}</del> : null;
        return side === "after" ? <ins key={index}>{part.text}</ins> : null;
      })}
    </>
  );
}

function Span({ anchor, fallback }: { anchor: Anchor; fallback: string | null }) {
  const { before, after, state } = anchor;
  const place = `${anchor.path}${anchor.line ? `:${anchor.line}` : ""}`;
  const shared = before !== null && after !== null && before !== after;

  return (
    <div className="span" data-state={state}>
      <header className="span__head">
        <p className="span__place" title={place}>
          {place}
        </p>
        {anchor.symbol && <p className="span__symbol">{anchor.symbol}</p>}
        <p className="span__state">{anchorLabel(state)}</p>
      </header>
      {shared ? (
        <dl className="span__pair">
          <div className="span__side">
            <dt>Before</dt>
            <dd>
              <DiffText before={before} after={after} side="before" />
            </dd>
          </div>
          <div className="span__side">
            <dt>After</dt>
            <dd>
              <DiffText before={before} after={after} side="after" />
            </dd>
          </div>
        </dl>
      ) : state === "lost" ? (
        <dl className="span__pair">
          <div className="span__side">
            <dt>Before</dt>
            <dd>{before ?? fallback ?? "No quote on record."}</dd>
          </div>
          <div className="span__side span__side--gone">
            <dt>After</dt>
            <dd>This quote, symbol or file is no longer found.</dd>
          </div>
        </dl>
      ) : (
        <blockquote className="span__quote">{after ?? before ?? fallback ?? "No quote on record."}</blockquote>
      )}
    </div>
  );
}

function Trace({ node, graph }: { node: SnapshotNode; graph: Graph }) {
  const up = useMemo(() => levels(node.id, graph.parents), [node.id, graph]);
  const down = useMemo(() => levels(node.id, graph.children), [node.id, graph]);

  const row = (id: string) => {
    const other = graph.byId.get(id);
    if (!other) return null;
    return (
      <li key={id} data-cls={other.class}>
        <a href={nodeHref(id)}>
          <ClassMark cls={other.class} size={16} />
          <span>{other.title}</span>
        </a>
      </li>
    );
  };

  const upward = [...up].reverse().flat();
  const downward = down.flat();
  const trim = 9;

  return (
    <nav className="trace" aria-label="Chain around this node">
      <h2 className="eyebrow">Upstream</h2>
      {upward.length > 0 ? (
        <ul className="trace__list">
          {upward.slice(-trim).map(row)}
        </ul>
      ) : (
        <p className="trace__none">Starts here.</p>
      )}
      <p className="trace__here" data-cls={node.class}>
        <ClassMark cls={node.class} size={18} />
        <span>This node</span>
      </p>
      <h2 className="eyebrow">Downstream</h2>
      {downward.length > 0 ? (
        <ul className="trace__list">
          {downward.slice(0, trim).map(row)}
          {downward.length > trim && <li className="trace__more">and {downward.length - trim} more</li>}
        </ul>
      ) : (
        <p className="trace__none">Ends here.</p>
      )}
    </nav>
  );
}

function Ladder({ node }: { node: SnapshotNode }) {
  const rungs = statusLadder(node.status, node.pinned_to_code);
  return (
    <ol className="ladder" aria-label="Status ladder">
      {rungs.map((rung) => (
        <li
          key={rung.label}
          className="ladder__rung"
          data-reached={rung.reached || undefined}
          data-current={rung.current || undefined}
          aria-current={rung.current ? "step" : undefined}
        >
          <span className="ladder__pin" aria-hidden="true" />
          <span className="ladder__label">{rung.label}</span>
        </li>
      ))}
    </ol>
  );
}

function Empty({ inbox, graph }: { inbox: readonly string[]; graph: Graph }) {
  const first = inbox[0] ? graph.byId.get(inbox[0]) : undefined;
  return (
    <div className="inspector-empty" id="main-focus" tabIndex={-1}>
      <h1>Nothing to inspect yet</h1>
      <p>Choose a mark on the Chain or an entry in the Inbox.</p>
      {first && (
        <p>
          Next in the Inbox: <a href={nodeHref(first.id)}>{first.title}</a>
        </p>
      )}
    </div>
  );
}

export function InspectorView({
  snapshot,
  graph,
  id,
  inboxOrder,
  now,
  onOpen,
  backLabel,
  onBack,
  keysRef,
}: {
  snapshot: Snapshot;
  graph: Graph;
  id: string | null;
  inboxOrder: readonly string[];
  now: number;
  onOpen: (id: string) => void;
  backLabel: string;
  onBack: () => void;
  keysRef: RefObject<ViewKeys | null>;
}) {
  const node = id ? graph.byId.get(id) : undefined;
  const position = id ? inboxOrder.indexOf(id) : -1;
  const previous = position > 0 ? inboxOrder[position - 1] : undefined;
  const next = position >= 0 ? inboxOrder[position + 1] : inboxOrder[0];

  useEffect(() => {
    keysRef.current = (event) => {
      if (event.key === "]" && next) {
        onOpen(next);
        return true;
      }
      if (event.key === "[" && previous) {
        onOpen(previous);
        return true;
      }
      if (!node) return false;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const list = (event.key === "ArrowRight" ? graph.children : graph.parents).get(node.id) ?? [];
        if (list[0]) onOpen(list[0]);
        return true;
      }
      return false;
    };
    return () => {
      keysRef.current = null;
    };
  }, [keysRef, node, next, previous, graph, onOpen]);

  useEffect(() => {
    document.getElementById("main-focus")?.focus({ preventScroll: true });
    document.getElementById("main-focus")?.scrollTo?.({ top: 0 });
  }, [id]);

  if (!node) {
    if (id) {
      return (
        <div className="inspector-empty" id="main-focus" tabIndex={-1}>
          <h1>No node with this id</h1>
          <p>
            <code>{id}</code> is not in this snapshot. It may have been removed from the map.
          </p>
        </div>
      );
    }
    return <Empty inbox={inboxOrder} graph={graph} />;
  }

  const docAnchors = node.anchors.filter((anchor) => anchor.kind === "doc");
  const codeAnchors = node.anchors.filter((anchor) => anchor.kind === "code");
  const nodeDecisions = snapshot.decisions.filter((decision) => decision.id === node.id);
  const upstream = node.upstreamChanged.map((other) => graph.byId.get(other)).filter((other) => other);
  const compared = Boolean(node.latex) && codeAnchors.length > 0;
  const equation = node.latex && (
    <div className="equation" tabIndex={0} role="group" aria-label="Rendered equation">
      <Tex latex={node.latex} display />
    </div>
  );
  const codeSpans = codeAnchors.map((anchor, index) => (
    <Span key={`${anchor.path}${anchor.symbol}`} anchor={anchor} fallback={node.code[index]?.quote || null} />
  ));

  return (
    <div className="inspector" id="main-focus" tabIndex={-1}>
      <div className="inspector__bar">
        <button type="button" className="plain-button" onClick={onBack}>
          <span aria-hidden="true">←</span> {backLabel}
        </button>
        <p className="inspector__crumb">
          {snapshot.chains.find((chain) => chain.id === node.chain)?.title ?? node.chain} · <code>{node.id}</code>
        </p>
        {position >= 0 && (
          <div className="inspector__step" role="group" aria-label="Step through the Inbox">
            <button type="button" className="plain-button" disabled={!previous} onClick={() => previous && onOpen(previous)}>
              <kbd>[</kbd> Previous
            </button>
            <span className="inspector__count">
              {position + 1} of {inboxOrder.length}
            </span>
            <button type="button" className="plain-button" disabled={!next} onClick={() => next && onOpen(next)}>
              Next <kbd>]</kbd>
            </button>
          </div>
        )}
      </div>

      <div className="inspector__grid">
        <Trace node={node} graph={graph} />

        <article className="sheet">
          <header className="sheet__head" data-cls={node.class}>
            <ClassMark cls={node.class} size={30} />
            <div className="sheet__titles">
              <h1 className="sheet__title">{node.title}</h1>
              <p className="sheet__sub">
                {kindLabel(node.kind)}
                {node.units ? ` in ${node.units}` : ""}
                {node.pinned_to_code && (
                  <span className="sheet__pinned">
                    <AnchorMark size={13} /> Matches current behaviour
                  </span>
                )}
              </p>
            </div>
            <p className="sheet__class">{classLabel(node.class)}</p>
          </header>

          <p className="sheet__sentence">{classSentence(node.class)}</p>

          {compared ? (
            <section className="compare" aria-label="Formula beside its code">
              <div className="compare__column">
                <h2 className="eyebrow">Formula</h2>
                {equation}
              </div>
              <div className="compare__column spans__column--code">
                <h2 className="eyebrow">Code</h2>
                {codeSpans}
              </div>
              <p className="compare__note">Placed together for reading. Only a contract compares them.</p>
            </section>
          ) : (
            equation
          )}

          {(node.reasons.length > 0 || upstream.length > 0) && (
            <section className="sheet__section">
              <h2 className="eyebrow">Why it is here</h2>
              <ul className="reasons">
                {node.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              {upstream.length > 0 && (
                <p className="upstream">
                  <UpstreamMark size={14} /> Upstream changed:{" "}
                  {upstream.map((other, index) => (
                    <span key={other?.id}>
                      {index > 0 ? ", " : ""}
                      <a href={nodeHref(other?.id ?? "")}>{other?.title}</a>
                    </span>
                  ))}
                  . This node is not an alert on that account.
                </p>
              )}
            </section>
          )}

          {node.verdict && (
            <section className="proposal" data-verdict={node.verdict.verdict}>
              <h2 className="eyebrow">Agent proposal, not a decision</h2>
              <p className="proposal__line">
                <span className="proposal__verdict">{verdictLabel(node.verdict.verdict)}</span>
                <span className="proposal__confidence">
                  confidence <span className="numeral">{node.verdict.confidence.toFixed(2)}</span>
                </span>
              </p>
              <p className="proposal__reason">{node.verdict.reason}</p>
            </section>
          )}

          <section className="sheet__section" aria-label="Documentation and code">
            <div className="spans" data-single={compared || undefined}>
              <div className="spans__column">
                <h2 className="eyebrow">Document</h2>
                {docAnchors.length > 0 ? (
                  docAnchors.map((anchor) => (
                    <Span key={`${anchor.path}${anchor.symbol}`} anchor={anchor} fallback={node.doc?.quote ?? null} />
                  ))
                ) : (
                  <p className="span__none">No document anchor.</p>
                )}
              </div>
              {!compared && (
                <div className="spans__column spans__column--code">
                  <h2 className="eyebrow">Code</h2>
                  {codeSpans.length > 0 ? codeSpans : <p className="span__none">No code anchor on this node.</p>}
                </div>
              )}
            </div>
          </section>

          <div className="sheet__pair">
            <section className="sheet__section">
              <h2 className="eyebrow">Contracts</h2>
              {node.contractResults.length > 0 ? (
                <ul className="contracts">
                  {node.contractResults.map((result) => (
                    <li key={result.id} className="contract" data-state={result.state}>
                      <span className="contract__mark" aria-hidden="true" />
                      <code className="contract__id">{result.id}</code>
                      <span className="contract__state">{contractStateLabel(result.state, node.pinned_to_code)}</span>
                      {result.msg && <p className="contract__msg">{result.msg}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sheet__quiet">No contract covers this node.</p>
              )}
              {node.contractResults.some((result) => result.state === "not_run") && (
                <p className="sheet__quiet">
                  Contracts run only on <code>mathkeel check</code>.
                </p>
              )}
              {node.verified_by.length > 0 && (
                <>
                  <h3 className="sheet__minor">Tests named by the map</h3>
                  <ul className="tests">
                    {node.verified_by.map((test) => (
                      <li key={test}>
                        <code>{test}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
            <section className="sheet__section">
              <h2 className="eyebrow">Status</h2>
              <Ladder node={node} />
              <h2 className="eyebrow eyebrow--spaced">Proof</h2>
              <p className="proof" data-state={node.proof.state}>
                {proofLabel(node.proof, node.pinned_to_code)}
                {!node.pinned_to_code && node.proof.ref && (
                  <>
                    {" "}
                    <code>{node.proof.ref}</code>
                  </>
                )}
              </p>
            </section>
          </div>

          <section className="decide">
            <h2 className="eyebrow">Decision</h2>
            {needsAcceptance(node) ? (
              <>
                <p className="decide__body">
                  This page cannot accept anything. If you judge the change acceptable, run this in the repository
                  with your own reason. It rebaselines the hashes and records your name, the time and the commit.
                </p>
                <CopyCommand command={acceptCommand(node.id)} label={`Copy the accept command for ${node.id}`} />
              </>
            ) : (
              <p className="decide__body">Nothing to accept: every anchor of this node matches the baseline.</p>
            )}
            {nodeDecisions.length > 0 && (
              <ul className="decide__log">
                {nodeDecisions.map((decision) => (
                  <li key={decision.at}>
                    <span className="decide__who">
                      Accepted by {decision.by}, <time dateTime={decision.at} title={stamp(decision.at)}>{ago(decision.at, now)}</time>
                    </span>
                    <span className="decide__reason">{decision.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </article>
      </div>
    </div>
  );
}
