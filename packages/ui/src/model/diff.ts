export interface DiffPart {
  type: "same" | "removed" | "added";
  text: string;
}

const TOKENS = /\s+|[A-Za-z0-9_]+|./gu;
const CELL_LIMIT = 4_000_000;

function tokens(text: string): string[] {
  return text.match(TOKENS) ?? [];
}

function pushPart(parts: DiffPart[], type: DiffPart["type"], text: string): void {
  const last = parts[parts.length - 1];
  if (last?.type === type) last.text += text;
  else parts.push({ type, text });
}

/**
 * Word-level diff by longest common subsequence. Spans are short by contract;
 * the limit keeps a pathological span from blocking the page.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ type: "same", text: before }] : [];
  const a = tokens(before);
  const b = tokens(after);
  if ((a.length + 1) * (b.length + 1) > CELL_LIMIT) {
    return [
      { type: "removed", text: before },
      { type: "added", text: after },
    ];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const here = i * width + j;
      table[here] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pushPart(parts, "same", a[i] as string);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      pushPart(parts, "removed", a[i] as string);
      i += 1;
    } else {
      pushPart(parts, "added", b[j] as string);
      j += 1;
    }
  }
  for (; i < a.length; i += 1) pushPart(parts, "removed", a[i] as string);
  for (; j < b.length; j += 1) pushPart(parts, "added", b[j] as string);
  return parts;
}
