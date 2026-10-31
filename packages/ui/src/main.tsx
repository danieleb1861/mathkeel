import "@xyflow/react/dist/base.css";
import "katex/dist/katex.min.css";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/frame.css";
import "./styles/chart.css";
import "./styles/inbox.css";
import "./styles/inspector.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
