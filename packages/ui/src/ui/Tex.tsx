import katex from "katex";
import { useMemo } from "react";

/**
 * LaTeX comes from the map, so it is evidence, not trusted markup: `trust` stays
 * off, expansion is bounded, and anything KaTeX refuses is shown as source text.
 */
function render(latex: string, display: boolean): string | null {
  try {
    return katex.renderToString(latex, {
      displayMode: display,
      throwOnError: true,
      strict: "ignore",
      trust: false,
      maxExpand: 500,
      maxSize: 12,
    });
  } catch {
    return null;
  }
}

export function Tex({ latex, display = false }: { latex: string; display?: boolean }) {
  const html = useMemo(() => render(latex, display), [latex, display]);
  if (html === null) {
    return (
      <span className="tex-source">
        <code>{latex}</code>
        <span className="tex-source__note">Shown as source: this LaTeX could not be rendered.</span>
      </span>
    );
  }
  return <span className={display ? "tex tex--display" : "tex"} dangerouslySetInnerHTML={{ __html: html }} />;
}
