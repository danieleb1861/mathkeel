import { type RefObject, useEffect, useMemo, useRef } from "react";
import { type FormulaEntry, formulaSheet } from "../model/formulas";
import { classLabel, kindLabel, statusLabel } from "../model/language";
import type { Snapshot } from "../snapshot";
import { ClassMark } from "../ui/Marks";
import { Tex } from "../ui/Tex";
import type { ViewKeys } from "./ChainView";

function Formula({ entry, selected }: { entry: FormulaEntry; selected: boolean }) {
  const { node, number } = entry;
  const doc = node.anchors.find((anchor) => anchor.kind === "doc");
  return (
    <li className="formula" data-cls={node.class}>
      <a
        className="formula__head"
        href={`#/node/${encodeURIComponent(node.id)}`}
        data-row
        data-selected={selected || undefined}
      >
        <ClassMark cls={node.class} size={18} />
        <span className="formula__title">{node.title}</span>
        <span className="formula__sub">
          {kindLabel(node.kind)} · {classLabel(node.class)} · {statusLabel(node.status, node.pinned_to_code)}
        </span>
      </a>
      <div className="formula__line">
        {node.latex ? (
          <div className="formula__tex" tabIndex={0} role="group" aria-label={`Formula of ${node.title}`}>
            <Tex latex={node.latex} display />
          </div>
        ) : (
          <p className="formula__none">The map records no formula for this statement.</p>
        )}
        <span className="formula__number">({number})</span>
      </div>
      {doc && (
        <p className="formula__source">
          {doc.path}
          {doc.line ? `:${doc.line}` : ""}
        </p>
      )}
    </li>
  );
}

/**
 * The formulas of the map in reading order, each after what it depends on. They
 * are the map's own record: reading them here checks nothing.
 */
export function FormulaSheet({
  snapshot,
  selected,
  keysRef,
}: {
  snapshot: Snapshot;
  selected: string | null;
  keysRef: RefObject<ViewKeys | null>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const sheet = useMemo(() => formulaSheet(snapshot), [snapshot]);

  useEffect(() => {
    keysRef.current = (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
      const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
      const index = rows.indexOf(document.activeElement as HTMLElement);
      const next = rows[Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1))];
      next?.focus();
      return true;
    };
    return () => {
      keysRef.current = null;
    };
  }, [keysRef]);

  return (
    <div className="passage formulas" ref={root} id="main-focus" tabIndex={-1}>
      <p className="formulas__note">
        {sheet.total === 0
          ? "This map has no equation, lemma or theorem yet."
          : `${sheet.withFormula} of ${sheet.total} statements have a formula in the map. Formulas are the map's own record; only contracts check the code.`}
      </p>
      {sheet.groups.map((group) => (
        <section key={group.id} className="passage__chain">
          <h2 className="passage__title">{group.title}</h2>
          <ol className="formulas__list">
            {group.entries.map((entry) => (
              <Formula key={entry.node.id} entry={entry} selected={entry.node.id === selected} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
