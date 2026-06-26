/**
 * Unit tests for SessionTrace grouping: whitespace-only prompt/say turns are
 * dropped so they do not render empty message bubbles.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionTrace, type SessionTraceItem } from "../session-trace";

afterEach(() => {
  cleanup();
});

const actor = {
  name: "LD",
  sessionId: "s1",
  human: "LD",
  color: "#000",
};

const agentActor = {
  name: "claude-opus-4-8",
  sessionId: "s1",
  human: null,
  color: "var(--primary)",
};

function promptItem(row: number, text: string): SessionTraceItem {
  return {
    type: "prompt",
    _row: row,
    t: "00:00",
    tMs: row,
    cum: 0,
    actor,
    text,
  };
}

function sayItem(
  row: number,
  text: string,
  extra: Partial<Extract<SessionTraceItem, { type: "say" }>> = {}
): SessionTraceItem {
  return {
    type: "say",
    _row: row,
    t: "00:00",
    tMs: row,
    cum: 0,
    actor: agentActor,
    text,
    ...extra,
  };
}

const CLOCK_RE = /^\d{1,2}(:\d{2})?(am|pm)$/;

function eventItem(row: number, t: string): SessionTraceItem {
  return {
    type: "event",
    _row: row,
    t,
    tMs: Date.parse(t),
    dot: "b",
    text: "Stop",
  };
}

function toolsItem(
  row: number,
  toolRows: Array<{ label: string; detail: string; err: boolean }>
): SessionTraceItem {
  return {
    type: "tools",
    _row: row,
    t: "00:00",
    tMs: row,
    endMs: row,
    cum: 0,
    actor: agentActor,
    summary: `Ran ${toolRows.length} tools`,
    items: toolRows,
    hasFail: false,
    failN: 0,
    cats: {},
  };
}

describe("SessionTrace", () => {
  it("renders event timestamps as a friendly clock, not a raw ISO string", () => {
    const iso = "2026-06-23T20:13:34.761Z";
    const { container } = render(<SessionTrace items={[eventItem(1, iso)]} />);

    const time = container.querySelector(".st-time");
    expect(time).not.toBeNull();
    // The raw ISO string must not leak into the timeline gutter.
    expect(time?.textContent).not.toContain(iso);
    expect(time?.textContent).not.toContain("T");
    // It should render as a clock like "3:13pm" / "8pm".
    expect(time?.textContent).toMatch(CLOCK_RE);
  });

  it("leaves an already-formatted event timestamp untouched", () => {
    const { container } = render(
      <SessionTrace items={[eventItem(1, "00:00")]} />
    );

    const time = container.querySelector(".st-time");
    expect(time?.textContent).toBe("00:00");
  });

  it("renders a bubble for a prompt with text", () => {
    const { container } = render(
      <SessionTrace items={[promptItem(1, "hello world")]} />
    );

    expect(container.querySelectorAll(".st-bubble")).toHaveLength(1);
    expect(container.textContent).toContain("hello world");
  });

  it("drops a whitespace-only prompt turn (no empty bubble)", () => {
    const { container } = render(
      <SessionTrace items={[promptItem(1, "   \n  ")]} />
    );

    expect(container.querySelectorAll(".st-bubble")).toHaveLength(0);
  });

  it("keeps non-blank turns when a blank turn is interleaved", () => {
    const { container } = render(
      <SessionTrace
        items={[promptItem(1, "   "), promptItem(2, "real content")]}
      />
    );

    expect(container.querySelectorAll(".st-bubble")).toHaveLength(1);
    expect(container.textContent).toContain("real content");
  });

  it("renders reasoning as its own dimmed bubble, separate from the response", () => {
    const { container } = render(
      <SessionTrace
        items={[
          sayItem(1, "Let me weigh the options.", { isThinking: true }),
          sayItem(2, "The branch is orphaned.", { model: "claude-opus-4-8" }),
        ]}
      />
    );

    const reason = container.querySelector(".st-reason");
    expect(reason).not.toBeNull();
    expect(reason?.textContent).toContain("Reasoning");
    expect(reason?.textContent).toContain("Let me weigh the options.");
    // Reasoning is a distinct bubble, not coalesced with the response bubble.
    expect(container.querySelectorAll(".st-bubble")).toHaveLength(2);
    expect(container.textContent).toContain("The branch is orphaned.");
  });

  it("drops redacted (empty) reasoning markers", () => {
    const { container } = render(
      <SessionTrace items={[sayItem(1, "   ", { isThinking: true })]} />
    );

    expect(container.querySelectorAll(".st-reason")).toHaveLength(0);
    expect(container.querySelectorAll(".st-bubble")).toHaveLength(0);
  });

  it("drops a text-less say turn instead of showing the model name as body", () => {
    const { container } = render(
      <SessionTrace items={[sayItem(1, "", { model: "claude-opus-4-8" })]} />
    );

    expect(container.querySelectorAll(".st-bubble")).toHaveLength(0);
    expect(container.textContent).not.toContain("claude-opus-4-8");
  });

  it("renders an expandable tools card when per-tool rows are present", () => {
    const { container } = render(
      <SessionTrace
        items={[toolsItem(1, [{ label: "Read", detail: "a.ts", err: false }])]}
      />
    );

    const head = container.querySelector(".st-tools-head");
    expect(head?.tagName).toBe("BUTTON");
    expect(head?.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders a static (non-expandable) tools card when there are no rows", () => {
    const { container } = render(<SessionTrace items={[toolsItem(1, [])]} />);

    // No interactive button / aria-expanded, and no chevron that opens to nothing.
    expect(container.querySelector("button.st-tools-head")).toBeNull();
    const head = container.querySelector(".st-tools-head-static");
    expect(head).not.toBeNull();
    expect(head?.querySelector(".st-tools-chev")).toBeNull();
  });

  it("shows the model as a muted caption on the assistant bubble", () => {
    const { container } = render(
      <SessionTrace
        items={[
          sayItem(1, "Here is the answer.", { model: "claude-opus-4-8" }),
        ]}
      />
    );

    const caption = container.querySelector(".st-model");
    expect(caption?.textContent).toBe("claude-opus-4-8");
  });
});
