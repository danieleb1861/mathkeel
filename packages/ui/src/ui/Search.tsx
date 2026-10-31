import { useEffect, useMemo, useRef, useState } from "react";
import { classLabel, kindLabel } from "../model/language";
import type { SnapshotNode } from "../snapshot";
import { ClassMark } from "./Marks";

export function scoreNode(node: SnapshotNode, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const title = node.title.toLowerCase();
  const id = node.id.toLowerCase();
  if (id === needle || title === needle) return 100;
  if (title.startsWith(needle) || id.startsWith(needle)) return 80;
  if (title.includes(needle) || id.includes(needle)) return 60;
  const places = [node.doc?.path ?? "", node.doc?.symbol ?? "", ...node.code.flatMap((c) => [c.path, c.symbol ?? ""])];
  if (places.some((place) => place.toLowerCase().includes(needle))) return 40;
  if (node.doc?.quote.toLowerCase().includes(needle)) return 20;
  return 0;
}

const LIMIT = 8;

export function Search({
  nodes,
  onPick,
  onClose,
}: {
  nodes: readonly SnapshotNode[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return nodes
      .map((node) => ({ node, score: scoreNode(node, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.node.title.localeCompare(b.node.title))
      .slice(0, LIMIT)
      .map((entry) => entry.node);
  }, [nodes, query]);

  const current = results[Math.min(active, results.length - 1)];

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="search" role="dialog" aria-modal="true" aria-label="Search the map">
        <label className="search__label" htmlFor="mk-search">
          Search the map
        </label>
        <input
          id="mk-search"
          ref={input}
          className="search__input"
          type="text"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="mk-search-results"
          aria-activedescendant={current ? `mk-result-${current.id}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Title, id, file or symbol"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter" && current) {
              onPick(current.id);
            } else if (event.key === "Escape") {
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <ul id="mk-search-results" className="search__results" role="listbox" aria-label="Results">
          {results.map((node) => (
            <li
              key={node.id}
              id={`mk-result-${node.id}`}
              role="option"
              aria-selected={node === current}
              className="search__result"
              onMouseMove={() => setActive(results.indexOf(node))}
              onClick={() => onPick(node.id)}
            >
              <ClassMark cls={node.class} size={18} />
              <span className="search__title">{node.title}</span>
              <span className="search__meta">
                {kindLabel(node.kind)} · {classLabel(node.class)}
              </span>
            </li>
          ))}
        </ul>
        {query.trim() !== "" && results.length === 0 && (
          <p className="search__none">Nothing mapped matches “{query}”.</p>
        )}
        <p className="search__hint">
          <kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>Enter</kbd> inspect, <kbd>Esc</kbd> close
        </p>
      </div>
    </div>
  );
}
