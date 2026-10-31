import ELK from "elkjs/lib/elk-api.js";
import workerSource from "elkjs/lib/elk-worker.min.js?raw";
import type { ElkInput, ElkOutput, ElkRun } from "../model/layout";

/**
 * ELK runs in a worker built from a Blob, so one file can carry it and layout
 * of a large map does not freeze the page. If a browser refuses Blob workers,
 * for example on some file:// setups, the same source runs on the main thread.
 */

interface FakeWorkerModule {
  exports: { Worker?: new (url?: string) => Worker };
}

function mainThreadWorker(): Worker {
  const slot = "__mathkeelElkModule";
  const scope = window as unknown as Record<string, FakeWorkerModule | undefined>;
  const module: FakeWorkerModule = { exports: {} };
  scope[slot] = module;
  const script = document.createElement("script");
  script.textContent = `(function(module,exports){${workerSource}\n})(window.${slot},window.${slot}.exports);`;
  document.head.appendChild(script);
  script.remove();
  delete scope[slot];
  const FakeWorker = module.exports.Worker;
  if (!FakeWorker) throw new Error("The layout engine could not start.");
  return new FakeWorker();
}

function blobWorker(): Worker {
  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}

function factory(): Worker {
  try {
    return blobWorker();
  } catch {
    return mainThreadWorker();
  }
}

let engine: InstanceType<typeof ELK> | null = null;

export const runElk: ElkRun = async (graph: ElkInput) => {
  engine ??= new ELK({ workerUrl: "", workerFactory: factory });
  return (await engine.layout(graph as never)) as unknown as ElkOutput;
};
