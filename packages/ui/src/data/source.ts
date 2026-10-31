import { parseSnapshot, SnapshotError } from "../model/parse";
import type { Snapshot } from "../snapshot";

declare global {
  interface Window {
    __MATHKEEL_SNAPSHOT__?: unknown;
  }
}

export type LinkState = "offline" | "connecting" | "live" | "lost";

export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessError";
  }
}

export function urlToken(location: Pick<Location, "search" | "hash"> = window.location): string | null {
  const fromQuery = new URLSearchParams(location.search).get("token");
  if (fromQuery) return fromQuery;
  const match = /[#&?]token=([^&]+)/.exec(location.hash);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function withToken(path: string, token: string | null): string {
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

export function inlinedSnapshot(): Snapshot | null {
  const inlined = window.__MATHKEEL_SNAPSHOT__;
  return inlined === undefined ? null : parseSnapshot(inlined);
}

export async function fetchSnapshot(token: string | null): Promise<Snapshot> {
  let response: Response;
  try {
    response = await fetch(withToken("/api/snapshot", token), {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new SnapshotError(
      "The engine is not reachable.",
      "Start it again with `mathkeel serve` and open the link it prints.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new AccessError(
      token
        ? "This link's token was not accepted. `mathkeel serve` prints a new link each time it starts."
        : "This page needs the full link printed by `mathkeel serve`, including its token.",
    );
  }
  if (!response.ok) {
    throw new SnapshotError(
      "The engine answered with an error.",
      `GET /api/snapshot returned ${response.status}.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SnapshotError("The snapshot could not be read.", "The engine did not return JSON.");
  }
  return parseSnapshot(body);
}

/**
 * Follows the engine's event stream. Any event means the snapshot may have
 * changed; if it carries a whole snapshot that one is used, otherwise the
 * snapshot is fetched again. EventSource reconnects by itself.
 */
export function subscribe(
  token: string | null,
  onSnapshot: (snapshot: Snapshot) => void,
  onLink: (state: LinkState) => void,
): () => void {
  if (typeof EventSource === "undefined") {
    onLink("lost");
    return () => undefined;
  }
  const source = new EventSource(withToken("/api/events", token));
  let closed = false;

  const refresh = (event: MessageEvent<string>) => {
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (typeof parsed === "object" && parsed !== null && "schema" in parsed) {
        onSnapshot(parseSnapshot(parsed));
        return;
      }
    } catch {
      // A bare ping or a non-JSON payload: fetch instead.
    }
    fetchSnapshot(token)
      .then((snapshot) => {
        if (!closed) onSnapshot(snapshot);
      })
      .catch(() => {
        if (!closed) onLink("lost");
      });
  };

  source.onopen = () => onLink("live");
  source.onerror = () => onLink("lost");
  source.onmessage = refresh;
  source.addEventListener("snapshot", refresh as EventListener);
  source.addEventListener("change", refresh as EventListener);

  return () => {
    closed = true;
    source.close();
  };
}
