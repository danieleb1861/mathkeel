import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { findUiDir } from "./export.js";
import { tryGit } from "./repo.js";
import { buildSnapshot } from "./snapshot.js";
import { storedResultsStamp } from "./state.js";
import type { Snapshot } from "./types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

const POLL_MS = 2000;
const DEBOUNCE_MS = 250;
const HEARTBEAT_MS = 25000;

export interface ServerOptions {
  root: string;
  port?: number;
  /** Directory of the built UI; defaults to the bundled or workspace one. */
  uiDir?: string | null;
  pollMs?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** A path inside the UI directory, or null. Nothing outside it is ever served. */
export function resolveStaticPath(uiDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = decoded.split("/").filter((p) => p !== "");
  if (parts.includes("..") || parts.some((p) => p.startsWith("."))) return null;
  const full = path.resolve(uiDir, ...parts);
  const inside = path.relative(uiDir, full);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return null;
  if (!existsSync(full)) return null;
  const real = realpathSync(full);
  const realInside = path.relative(uiDir, real);
  if (realInside.startsWith("..") || path.isAbsolute(realInside)) return null;
  return statSync(real).isFile() ? real : null;
}

function sameToken(given: string | null | undefined, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === name) return value ?? null;
  }
  return null;
}

/** Allows only the inline scripts actually in the page, by hash. */
function pagePolicy(html: string): string {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc=/i.test(match[1] ?? "")) continue;
    hashes.push(`'sha256-${createHash("sha256").update(match[2] ?? "", "utf8").digest("base64")}'`);
  }
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    "connect-src 'self'",
    "worker-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

const NOT_BUILT = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>mathkeel</title>
<style>body{font:16px/1.5 Georgia,serif;margin:3rem auto;max-width:40rem;padding:0 1rem;background:#fbf8f1;color:#1d2a33}
@media (prefers-color-scheme:dark){body{background:#14202a;color:#e8e2d4}}</style></head>
<body><h1>mathkeel</h1><p>The UI is not built. Run <code>npm run build</code> in <code>packages/ui</code>,
then start <code>mathkeel serve</code> again. The engine is running: <code>GET /api/snapshot</code> answers with this token.</p></body>
</html>
`;

function shouldIgnore(file: string | null): boolean {
  if (file === null) return false;
  const rel = file.replace(/\\/g, "/");
  return /(^|\/)(\.git|node_modules|__pycache__|target|\.venv)(\/|$)/.test(rel) || rel.startsWith(".mathkeel/state");
}

/** The content of a snapshot apart from the time it was generated. */
function digest(snapshot: Snapshot): string {
  return JSON.stringify({ ...snapshot, generatedAt: "" });
}

/**
 * The local read-only server. It answers only on 127.0.0.1, only with the token,
 * and runs no contract: `buildSnapshot` reads the stored result of the last check.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { root } = options;
  const uiDir = options.uiDir === undefined ? findUiDir() : options.uiDir;
  const token = randomBytes(24).toString("hex");
  const clients = new Set<http.ServerResponse>();
  let port = 0;
  let cached: Promise<Snapshot> | null = null;
  let lastDigest: string | null = null;

  const snapshot = (): Promise<Snapshot> => {
    cached ??= buildSnapshot(root, { useLastCheck: true }).catch((error: unknown) => {
      cached = null;
      throw error;
    });
    return cached;
  };

  const baseHeaders = (): Record<string, string> => ({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });

  const refuse = (res: http.ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { ...baseHeaders(), "Content-Type": "text/plain; charset=utf-8" });
    res.end(`${message}\n`);
  };

  const cookieName = (): string => `mathkeel_token_${port}`;

  const isLocalAddress = (value: string): boolean =>
    value === `127.0.0.1:${port}` || value === `localhost:${port}`;

  const serveStatic = (res: http.ServerResponse, pathname: string, setCookie: boolean, head: boolean): void => {
    const headers: Record<string, string> = baseHeaders();
    if (setCookie) headers["Set-Cookie"] = `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`;
    if (uiDir === null) {
      res.writeHead(200, { ...headers, "Content-Type": MIME[".html"] as string });
      res.end(head ? undefined : NOT_BUILT);
      return;
    }
    const wantsPage = pathname === "/" || path.extname(pathname) === "";
    const file = wantsPage ? path.join(uiDir, "index.html") : resolveStaticPath(uiDir, pathname);
    if (file === null) {
      refuse(res, 404, "not found");
      return;
    }
    const body = readFileSync(file);
    if (wantsPage) headers["Content-Security-Policy"] = pagePolicy(body.toString("utf8"));
    res.writeHead(200, {
      ...headers,
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    });
    res.end(head ? undefined : body);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const host = req.headers.host ?? "";
      if (!isLocalAddress(host)) return refuse(res, 403, "wrong host");
      const origin = req.headers.origin;
      if (origin !== undefined && !isLocalAddress(origin.replace(/^http:\/\//, ""))) {
        return refuse(res, 403, "wrong origin");
      }
      if (req.method !== "GET" && req.method !== "HEAD") return refuse(res, 405, "read-only");

      const url = new URL(req.url ?? "/", `http://${host}`);
      const fromQuery = url.searchParams.get("token");
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const fromCookie = cookieValue(req.headers.cookie, cookieName());
      const queryOk = sameToken(fromQuery, token);
      if (!queryOk && !sameToken(bearer, token) && !sameToken(fromCookie, token)) {
        return refuse(res, 401, "token required: use the link mathkeel serve printed");
      }

      if (url.pathname === "/api/snapshot") {
        const body = JSON.stringify(await snapshot());
        res.writeHead(200, { ...baseHeaders(), "Content-Type": MIME[".json"] as string });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      if (url.pathname === "/api/events") {
        res.writeHead(200, {
          ...baseHeaders(),
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive",
        });
        res.write("retry: 3000\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname.startsWith("/api/")) return refuse(res, 404, "not found");
      return serveStatic(res, url.pathname, queryOk, req.method === "HEAD");
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) refuse(res, 500, message);
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;

  const broadcast = (generatedAt: string): void => {
    const frame = `event: change\ndata: ${JSON.stringify({ generatedAt })}\n\n`;
    for (const client of clients) client.write(frame);
  };

  let debounce: NodeJS.Timeout | null = null;
  const schedule = (): void => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      cached = null;
      snapshot()
        .then((next) => {
          const nextDigest = digest(next);
          if (nextDigest !== lastDigest) {
            const first = lastDigest === null;
            lastDigest = nextDigest;
            if (!first) broadcast(next.generatedAt);
          }
        })
        .catch(() => undefined);
    }, DEBOUNCE_MS);
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(root, { recursive: true }, (_event, file) => {
      if (!shouldIgnore(file === null ? null : String(file))) schedule();
    });
    watcher.on("error", () => undefined);
  } catch {
    // Polling below still notices every change git can see.
  }

  const repoState = (): string => {
    const head = tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"]) ?? "";
    return head + storedResultsStamp(root) + (tryGit(root, ["status", "--porcelain=v1"]) ?? "");
  };
  let lastState = repoState();
  const poll = setInterval(() => {
    const state = repoState();
    if (state !== lastState) {
      lastState = state;
      schedule();
    }
  }, options.pollMs ?? POLL_MS);
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": keep-alive\n\n");
  }, HEARTBEAT_MS);
  // Known before the server is handed out, so that no later change counts as the first state.
  lastDigest = await snapshot().then(digest, () => null);

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: async () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      if (debounce !== null) clearTimeout(debounce);
      watcher?.close();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
