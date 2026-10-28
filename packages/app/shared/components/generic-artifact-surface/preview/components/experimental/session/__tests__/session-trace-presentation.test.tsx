import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTrace, type TraceCommentAnchor } from "../session-trace";
import {
  buildTestSessionDetail,
  buildTurn,
  TEST_OWNER_NAME,
} from "./support/session-detail-builders";

const HUMAN_NAME = "Ana Lee";
const ACTIVE_RING = "ring-1";
const HIGHLIGHT_ANCHOR: TraceCommentAnchor = {
  anchorPreview: "Please",
  id: "c1",
  traceRow: 0,
};

const detail = buildTestSessionDetail({
  trace: [
    buildTurn({
      actorName: HUMAN_NAME,
      blocks: [
        {
          spans: ["Please fix ", { pr: 42 }, " value is undefined"],
          type: "p",
        },
      ],
      id: "human",
      side: "human",
    }),
    buildTurn({ id: "agent" }),
    buildTurn({ durationLabel: "20m", id: "idle", kind: "idle" }),
  ],
});

afterEach(() => {
  vi.useRealTimers();
});

function renderTrace(props: Partial<Parameters<typeof SessionTrace>[0]> = {}) {
  return render(
    <SessionTrace
      activeTraceRow={-1}
      detail={detail}
      onActiveTraceRowChange={vi.fn()}
      {...props}
    />
  );
}

function row(index: number): HTMLElement {
  const element = document.getElementById(`session-trace-row-${index}`);
  if (!element) {
    throw new Error(`trace row ${index} missing`);
  }
  return element;
}

function bubble(index: number): HTMLElement {
  const element = row(index).firstElementChild;
  if (!(element instanceof HTMLElement)) {
    throw new Error(`bubble ${index} missing`);
  }
  return element;
}

function highlightedMarks(): string[] {
  return [
    ...document.querySelectorAll("mark[data-scroll-highlight='true']"),
  ].map((mark) => mark.textContent ?? "");
}

describe("SessionTrace actor presentation", () => {
  it("tints a human bubble with the actor color and an agent bubble with a light card mix", () => {
    renderTrace();

    expect(bubble(0).style.background).toBe(
      "color-mix(in oklch, var(--chart-1) 62%, var(--background))"
    );
    expect(bubble(1).style.background).toBe(
      "color-mix(in oklch, var(--chart-5) 8%, var(--card))"
    );
  });

  it("keeps the shared avatar colours on the fallback, not the actor's tones", () => {
    renderTrace();
    const fallback = row(1).querySelector<HTMLElement>(
      "[data-slot='avatar-fallback']"
    );

    // The shared avatar colours (Nerys, 2026-10-22): the actor's colour stays
    // on its bubble (above) and legend, not its avatar.
    expect(fallback).toHaveClass("bg-avatar-placeholder");
    expect(fallback?.style.background).toBe("");
    expect(fallback?.style.color).toBe("");
  });

  it("titles avatars by speaker and aligns human turns right, agent turns left", () => {
    renderTrace();

    expect(screen.getByLabelText(HUMAN_NAME)).toHaveAttribute(
      "title",
      HUMAN_NAME
    );
    expect(
      screen.getByLabelText(`Agent for ${TEST_OWNER_NAME}`)
    ).toHaveAttribute("title", `Agent for ${TEST_OWNER_NAME}`);
    expect(row(0)).toHaveClass("justify-end");
    expect(row(0)).not.toHaveClass("justify-start");
    expect(row(1)).toHaveClass("justify-start");
    expect(row(1)).not.toHaveClass("justify-end");
  });

  it("rings only the active message bubble", () => {
    renderTrace({ activeTraceRow: 1 });

    expect(bubble(1)).toHaveClass(ACTIVE_RING);
    expect(bubble(0)).not.toHaveClass(ACTIVE_RING);
    expect(bubble(2)).not.toHaveClass(ACTIVE_RING);
  });

  it("rings only the active idle gap", () => {
    renderTrace({ activeTraceRow: 2 });

    expect(bubble(2)).toHaveClass(ACTIVE_RING);
    expect(bubble(1)).not.toHaveClass(ACTIVE_RING);
  });

  it("renders a PR reference as a link-colored span, not code", () => {
    renderTrace();

    expect(screen.getByText("#42").closest("code")).toBeNull();
  });
});

describe("SessionTrace anchor edge cases", () => {
  it("skips an anchor without a preview even when the text says undefined", () => {
    renderTrace({ commentAnchors: [{ id: "bare", traceRow: 0 }] });

    expect(row(0)).toHaveTextContent("Please fix #42 value is undefined");
    expect(row(0).querySelectorAll("mark")).toHaveLength(0);
  });

  it("restarts the highlight timer when the same anchor is requested again", () => {
    vi.useFakeTimers();
    const view = renderTrace({
      activeCommentAnchorId: HIGHLIGHT_ANCHOR.id,
      activeCommentAnchorNonce: 1,
      commentAnchors: [HIGHLIGHT_ANCHOR],
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    view.rerender(
      <SessionTrace
        activeCommentAnchorId={HIGHLIGHT_ANCHOR.id}
        activeCommentAnchorNonce={2}
        activeTraceRow={-1}
        commentAnchors={[HIGHLIGHT_ANCHOR]}
        detail={detail}
        onActiveTraceRowChange={vi.fn()}
      />
    );

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(highlightedMarks()).toEqual(["Please"]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(highlightedMarks()).toEqual([]);
  });
});
