import type { LinkState } from "../data/source";
import { classLabel } from "../model/language";
import { ago, percent, stamp } from "../model/time";
import type { Snapshot } from "../snapshot";
import type { Theme, View } from "./hooks";
import { KeelMark } from "./Marks";

const TABS: readonly { view: View; label: string; href: (id: string | null) => string }[] = [
  { view: "chain", label: "Chain", href: () => "#/chain" },
  { view: "inbox", label: "Inbox", href: () => "#/inbox" },
  {
    view: "inspect",
    label: "Inspector",
    href: (id) => (id ? `#/node/${encodeURIComponent(id)}` : "#/node"),
  },
];

function linkWords(link: LinkState, snapshot: Snapshot, now: number): string {
  if (link === "offline") return `Snapshot of ${stamp(snapshot.generatedAt)}`;
  if (link === "lost") return `Engine not reachable. Last snapshot ${ago(snapshot.generatedAt, now)}`;
  if (link === "connecting") return "Connecting to the engine";
  return `Live. Updated ${ago(snapshot.generatedAt, now)}`;
}

export function Header({
  snapshot,
  view,
  inboxCount,
  cursor,
  theme,
  onTheme,
  onSearch,
  onHelp,
}: {
  snapshot: Snapshot;
  view: View;
  inboxCount: number;
  cursor: string | null;
  theme: Theme;
  onTheme: () => void;
  onSearch: () => void;
  onHelp: () => void;
}) {
  return (
    <header className="titleblock">
      <a className="brand" href="#/chain" aria-label="mathkeel, go to Chain">
        <KeelMark />
        <span className="brand__word">mathkeel</span>
      </a>
      <p className="titleblock__repo" title={snapshot.repo.name}>
        {snapshot.repo.name}
        <code className="titleblock__head">
          {snapshot.repo.head.slice(0, 7)}
          {snapshot.repo.dirty && <span className="titleblock__dirty"> with local edits</span>}
        </code>
      </p>
      <nav className="tabs" aria-label="Views">
        {TABS.map((tab) => (
          <a
            key={tab.view}
            className="tabs__tab"
            href={tab.href(cursor)}
            aria-current={view === tab.view ? "page" : undefined}
          >
            {tab.label}
            {tab.view === "inbox" && inboxCount > 0 && (
              <span className="tabs__count">
                <span className="sr-only">, </span>
                {inboxCount}
                <span className="sr-only"> open</span>
              </span>
            )}
          </a>
        ))}
      </nav>
      <div className="tools">
        <button type="button" className="tool tool--search" onClick={onSearch} aria-keyshortcuts="/">
          <span>Search</span>
          <kbd>/</kbd>
        </button>
        <button
          type="button"
          className="tool"
          onClick={onTheme}
          aria-keyshortcuts="t"
          aria-label={theme === "day" ? "Switch to night chart" : "Switch to day chart"}
        >
          {theme === "day" ? "Night" : "Day"}
        </button>
        <button type="button" className="tool tool--keys" onClick={onHelp} aria-keyshortcuts="?" aria-label="Keyboard keys">
          <kbd>?</kbd>
        </button>
      </div>
    </header>
  );
}

function Sounding({
  value,
  unit,
  label,
  href,
  cls,
}: {
  value: string | number;
  unit?: string;
  label: string;
  href: string;
  cls?: string;
}) {
  return (
    <a className="sounding" href={href} data-cls={cls}>
      <span className="sounding__value">
        {value}
        {unit && <span className="sounding__unit">{unit}</span>}
      </span>
      <span className="sounding__label">{label}</span>
    </a>
  );
}

export function SoundingStrip({
  snapshot,
  link,
  now,
}: {
  snapshot: Snapshot;
  link: LinkState;
  now: number;
}) {
  const { summary, repo, contractsRun } = snapshot;
  return (
    <section className="strip" aria-label="Soundings">
      <div className="strip__soundings">
        <Sounding value={summary.alert} label={classLabel("alert")} href="#/inbox" cls="alert" />
        <Sounding value={summary.review} label="Proposals" href="#/inbox" cls="review" />
        <Sounding value={summary.queue} label={classLabel("queue")} href="#/inbox" cls="queue" />
        <Sounding value={summary.fresh} label={classLabel("fresh")} href="#/chain" />
        <Sounding value={summary.gaps} label="Gaps" href="#/inbox" />
        <Sounding value={percent(summary.unchartedShare)} unit="%" label="Uncharted" href="#/inbox" />
      </div>
      <dl className="strip__facts">
        <div>
          <dt>Baseline</dt>
          <dd>
            <code>{repo.baseline.slice(0, 7)}</code>
          </dd>
        </div>
        <div>
          <dt className="sr-only">Contracts</dt>
          <dd>{contractsRun ? "Contracts run" : "Contracts not run: hashes only"}</dd>
        </div>
        <div className="strip__link" data-link={link}>
          <dt className="sr-only">Source</dt>
          <dd>{linkWords(link, snapshot, now)}</dd>
        </div>
      </dl>
    </section>
  );
}
