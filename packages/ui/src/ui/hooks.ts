import { useCallback, useEffect, useState } from "react";

export type View = "chain" | "inbox" | "inspect";

export interface Route {
  view: View;
  id: string | null;
}

export function parseRoute(hash: string): Route {
  const [, view = "", ...rest] = hash.replace(/^#/, "").split("/");
  const id = rest.length > 0 && rest.join("/") ? decodeURIComponent(rest.join("/")) : null;
  if (view === "inbox") return { view: "inbox", id };
  if (view === "node") return { view: "inspect", id };
  return { view: "chain", id };
}

export function routeHash(route: Route): string {
  const prefix = route.view === "inspect" ? "node" : route.view;
  return route.id ? `#/${prefix}/${encodeURIComponent(route.id)}` : `#/${prefix}`;
}

export function useRoute(): [Route, (route: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const go = useCallback((next: Route, replace = false) => {
    const hash = routeHash(next);
    if (replace) window.history.replaceState(null, "", hash);
    else window.history.pushState(null, "", hash);
    setRoute(next);
  }, []);

  return [route, go];
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return undefined;
    const sync = () => setMatches(list.matches);
    sync();
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

export type Theme = "day" | "night";

const THEME_KEY = "mathkeel.theme";

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "day" || value === "night" ? value : null;
  } catch {
    return null;
  }
}

export function useTheme(): [Theme, () => void] {
  const prefersNight = useMediaQuery("(prefers-color-scheme: dark)");
  const [chosen, setChosen] = useState<Theme | null>(storedTheme);
  const theme: Theme = chosen ?? (prefersNight ? "night" : "day");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    const next: Theme = theme === "day" ? "night" : "day";
    setChosen(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // The choice simply lasts for this page.
    }
  }, [theme]);

  return [theme, toggle];
}

/** A clock for relative times; offline snapshots stay at their generation time. */
export function useNow(live: boolean, generatedAt: string): number {
  const [now, setNow] = useState(() => (live ? Date.now() : Date.parse(generatedAt)));
  useEffect(() => {
    if (!live) {
      setNow(Date.parse(generatedAt));
      return undefined;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [live, generatedAt]);
  return now;
}
