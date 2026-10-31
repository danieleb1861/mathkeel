import "@xyflow/react/dist/base.css";
import "katex/dist/katex.min.css";
import "../styles/fonts.css";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/frame.css";
import "../styles/chart.css";
import "../styles/inbox.css";
import "../styles/inspector.css";
import "./preview.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import demo from "../../fixtures/demo.snapshot.json";
import { STATE_NAMES, stateFor } from "../../fixtures/states.mjs";
import { App } from "../App";

/**
 * Preview harness, dev only: `npm run preview:states`. Each state is a page
 * load, so the real boot path runs. The screenshot scripts use the same states.
 */

const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "demo";

if (state === "bad-schema") {
  window.__MATHKEEL_SNAPSHOT__ = { ...demo, schema: 2 };
} else if (state !== "no-engine") {
  window.__MATHKEEL_SNAPSHOT__ = stateFor(state, demo);
}

function Switcher() {
  return (
    <nav className="harness" aria-label="Preview states">
      <span>Preview</span>
      {[...STATE_NAMES, "bad-schema", "no-engine"].map((name) => (
        <a key={name} href={`?state=${name}`} aria-current={name === state ? "page" : undefined}>
          {name}
        </a>
      ))}
    </nav>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <div className="harness-frame">
        <Switcher />
        <div className="harness-app">
          <App />
        </div>
      </div>
    </StrictMode>,
  );
}
