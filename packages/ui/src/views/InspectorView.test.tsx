// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import demo from "../../fixtures/demo.snapshot.json";
import { groupInbox } from "../model/grouping";
import { buildGraph } from "../model/trace";
import type { Snapshot } from "../snapshot";
import type { ViewKeys } from "./ChainView";
import { InboxView } from "./InboxView";
import { InspectorView } from "./InspectorView";

const snapshot = demo as unknown as Snapshot;
const graph = buildGraph(snapshot);
const inbox = groupInbox(snapshot);
const now = Date.parse(snapshot.generatedAt);

function inspect(id: string) {
  return render(
    <InspectorView
      snapshot={snapshot}
      graph={graph}
      id={id}
      inboxOrder={inbox.order}
      now={now}
      onOpen={() => undefined}
      onBack={() => undefined}
      backLabel="Inbox"
      keysRef={createRef<ViewKeys>()}
    />,
  );
}

afterEach(cleanup);

describe("InspectorView", () => {
  it("offers the exact command and has no control that decides", () => {
    inspect("dm.variance");
    expect(screen.getByText(/mathkeel accept dm\.variance --reason/)).toBeTruthy();
    const labels = screen.getAllByRole("button").map((button) => button.textContent ?? "");
    expect(labels.filter((label) => /accept|approve|reject|resolve/i.test(label))).toEqual([]);
  });

  it("shows the judge verdict as a proposal", () => {
    inspect("dm.variance");
    expect(screen.getByText("Agent proposal, not a decision")).toBeTruthy();
    expect(screen.getByText("Proposes: possible error")).toBeTruthy();
  });

  it("says matches current behaviour on a pinned node and never checked", () => {
    const { container } = inspect("dm.hln");
    const text = container.textContent ?? "";
    expect(text).toContain("Matches current behaviour");
    expect(text.toLowerCase()).not.toContain("numerically checked");
  });

  it("sets the formula beside its code, once, and says that reading checks nothing", () => {
    const { container } = inspect("dm.variance");
    const compare = container.querySelector(".compare");
    expect(compare?.querySelector(".katex")).toBeTruthy();
    expect(compare?.querySelectorAll(".span").length).toBe(1);
    expect(container.querySelectorAll(".spans__column--code").length).toBe(1);
    expect(screen.getByText(/Only a contract compares them/)).toBeTruthy();
  });

  it("keeps the formula on its own when the node has no code", () => {
    const { container } = inspect("dm.limit");
    expect(container.querySelector(".compare")).toBeNull();
    expect(container.querySelector(".equation .katex")).toBeTruthy();
    expect(screen.getByText("No code anchor on this node.")).toBeTruthy();
  });

  it("offers nothing to accept on an unchanged node", () => {
    inspect("ar.causal");
    expect(screen.getByText(/Nothing to accept/)).toBeTruthy();
    expect(screen.queryByText(/mathkeel accept ar\.causal/)).toBeNull();
  });
});

describe("InboxView", () => {
  it("renders the honest copy of the fixture, alerts first", () => {
    const { container } = render(
      <InboxView snapshot={snapshot} inbox={inbox} graph={graph} cursor={null} now={now} keysRef={createRef<ViewKeys>()} />,
    );
    const titles = [...container.querySelectorAll(".ledger__title")].map((title) => title.textContent);
    expect(titles.slice(0, 4)).toEqual(["Changed", "Proposal waiting", "Needs review", "Gaps"]);
    expect(screen.getByText(/4 causes behind 8 changed nodes/)).toBeTruthy();
  });
});
