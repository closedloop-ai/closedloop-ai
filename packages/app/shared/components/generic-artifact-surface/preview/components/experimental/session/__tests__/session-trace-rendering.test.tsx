import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../mock-detail";
import { SessionTrace, type TraceCommentAnchor } from "../session-trace";
import {
  buildTestSessionDetail,
  buildTurn,
  TEST_OWNER_NAME,
} from "./support/session-detail-builders";

/** One initial on every avatar (Nerys, 2026-10-22), and nothing else. */
const ONLY_A = /^A$/;

const TURN_MODEL = "model-a";
const TURN_DURATION = "12s";
const AGENT_AVATAR_TEXT = "AI";
const TOOL_DETAIL = "file.ts";
const HIGHLIGHT_MS = 1600;
const BARE_AGENT_TEXT = /^bareAI$/;

const traceDetail = buildTestSessionDetail({
  toolCount: 2,
  trace: [
    buildTurn({
      actorName: "Ana Lee",
      blocks: [
        {
          spans: ["Please fix ", { code: "foo()" }, " in ", { pr: 42 }],
          type: "p",
        },
      ],
      costLabel: "$0.10",
      durationLabel: TURN_DURATION,
      id: "human",
      model: TURN_MODEL,
      sentLabel: "9:00 AM",
      side: "human",
    }),
    buildTurn({
      blocks: [
        { items: [["first item"], ["second ", { code: "x" }]], type: "ul" },
        {
          rows: [{ detail: TOOL_DETAIL, label: "Read" }, { label: "Bash" }],
          summary: "Ran 2 tools",
          type: "tools",
        },
      ],
      costLabel: "$0.20",
      durationLabel: TURN_DURATION,
      id: "agent",
      model: TURN_MODEL,
      sentLabel: "9:01 AM",
    }),
    buildTurn({
      actorId: "ghost",
      durationLabel: "20m",
      id: "idle",
      kind: "idle",
      sentLabel: "9:30 AM",
    }),
    buildTurn({ id: "late", row: 7 }),
  ],
  turnCount: 3,
});

afterEach(() => {
  vi.useRealTimers();
});

function renderTrace(
  detail: SessionDetail,
  props: Partial<Parameters<typeof SessionTrace>[0]> = {}
) {
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

function markTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll("mark")].map(
    (mark) => mark.textContent ?? ""
  );
}

function highlightedMarks(): string[] {
  return [
    ...document.querySelectorAll("mark[data-scroll-highlight='true']"),
  ].map((mark) => mark.textContent ?? "");
}

describe("SessionTrace summary", () => {
  it("pluralizes turns and tool calls", () => {
    renderTrace(traceDetail);

    expect(
      screen.getByRole("heading", { name: "Session Trace" })
    ).toBeInTheDocument();
    expect(screen.getByText("3 turns · 2 tool calls")).toBeInTheDocument();
  });

  it("uses singular nouns for one turn and one tool call", () => {
    renderTrace(buildTestSessionDetail({ toolCount: 1, turnCount: 1 }));

    expect(screen.getByText("1 turn · 1 tool call")).toBeInTheDocument();
  });
});

describe("SessionTrace turns", () => {
  it("renders a human turn with the actor's initials and without agent-only metadata", () => {
    renderTrace(traceDetail);
    const human = row(0);

    // One initial on every avatar (Nerys, 2026-10-22).
    expect(within(human).getByLabelText("Ana Lee")).toHaveTextContent(ONLY_A);
    expect(within(human).getByText("9:00 AM")).toBeInTheDocument();
    expect(within(human).getByText("$0.10")).toBeInTheDocument();
    expect(within(human).queryByText(TURN_MODEL)).not.toBeInTheDocument();
    expect(within(human).queryByText(TURN_DURATION)).not.toBeInTheDocument();
    expect(
      within(human).queryByText(AGENT_AVATAR_TEXT)
    ).not.toBeInTheDocument();
    expect(within(human).getByText("foo()").closest("code")).not.toBeNull();
    expect(within(human).getByText("#42")).toBeInTheDocument();
    expect(human).toHaveTextContent("Please fix foo() in #42");
  });

  it("renders an agent turn with an AI avatar, model, duration and cost", () => {
    renderTrace(traceDetail);
    const agent = row(1);

    expect(
      within(agent).getByLabelText(`Agent for ${TEST_OWNER_NAME}`)
    ).toHaveTextContent(AGENT_AVATAR_TEXT);
    expect(within(agent).getByText(TURN_MODEL)).toBeInTheDocument();
    expect(within(agent).getByText(TURN_DURATION)).toBeInTheDocument();
    expect(within(agent).getByText("$0.20")).toBeInTheDocument();
    expect(
      within(agent)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["first item", "second x"]);
  });

  it("omits the model, sent time, duration and cost when an agent turn lacks them", () => {
    renderTrace(
      buildTestSessionDetail({
        trace: [buildTurn({ blocks: [{ spans: ["bare"], type: "p" }] })],
      })
    );
    const agent = row(0);

    expect(agent).toHaveTextContent("bare");
    expect(agent).toHaveTextContent(BARE_AGENT_TEXT);
  });

  it("renders an idle gap between contributing sessions", () => {
    renderTrace(traceDetail);

    expect(row(2)).toHaveAttribute("data-trace-kind", "idle");
    expect(row(2)).toHaveTextContent(
      "Idle between contributing sessions · started 9:30 AM · 20m"
    );
    expect(
      within(row(2)).queryByText(AGENT_AVATAR_TEXT)
    ).not.toBeInTheDocument();
  });

  it("keys rows by their explicit row number and marks the active one", () => {
    renderTrace(traceDetail, { activeTraceRow: 7 });

    expect(row(7)).toHaveAttribute("data-trace-row", "7");
    expect(document.getElementById("session-trace-row-3")).toBeNull();
    expect(row(7)).toHaveClass("opacity-100");
    expect(row(0)).toHaveClass("opacity-90");
    expect(row(2)).toHaveClass("opacity-90");
  });

  it("marks an active idle row", () => {
    renderTrace(traceDetail, { activeTraceRow: 2 });

    expect(row(2)).toHaveClass("opacity-100");
    expect(row(7)).toHaveClass("opacity-90");
  });

  it("derives a human initial from the name when explicit initials are blank", () => {
    renderTrace(
      buildTestSessionDetail({
        trace: [
          buildTurn({
            actorInitials: "",
            actorName: "mary-jane watson",
            id: "mj",
            side: "human",
          }),
          buildTurn({ actorName: " ", id: "blank", side: "human" }),
        ],
      })
    );

    // One initial on every avatar (Nerys, 2026-10-22).
    expect(within(row(0)).getByLabelText("mary-jane watson").textContent).toBe(
      "M"
    );
    const blankAvatar = row(1).querySelector("[data-slot='avatar']");
    // pins current behavior; looks odd because a whitespace-only actor name becomes the avatar's accessible name
    expect(blankAvatar).toHaveAttribute("aria-label", " ");
    expect(blankAvatar).toHaveTextContent("?");
  });
});

describe("SessionTrace tool disclosure", () => {
  it("expands and collapses the tool rows", () => {
    renderTrace(traceDetail);
    const toggle = screen.getByRole("button", { name: "Ran 2 tools" });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(TOOL_DETAIL)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText(TOOL_DETAIL)).toBeInTheDocument();
    expect(screen.getByText("Bash").nextElementSibling).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(TOOL_DETAIL)).not.toBeInTheDocument();
  });
});

describe("SessionTrace comment anchors", () => {
  const anchors: TraceCommentAnchor[] = [
    { anchorPreview: "fix foo", id: "c1", traceRow: 0 },
    { anchorPreview: "#42", id: "c2", traceRow: 0 },
    { anchorPreview: "not in the text", id: "c3", traceRow: 0 },
    { id: "c4", traceRow: 0 },
    { anchorPreview: "first item", id: "c5", traceRow: 0 },
    { anchorPreview: "first item", id: "c6", traceRow: 1 },
    { anchorPreview: "Hello", id: "c7", traceRow: 7 },
    { anchorPreview: "there", id: "c8", traceRow: 3 },
  ];

  it("highlights each anchored passage across inline spans in its own row only", () => {
    renderTrace(traceDetail, { commentAnchors: anchors });

    expect(markTexts(row(0))).toEqual(["fix ", "foo", "#42"]);
    expect(within(row(0)).getByText("foo").closest("code")).not.toBeNull();
    expect(within(row(0)).getByText("#42").tagName).toBe("MARK");
    expect(markTexts(row(1))).toEqual(["first item"]);
    expect(markTexts(row(7))).toEqual(["Hello"]);
    expect(highlightedMarks()).toEqual([]);
  });

  it("flags the requested anchor for a scroll highlight and clears it after 1.6s", () => {
    vi.useFakeTimers();
    renderTrace(traceDetail, {
      activeCommentAnchorId: "c1",
      activeCommentAnchorNonce: 1,
      commentAnchors: anchors,
    });

    expect(highlightedMarks()).toEqual(["fix ", "foo"]);
    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_MS - 1);
    });
    expect(highlightedMarks()).toEqual(["fix ", "foo"]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(highlightedMarks()).toEqual([]);
  });

  it.each([
    ["no nonce", { activeCommentAnchorId: "c1" }],
    [
      "a zero nonce",
      { activeCommentAnchorId: "c1", activeCommentAnchorNonce: 0 },
    ],
    ["no anchor id", { activeCommentAnchorNonce: 3 }],
  ])("does not highlight with %s", (_, props) => {
    renderTrace(traceDetail, { commentAnchors: anchors, ...props });

    expect(markTexts(row(0))).toEqual(["fix ", "foo", "#42"]);
    expect(highlightedMarks()).toEqual([]);
  });
});
