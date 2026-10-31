import { type RefObject, useEffect, useRef, useState } from "react";
import type { GapGroup, Inbox, RootCause } from "../model/grouping";
import { classLabel, kindLabel, verdictLabel } from "../model/language";
import { ago, percent, stamp } from "../model/time";
import type { Graph } from "../model/trace";
import type { Snapshot, SnapshotNode } from "../snapshot";
import { AnchorMark, ClassMark, UpstreamMark } from "../ui/Marks";
import type { ViewKeys } from "./ChainView";

const GAP_KIND: Record<string, string> = {
  function: "Function",
  parameter: "Parameter",
  member: "List member",
};

function nodeHref(id: string): string {
  return `#/node/${encodeURIComponent(id)}`;
}

function why(node: SnapshotNode): string {
  return node.reasons[0] ?? classLabel(node.class);
}

function NodeRow({ node, selected, tail }: { node: SnapshotNode; selected: boolean; tail?: string }) {
  return (
    <li className="entry" data-cls={node.class}>
      <a className="entry__link" href={nodeHref(node.id)} data-row data-selected={selected || undefined}>
        <span className="entry__glyph">
          {node.class === "fresh" && node.upstreamChanged.length > 0 ? (
            <UpstreamMark size={15} />
          ) : (
            <ClassMark cls={node.class} size={20} />
          )}
        </span>
        <span className="entry__main">
          <span className="entry__title">{node.title}</span>
          <span className="entry__id">{node.id}</span>
        </span>
        <span className="entry__kind">
          {kindLabel(node.kind)}
          {node.pinned_to_code && <AnchorMark size={12} />}
        </span>
        <span className="entry__state">
          {node.class === "fresh" ? "Upstream changed" : classLabel(node.class)}
          {tail ? <span className="entry__tail"> {tail}</span> : null}
        </span>
      </a>
    </li>
  );
}

function causeTitle(cause: RootCause): string {
  if (cause.contract) return cause.contract.id;
  return cause.members[0]?.title ?? cause.id;
}

function causeSummary(cause: RootCause): string {
  if (cause.contract?.msg) return cause.contract.msg;
  const first = cause.members[0];
  return first ? why(first) : "";
}

function CauseBlock({ cause, cursor, graph }: { cause: RootCause; cursor: string | null; graph: Graph }) {
  const holdsCursor = cause.downstream.some((entry) => entry.node.id === cursor);
  const [open, setOpen] = useState(false);
  const shown = open || holdsCursor;
  const proposal = cause.members.find((node) => node.verdict)?.verdict;
  const single = cause.contract === null && cause.members.length === 1;
  const sounding = cause.members.reduce((most, node) => Math.max(most, graph.soundings.get(node.id) ?? 0), 0);
  const first = cause.members[0];

  return (
    <article className="cause" data-cls={cause.cls}>
      <header className="cause__head">
        <span className="cause__glyph">
          <ClassMark cls={cause.cls} size={24} />
        </span>
        <div className="cause__text">
          <h3 className="cause__title">
            {single && first ? (
              <a href={nodeHref(first.id)} data-row data-selected={first.id === cursor || undefined}>
                {causeTitle(cause)}
              </a>
            ) : (
              <>
                <span className="cause__eyebrow">Shared contract</span> <code>{causeTitle(cause)}</code>
              </>
            )}
          </h3>
          <p className="cause__why">{causeSummary(cause)}</p>
          {proposal && (
            <p className="cause__proposal">
              <span className="cause__proposal-who">Agent</span> {verdictLabel(proposal.verdict).toLowerCase()},
              confidence {proposal.confidence.toFixed(2)}. Not a decision.
            </p>
          )}
        </div>
        <p className="cause__depth" title="Results downstream of this cause">
          <span className="cause__depth-value">{sounding}</span>
          <span className="cause__depth-label">downstream</span>
        </p>
      </header>

      {!single && (
        <ul className="entries">
          {cause.members.map((node) => (
            <NodeRow key={node.id} node={node} selected={node.id === cursor} />
          ))}
        </ul>
      )}

      {cause.downstream.length > 0 && (
        <div className="cause__under">
          <button
            type="button"
            className="cause__toggle"
            aria-expanded={shown}
            data-row
            onClick={() => setOpen((value) => !value)}
          >
            <span className="cause__chevron" aria-hidden="true" data-open={shown || undefined} />
            {cause.downstream.length} downstream
            {!shown && (
              <span className="cause__preview">
                {cause.downstream
                  .slice(0, 3)
                  .map((entry) => entry.node.title)
                  .join(", ")}
                {cause.downstream.length > 3 ? ", and more" : ""}
              </span>
            )}
          </button>
          {shown && (
            <ul className="entries entries--under">
              {cause.downstream.map(({ node, alsoUnder }) => (
                <NodeRow
                  key={node.id}
                  node={node}
                  selected={node.id === cursor}
                  tail={alsoUnder.length > 0 ? `also under ${alsoUnder.join(", ")}` : undefined}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

function GapList({ groups }: { groups: readonly GapGroup[] }) {
  return (
    <div className="gaps">
      {groups.map((group) => (
        <div key={group.path} className="gaps__file">
          <h3 className="gaps__path">{group.path}</h3>
          <ul className="gaps__list">
            {group.gaps.map((gap) => (
              <li key={`${gap.kind}:${gap.symbol}`}>
                <code>{gap.symbol}</code>
                <span className="gaps__kind">{GAP_KIND[gap.kind] ?? gap.kind}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Ledger({
  label,
  count,
  note,
  children,
}: {
  label: string;
  count: number | string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="ledger">
      <header className="ledger__head">
        <h2 className="ledger__title">{label}</h2>
        <p className="ledger__count">{count}</p>
        <p className="ledger__note">{note}</p>
      </header>
      <div className="ledger__body">{children}</div>
    </section>
  );
}

const SECTION_NOTE: Record<string, string> = {
  alert: "A contract failed and the documentation did not move.",
  review: "An agent proposes these are legitimate. A person decides.",
  queue: "An anchor changed or moved, or the documentation moved with the code.",
};

function ClearWater({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="clear">
      <h2 className="clear__title">Nothing needs review</h2>
      <p className="clear__body">
        All {snapshot.nodes.length} mapped nodes match baseline <code>{snapshot.repo.baseline.slice(0, 7)}</code>.{" "}
        {snapshot.contractsRun
          ? "Their contracts passed for this snapshot."
          : "Contracts have not run for this snapshot, so this compares hashes only. Run mathkeel check to run them."}
      </p>
      <p className="clear__body">This describes change since the baseline. It says nothing beyond that.</p>
    </div>
  );
}

export function InboxView({
  snapshot,
  inbox,
  graph,
  cursor,
  now,
  keysRef,
}: {
  snapshot: Snapshot;
  inbox: Inbox;
  graph: Graph;
  cursor: string | null;
  now: number;
  keysRef: RefObject<ViewKeys | null>;
}) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    keysRef.current = (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
      const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
      if (rows.length === 0) return false;
      const index = rows.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = rows[index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + step))];
      next?.focus();
      return true;
    };
    return () => {
      keysRef.current = null;
    };
  }, [keysRef]);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>("[data-row][data-selected]")?.focus();
  }, []);

  const changed = inbox.order.length;
  const blank = snapshot.nodes.length === 0;
  const clear = !blank && inbox.sections.length === 0;

  return (
    <div className="inbox" ref={root} id="main-focus" tabIndex={-1}>
      <header className="inbox__head">
        <h1 className="inbox__title">Inbox</h1>
        <p className="inbox__lede">
          {blank
            ? "No mathematics is mapped yet, so nothing can change."
            : clear
              ? "No open causes."
              : `${inbox.causeCount} ${inbox.causeCount === 1 ? "cause" : "causes"} behind ${changed} changed ${
                  changed === 1 ? "node" : "nodes"
                }. Downstream results collapse under the node that changed.`}
        </p>
      </header>

      {clear && <ClearWater snapshot={snapshot} />}

      {inbox.sections.map((section) => (
        <Ledger
          key={section.cls}
          label={section.label}
          count={section.causes.length}
          note={SECTION_NOTE[section.cls] ?? ""}
        >
          {section.causes.map((cause) => (
            <CauseBlock key={cause.id} cause={cause} cursor={cursor} graph={graph} />
          ))}
        </Ledger>
      ))}

      {inbox.gaps.length > 0 && (
        <Ledger
          label="Gaps"
          count={snapshot.gaps.length}
          note="Public names in mapped modules that the frozen inventory does not list. Never an alert."
        >
          <GapList groups={inbox.gaps} />
        </Ledger>
      )}

      {snapshot.uncharted.length > 0 && (
        <Ledger
          label="Uncharted"
          count={`${percent(snapshot.summary.unchartedShare)}%`}
          note="Source files in no mapped module. Never an alert."
        >
          <ul className="uncharted">
            {snapshot.uncharted.map((entry) => (
              <li key={entry.path}>
                <span className="uncharted__path">{entry.path}</span>
                <span className="uncharted__lines">{entry.lines.toLocaleString("en")} lines</span>
              </li>
            ))}
          </ul>
        </Ledger>
      )}

      {snapshot.decisions.length > 0 && (
        <Ledger label="Log" count={snapshot.decisions.length} note="Decisions people recorded with mathkeel accept.">
          <ul className="log">
            {[...snapshot.decisions]
              .sort((a, b) => b.at.localeCompare(a.at))
              .map((decision) => (
                <li key={`${decision.id}${decision.at}`}>
                  <p className="log__head">
                    <a href={nodeHref(decision.id)}>{decision.id}</a>
                    <span className="log__who">
                      {decision.by}, <time dateTime={decision.at} title={stamp(decision.at)}>{ago(decision.at, now)}</time>
                    </span>
                  </p>
                  <p className="log__reason">{decision.reason}</p>
                </li>
              ))}
          </ul>
        </Ledger>
      )}
    </div>
  );
}
