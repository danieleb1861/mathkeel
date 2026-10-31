import { useEffect, useRef, useState } from "react";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable: fall through to the selection route.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let done = false;
  try {
    done = document.execCommand("copy");
  } catch {
    done = false;
  }
  field.remove();
  return done;
}

type CopyState = "idle" | "copied" | "failed";

export function CopyCommand({ command, label }: { command: string; label: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const codeRef = useRef<HTMLElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const done = await writeClipboard(command);
    setState(done ? "copied" : "failed");
    if (!done && codeRef.current) {
      const range = document.createRange();
      range.selectNodeContents(codeRef.current);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2400);
  };

  return (
    <div className="command">
      <code className="command__text" ref={codeRef}>
        <span className="command__prompt" aria-hidden="true">
          ${" "}
        </span>
        {command}
      </code>
      <button type="button" className="command__copy" onClick={copy} aria-label={label}>
        {state === "copied" ? "Copied" : "Copy"}
      </button>
      <span className="sr-only" role="status">
        {state === "copied" ? "Command copied." : ""}
        {state === "failed" ? "Copying is blocked here. The command is selected: press Ctrl+C." : ""}
      </span>
      {state === "failed" && <p className="command__note">Copying is blocked here. The command is selected.</p>}
    </div>
  );
}
