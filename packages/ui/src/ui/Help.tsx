import { useEffect, useRef } from "react";

const KEYS: readonly { keys: string[]; what: string }[] = [
  { keys: ["g", "c"], what: "Go to Chain" },
  { keys: ["g", "i"], what: "Go to Inbox" },
  { keys: ["g", "n"], what: "Go to Inspector for the current node" },
  { keys: ["/"], what: "Search the map" },
  { keys: ["←", "→"], what: "Follow the chain: upstream, downstream" },
  { keys: ["↑", "↓"], what: "Move within a column or list" },
  { keys: ["Enter"], what: "Open the Inspector" },
  { keys: ["[", "]"], what: "Previous or next item in the Inbox" },
  { keys: ["+", "-", "0"], what: "Zoom the chart, or fit it" },
  { keys: ["t"], what: "Switch between day and night chart" },
  { keys: ["Esc"], what: "Close, or go back" },
];

export function Help({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="help" role="dialog" aria-modal="true" aria-labelledby="mk-help-title">
        <header className="help__head">
          <h2 id="mk-help-title">Keys</h2>
          <button ref={closeRef} type="button" className="plain-button" onClick={onClose}>
            Close
          </button>
        </header>
        <dl className="help__list">
          {KEYS.map(({ keys, what }) => (
            <div key={what} className="help__row">
              <dt>
                {keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <p className="help__note">
          This page reads a snapshot and changes nothing. Decisions happen in your terminal, with{" "}
          <code>mathkeel accept</code>.
        </p>
      </div>
    </div>
  );
}
