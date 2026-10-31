import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The built UI next to the bundle, or in the workspace. */
export function findUiDir(): string | null {
  for (const dir of [path.join(here, "ui"), path.join(here, "..", "..", "ui", "dist")]) {
    if (existsSync(path.join(dir, "index.html"))) return realpathSync(dir);
  }
  return null;
}

/** JSON that cannot end the `<script>` element holding it. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function assetInside(uiDir: string, href: string): string | null {
  const clean = href.split(/[?#]/)[0] ?? "";
  if (/^[a-z]+:/i.test(clean) || clean.startsWith("//")) return null;
  const full = path.resolve(uiDir, clean.replace(/^\.?\//, ""));
  const relative = path.relative(uiDir, full);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(full)) return null;
  return full;
}

const DATA_TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function inlineCss(css: string, cssFile: string, uiDir: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _quote: string, ref: string) => {
    if (ref.startsWith("data:") || ref.startsWith("#")) return whole;
    const full = path.resolve(path.dirname(cssFile), ref.split(/[?#]/)[0] ?? "");
    const relative = path.relative(uiDir, full);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(full)) return whole;
    const type = DATA_TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream";
    return `url(data:${type};base64,${readFileSync(full).toString("base64")})`;
  });
}

/** Folds separately emitted scripts and stylesheets into the page. A single-file build passes through. */
function inlineAssets(html: string, uiDir: string): string {
  return html
    .replace(/<link\b[^>]*rel=["']modulepreload["'][^>]*>\s*/gi, "")
    .replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      const file = href === undefined ? null : assetInside(uiDir, href);
      if (file === null) return tag;
      const css = inlineCss(readFileSync(file, "utf8"), file, uiDir).replace(/<\/style/gi, "<\\/style");
      return `<style>${css}</style>`;
    })
    .replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi, (tag, before: string, src: string, after: string) => {
      const file = assetInside(uiDir, src);
      if (file === null) return tag;
      const js = readFileSync(file, "utf8").replace(/<\/script/gi, "<\\/script");
      const attributes = `${before}${after}`.replace(/\bcrossorigin\b(=["'][^"']*["'])?/gi, "");
      return `<script${attributes}>${js}</script>`;
    });
}

function insertSnapshot(html: string, snapshot: Snapshot): string {
  const tag = `<script>window.__MATHKEEL_SNAPSHOT__=${inlineJson(snapshot)};</script>`;
  const firstScript = html.search(/<script\b/i);
  const at = firstScript !== -1 ? firstScript : html.search(/<\/head>/i);
  return at === -1 ? `${tag}${html}` : `${html.slice(0, at)}${tag}${html.slice(at)}`;
}

function plainReport(snapshot: Snapshot): string {
  const s = snapshot.summary;
  const rows = snapshot.nodes
    .map(
      (n) =>
        `<tr><td>${escapeHtml(n.class)}</td><td><code>${escapeHtml(n.id)}</code></td>` +
        `<td>${escapeHtml(n.title)}</td><td>${escapeHtml(n.reasons.join("; "))}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mathkeel snapshot</title>
<style>
body{font:16px/1.5 Georgia,serif;margin:0 auto;max-width:60rem;padding:1rem;background:#fbf8f1;color:#1d2a33}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #b9b2a3;padding:.3rem .5rem;text-align:left;vertical-align:top}
@media (prefers-color-scheme:dark){body{background:#14202a;color:#e8e2d4}td,th{border-color:#44525e}}
</style>
</head>
<body>
<h1>mathkeel snapshot</h1>
<p>${escapeHtml(snapshot.repo.name)} at ${escapeHtml(snapshot.repo.head.slice(0, 12))}, ${escapeHtml(snapshot.generatedAt)}.
The UI was not built, so this is the plain report.</p>
<p>fresh ${s.fresh}, queue ${s.queue}, alert ${s.alert}, review ${s.review}, gaps ${s.gaps}.</p>
<table><thead><tr><th>class</th><th>node</th><th>title</th><th>reasons</th></tr></thead><tbody>${rows}</tbody></table>
</body>
</html>
`;
}

/** One offline HTML file: the UI, when built, with the snapshot inlined. */
export function renderExport(snapshot: Snapshot, uiDir: string | null): string {
  if (uiDir === null) return plainReport(snapshot);
  return insertSnapshot(inlineAssets(readFileSync(path.join(uiDir, "index.html"), "utf8"), uiDir), snapshot);
}
