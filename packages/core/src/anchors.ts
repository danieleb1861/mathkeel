import { hashText, type TextLanguage } from "./normalise.js";
import { RepoFiles } from "./repo.js";
import { analyseCode, docstringContains, type ParsedCode } from "./symbols.js";
import type { CodeLanguage } from "./treesitter.js";
import type { Anchor, AnchorState } from "./types.js";

export type AnchorKind = "doc" | "code";
export type Language = CodeLanguage | TextLanguage;

export interface ResolvedAnchor {
  state: AnchorState;
  line: number | null;
  /** Current hash; null when the anchor is lost. */
  hash: string | null;
  /** Current span; null when the anchor is lost. */
  text: string | null;
  /** Why the anchor is not fresh. */
  note: string;
}

interface Located {
  hash: string;
  text: string;
  line: number;
}

export function languageOf(path: string): Language {
  const lower = path.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".tex")) return "latex";
  return "text";
}

export function isCodeLanguage(language: Language): language is CodeLanguage {
  return language === "python" || language === "rust";
}

/** Source of parsed files for one run; parsed trees are released by `dispose`. */
export class Workspace {
  private readonly parsed = new Map<string, Promise<ParsedCode | null>>();

  constructor(readonly files: RepoFiles) {}

  code(path: string): Promise<ParsedCode | null> {
    let entry = this.parsed.get(path);
    if (entry === undefined) {
      entry = this.parse(path);
      this.parsed.set(path, entry);
    }
    return entry;
  }

  private async parse(path: string): Promise<ParsedCode | null> {
    const language = languageOf(path);
    const text = this.files.read(path);
    if (text === null || !isCodeLanguage(language)) return null;
    return analyseCode(language, text, path);
  }

  async dispose(): Promise<void> {
    for (const entry of this.parsed.values()) (await entry)?.dispose();
    this.parsed.clear();
  }
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** Every place the quote occurs, matching across any change in layout. */
function findQuote(text: string, quote: string): { start: number; end: number }[] {
  const compactQuote = quote.replace(/\s+/g, " ").trim();
  if (compactQuote === "") return [];
  const offsets: number[] = [];
  let compact = "";
  let inSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      if (!inSpace) {
        compact += " ";
        offsets.push(i);
      }
      inSpace = true;
    } else {
      compact += ch;
      offsets.push(i);
      inSpace = false;
    }
  }
  const matches: { start: number; end: number }[] = [];
  for (let at = compact.indexOf(compactQuote); at !== -1; at = compact.indexOf(compactQuote, at + 1)) {
    const start = offsets[at] as number;
    const end = (offsets[at + compactQuote.length - 1] as number) + 1;
    matches.push({ start, end });
  }
  return matches;
}

const LATEX_BLOCK_ENV =
  /\\begin\{(equation|align|gather|multline|eqnarray|split|cases|[pbvV]?matrix|theorem|lemma|proposition|corollary|definition|assumption|proof|remark)\*?\}/g;
const LATEX_BLOCK_END =
  /\\end\{(equation|align|gather|multline|eqnarray|split|cases|[pbvV]?matrix|theorem|lemma|proposition|corollary|definition|assumption|proof|remark)\*?\}/g;

/** Character ranges of paragraphs. Fences and display maths stay in one block. */
function textBlocks(text: string): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = [];
  let blockStart: number | null = null;
  let blockEnd = 0;
  let fenced = false;
  let displayMath = false;
  let envDepth = 0;
  let at = 0;
  const flush = (): void => {
    if (blockStart !== null) blocks.push({ start: blockStart, end: blockEnd });
    blockStart = null;
  };
  for (const line of text.split("\n")) {
    const lineEnd = at + line.length;
    const trimmed = line.trim();
    const wasOpen = fenced || displayMath || envDepth > 0;
    if (/^(```|~~~)/.test(trimmed)) fenced = !fenced;
    if (!fenced) {
      if ((line.match(/\$\$/g) ?? []).length % 2 === 1) displayMath = !displayMath;
      envDepth += (line.match(LATEX_BLOCK_ENV) ?? []).length - (line.match(LATEX_BLOCK_END) ?? []).length;
      envDepth = Math.max(envDepth, 0);
    }
    if (trimmed === "" && !wasOpen) {
      flush();
    } else if (/^#{1,6}\s/.test(trimmed) && !wasOpen) {
      flush();
      blocks.push({ start: at, end: lineEnd });
    } else {
      blockStart ??= at;
      blockEnd = lineEnd;
    }
    at = lineEnd + 1;
  }
  flush();
  return blocks;
}

function blockAround(text: string, match: { start: number; end: number }): { start: number; end: number } {
  const touching = textBlocks(text).filter((b) => b.start < match.end && match.start < b.end);
  const first = touching[0];
  const last = touching[touching.length - 1];
  return first === undefined || last === undefined ? match : { start: first.start, end: last.end };
}

function headingRange(text: string, title: string): { start: number; end: number } | null {
  const headings: { level: number; title: string; start: number }[] = [];
  let at = 0;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) headings.push({ level: heading[1]?.length ?? 1, title: heading[2] ?? "", start: at });
    at += line.length + 1;
  }
  const index = headings.findIndex((h) => h.title === title);
  const found = headings[index];
  if (found === undefined) return null;
  const next = headings.slice(index + 1).find((h) => h.level <= found.level);
  return { start: found.start, end: next === undefined ? text.length : next.start };
}

const LATEX_LEVELS = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph"];

function latexRange(text: string, symbol: string): { start: number; end: number } | null {
  const label = text.indexOf(`\\label{${symbol}}`);
  if (label !== -1) return blockAround(text, { start: label, end: label + symbol.length + 8 });
  const heading = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}/g;
  const entries = [...text.matchAll(heading)].map((m) => ({
    level: LATEX_LEVELS.indexOf(m[1] ?? ""),
    title: m[2] ?? "",
    start: m.index,
  }));
  const index = entries.findIndex((e) => e.title === symbol);
  const found = entries[index];
  if (found === undefined) return null;
  const next = entries.slice(index + 1).find((e) => e.level <= found.level);
  return { start: found.start, end: next === undefined ? text.length : next.start };
}

function locateText(text: string, language: TextLanguage, anchor: Anchor): Located[] {
  const ranges: { start: number; end: number }[] = [];
  if (anchor.symbol !== null) {
    const range = language === "latex" ? latexRange(text, anchor.symbol) : headingRange(text, anchor.symbol);
    if (range !== null) ranges.push(range);
  } else {
    for (const match of findQuote(text, anchor.quote)) ranges.push(blockAround(text, match));
  }
  return ranges.map(({ start, end }) => {
    const span = text.slice(start, end);
    return { hash: hashText(span, language), text: span.trim(), line: lineAt(text, start) };
  });
}

function locateCode(text: string, parsed: ParsedCode, anchor: Anchor): Located[] {
  if (anchor.symbol !== null) {
    return parsed.lookup(anchor.symbol).map((s) => ({ hash: parsed.hash(s.node), text: s.node.text, line: s.line }));
  }
  const located: Located[] = [];
  for (const match of findQuote(text, anchor.quote)) {
    const node = parsed.spanAt(match.start, match.end);
    if (node !== null) located.push({ hash: parsed.hash(node), text: node.text, line: node.startPosition.row + 1 });
  }
  return located;
}

function locateDocstring(parsed: ParsedCode, anchor: Anchor): Located[] {
  const docs =
    anchor.symbol !== null
      ? parsed.lookup(anchor.symbol).flatMap((s) => (s.doc === null ? [] : [s.doc]))
      : parsed.docstrings.filter((d) => docstringContains(d, anchor.quote));
  return docs.map((d) => ({ hash: hashText(d.text), text: d.text, line: d.line }));
}

function lost(note: string): ResolvedAnchor {
  return { state: "lost", line: null, hash: null, text: null, note };
}

/**
 * Finds an anchor by its locator, which is the symbol when it has one and the
 * quote otherwise, and compares the normalised span with the frozen hash.
 */
export async function resolveAnchor(ws: Workspace, kind: AnchorKind, anchor: Anchor): Promise<ResolvedAnchor> {
  const text = ws.files.read(anchor.path);
  if (text === null) return lost(`${anchor.path}: file gone or not readable`);
  const language = languageOf(anchor.path);

  let located: Located[];
  if (isCodeLanguage(language)) {
    const parsed = await ws.code(anchor.path);
    if (parsed === null) return lost(`${anchor.path}: file gone or not readable`);
    located = kind === "doc" ? locateDocstring(parsed, anchor) : locateCode(text, parsed, anchor);
  } else {
    located = locateText(text, language, anchor);
  }

  const name = `${anchor.path}${anchor.symbol === null ? "" : `#${anchor.symbol}`}`;
  const best = located.find((l) => l.hash === anchor.hash) ?? located[0];
  if (best === undefined) {
    return lost(anchor.symbol === null ? `${name}: quote gone` : `${name}: symbol gone`);
  }
  if (best.hash === anchor.hash) return { state: "fresh", line: best.line, hash: best.hash, text: best.text, note: "" };
  const note = anchor.hash === null ? `${name}: not frozen yet` : `${name}: changed since the baseline`;
  return { state: "queue", line: best.line, hash: best.hash, text: best.text, note };
}
