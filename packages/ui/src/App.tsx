import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessError,
  fetchSnapshot,
  inlinedSnapshot,
  type LinkState,
  subscribe,
  urlToken,
} from "./data/source";
import { groupInbox } from "./model/grouping";
import { SnapshotError } from "./model/parse";
import { buildGraph } from "./model/trace";
import type { Snapshot } from "./snapshot";
import { Header, SoundingStrip } from "./ui/Frame";
import { Help } from "./ui/Help";
import { type Route, useMediaQuery, useNow, useRoute, useTheme } from "./ui/hooks";
import { KeelMark, SharedDefs } from "./ui/Marks";
import { Search } from "./ui/Search";
import { ChainView, type ViewKeys } from "./views/ChainView";
import { InboxView } from "./views/InboxView";
import { InspectorView } from "./views/InspectorView";

type Trouble = { kind: "access" | "snapshot"; title: string; detail: string };

type Load =
  | { state: "loading" }
  | { state: "failed"; trouble: Trouble }
  | { state: "ready"; snapshot: Snapshot; link: LinkState };

function toTrouble(error: unknown): Trouble {
  if (error instanceof AccessError) {
    return { kind: "access", title: "This chart needs its link", detail: error.message };
  }
  if (error instanceof SnapshotError) {
    return { kind: "snapshot", title: error.message, detail: error.detail };
  }
  return {
    kind: "snapshot",
    title: "The snapshot could not be read.",
    detail: error instanceof Error ? error.message : "An unexpected error occurred.",
  };
}

function useLoad(): Load {
  const [load, setLoad] = useState<Load>(() => {
    try {
      const inlined = inlinedSnapshot();
      return inlined ? { state: "ready", snapshot: inlined, link: "offline" } : { state: "loading" };
    } catch (error) {
      return { state: "failed", trouble: toTrouble(error) };
    }
  });

  useEffect(() => {
    if (load.state !== "loading") return undefined;
    const token = urlToken();
    let stop: (() => void) | undefined;
    let cancelled = false;
    fetchSnapshot(token).then(
      (snapshot) => {
        if (cancelled) return;
        setLoad({ state: "ready", snapshot, link: "connecting" });
        stop = subscribe(
          token,
          (next) => setLoad((current) => (current.state === "ready" ? { ...current, snapshot: next, link: "live" } : current)),
          (link) => setLoad((current) => (current.state === "ready" ? { ...current, link } : current)),
        );
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ state: "failed", trouble: toTrouble(error) });
      },
    );
    return () => {
      cancelled = true;
      stop?.();
    };
    // Runs once: a ready load is kept alive by its subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return load;
}

function Standby({ children }: { children: React.ReactNode }) {
  return (
    <main className="standby">
      <div className="standby__sheet">
        <p className="standby__brand">
          <KeelMark /> mathkeel
        </p>
        {children}
      </div>
    </main>
  );
}

function Instrument({ snapshot, link }: { snapshot: Snapshot; link: LinkState }) {
  const [route, go] = useRoute();
  const [theme, toggleTheme] = useTheme();
  const phone = useMediaQuery("(max-width: 759px)");
  const [overlay, setOverlay] = useState<"search" | "help" | null>(null);
  const [cursor, setCursor] = useState<string | null>(route.id);
  const lastPlace = useRef<Route>({ view: route.view === "inspect" ? "inbox" : route.view, id: null });
  const pendingG = useRef<number | null>(null);
  const keysRef = useRef<ViewKeys | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const graph = useMemo(() => buildGraph(snapshot), [snapshot]);
  const inbox = useMemo(() => groupInbox(snapshot), [snapshot]);
  const now = useNow(link !== "offline", snapshot.generatedAt);

  useEffect(() => {
    if (route.id) setCursor(route.id);
    if (route.view !== "inspect") lastPlace.current = route;
  }, [route]);

  useEffect(() => {
    const open = snapshot.summary.alert + snapshot.summary.review + snapshot.summary.queue;
    document.title = `${open > 0 ? `${open} open · ` : ""}${snapshot.repo.name} · mathkeel`;
  }, [snapshot]);

  const inspect = useCallback((id: string) => go({ view: "inspect", id }), [go]);

  const select = useCallback(
    (id: string | null) => {
      setCursor(id);
      go({ view: "chain", id }, true);
    },
    [go],
  );

  const back = useCallback(() => {
    go({ ...lastPlace.current, id: cursor });
    window.setTimeout(() => document.getElementById("main-focus")?.focus({ preventScroll: true }), 0);
  }, [go, cursor]);

  const openOverlay = useCallback((which: "search" | "help") => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setOverlay(which);
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlay(null);
    window.setTimeout(() => returnFocus.current?.focus?.({ preventScroll: true }), 0);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.matches?.("input, textarea, select, [contenteditable='true']");
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        if (event.key === "c") go({ view: "chain", id: cursor }, false);
        else if (event.key === "i") go({ view: "inbox", id: cursor }, false);
        else if (event.key === "n") go({ view: "inspect", id: cursor }, false);
        else return;
        event.preventDefault();
        return;
      }

      if (event.key === "Escape") {
        if (overlay) {
          closeOverlay();
        } else if (route.view === "inspect") {
          back();
        } else if (route.view === "chain" && cursor) {
          select(null);
        }
        return;
      }
      if (overlay) return;

      if (event.key === "/") {
        event.preventDefault();
        openOverlay("search");
      } else if (event.key === "?") {
        openOverlay("help");
      } else if (event.key === "g") {
        pendingG.current = window.setTimeout(() => {
          pendingG.current = null;
        }, 1200);
      } else if (event.key === "t") {
        toggleTheme();
      } else if (keysRef.current?.(event)) {
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, route, cursor, overlay, back, select, closeOverlay, openOverlay, toggleTheme]);

  useEffect(() => {
    // Keys work from anywhere, so the chart itself takes focus only from Tab.
    const target = document.getElementById("main-focus");
    if (target?.getAttribute("tabindex") === "-1") target.focus({ preventScroll: true });
  }, [route.view]);

  return (
    <div className="instrument" data-view={route.view}>
      <SharedDefs />
      <a className="skip" href="#main-focus">
        Skip to the chart
      </a>
      <Header
        snapshot={snapshot}
        view={route.view}
        inboxCount={inbox.causeCount}
        cursor={cursor}
        theme={theme}
        onTheme={toggleTheme}
        onSearch={() => openOverlay("search")}
        onHelp={() => openOverlay("help")}
      />
      <SoundingStrip snapshot={snapshot} link={link} now={now} />
      <main className="stage">
        {route.view === "chain" && (
          <ChainView
            snapshot={snapshot}
            graph={graph}
            selected={route.id ?? cursor}
            onSelect={select}
            onInspect={inspect}
            now={now}
            phone={phone}
            keysRef={keysRef}
          />
        )}
        {route.view === "inbox" && (
          <InboxView
            snapshot={snapshot}
            inbox={inbox}
            graph={graph}
            cursor={route.id ?? cursor}
            now={now}
            keysRef={keysRef}
          />
        )}
        {route.view === "inspect" && (
          <InspectorView
            snapshot={snapshot}
            graph={graph}
            id={route.id ?? cursor}
            inboxOrder={inbox.order}
            now={now}
            onOpen={inspect}
            onBack={back}
            backLabel={lastPlace.current.view === "chain" ? "Chain" : "Inbox"}
            keysRef={keysRef}
          />
        )}
      </main>
      {overlay === "search" && (
        <Search
          nodes={snapshot.nodes}
          onClose={closeOverlay}
          onPick={(id) => {
            setOverlay(null);
            setCursor(id);
            inspect(id);
          }}
        />
      )}
      {overlay === "help" && <Help onClose={closeOverlay} />}
    </div>
  );
}

function Failure({ trouble }: { trouble: Trouble }) {
  return (
    <Standby>
      <h1 className="standby__title">{trouble.title}</h1>
      <p className="standby__body">{trouble.detail}</p>
      <p className="standby__hint">
        {trouble.kind === "access"
          ? "Run mathkeel serve in the repository, then open the link it prints."
          : "No decision or file was affected. This page only reads."}
      </p>
    </Standby>
  );
}

export function App() {
  const load = useLoad();
  useTheme();
  if (load.state === "loading") {
    return (
      <Standby>
        <p className="standby__body" role="status">
          Reading the snapshot
        </p>
      </Standby>
    );
  }
  if (load.state === "failed") return <Failure trouble={load.trouble} />;
  return <Instrument snapshot={load.snapshot} link={load.link} />;
}
