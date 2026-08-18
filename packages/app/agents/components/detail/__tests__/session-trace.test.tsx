/**
 * Unit tests for SessionTrace grouping: whitespace-only prompt/say turns are
 * dropped so they do not render empty message bubbles.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTrace, type SessionTraceItem } from "../session-trace";
import type { TraceTextAnchor } from "../trace-comments";
import {
  COMMENT_BUTTON_NAME_RE,
  sayItem,
  selectRenderedText,
} from "./session-trace-test-helpers";

// FEA-3490: the inline composer always renders the org-member @-mention picker.
// `useOrganizationUsers` is stubbed so the picker has members to suggest/resolve.
const mockUseOrganizationUsers = vi.fn();
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: (options?: { enabled?: boolean }) =>
    mockUseOrganizationUsers(options),
}));

beforeEach(() => {
  mockUseOrganizationUsers.mockReturnValue({
    data: [
      {
        id: "u-ada",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        avatarUrl: null,
        active: true,
      },
    ],
  });
});

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
  toolRows: Extract<SessionTraceItem, { type: "tools" }>["items"]
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

  it("expands an individual tool-call row to reveal its command, output, and meta (FEA-3547)", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SessionTrace
        items={[
          toolsItem(1, [
            {
              label: "Bash",
              detail: "ls -la",
              err: false,
              input: "ls -la /tmp",
              output: "total 8\ndrwxr-xr-x",
              status: "exit 0",
              durationMs: 2500,
            },
          ]),
        ]}
      />
    );

    // Open the group card first.
    const groupHead = container.querySelector("button.st-tools-head");
    if (!groupHead) {
      throw new Error("expected an expandable group head");
    }
    await user.click(groupHead);

    // The per-call row is itself a button, collapsed by default.
    const row = container.querySelector("button.st-toolrow");
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".st-toolrow-detail")).toBeNull();

    if (!row) {
      throw new Error("expected an expandable tool-call row");
    }
    await user.click(row);

    expect(row.getAttribute("aria-expanded")).toBe("true");
    const detail = container.querySelector(".st-toolrow-detail");
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain("ls -la /tmp");
    expect(detail?.textContent).toContain("drwxr-xr-x");
    expect(detail?.textContent).toContain("exit 0");
  });

  it("expands a detail-less tool-call row to an explicit empty state (FEA-3547)", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SessionTrace
        items={[toolsItem(1, [{ label: "Read", detail: "a.ts", err: false }])]}
      />
    );

    await user.click(container.querySelector("button.st-tools-head")!);
    const row = container.querySelector("button.st-toolrow");
    if (!row) {
      throw new Error("expected an expandable tool-call row");
    }
    await user.click(row);

    expect(row.getAttribute("aria-expanded")).toBe("true");
    // No state stamped + no inline detail → the honest "not loaded" copy.
    expect(container.querySelector(".st-toolrow-empty")?.textContent).toContain(
      "isn't loaded in this view"
    );
  });

  // FEA-3696: the expanded panel must render a TRUTHFUL, state-specific message
  // rather than one ambiguous "no detail" for every empty case — and must do so
  // identically on both the session-detail and branch-merged surfaces (they
  // share this SessionTrace renderer).
  it.each([
    ["unavailable" as const, "isn't loaded in this view"],
    ["redacted" as const, "was redacted"],
    ["malformed" as const, "couldn't be read"],
  ])("renders the truthful empty panel for a %s tool call", async (detailState, expected) => {
    const user = userEvent.setup();
    const { container } = render(
      <SessionTrace
        items={[
          toolsItem(1, [
            { label: "mcp__x__y", detail: "", err: false, detailState },
          ]),
        ]}
      />
    );

    await user.click(container.querySelector("button.st-tools-head")!);
    await user.click(container.querySelector("button.st-toolrow")!);

    expect(container.querySelector(".st-toolrow-empty")?.textContent).toContain(
      expected
    );
  });

  it("renders the actual command/output for an available tool call (no empty panel)", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SessionTrace
        items={[
          toolsItem(1, [
            {
              label: "Bash",
              detail: "ls",
              err: false,
              detailState: "available",
              callId: "e-1",
              input: "ls -la /tmp",
              output: "drwxr-xr-x",
              status: "exit 0",
            },
          ]),
        ]}
      />
    );

    await user.click(container.querySelector("button.st-tools-head")!);
    await user.click(container.querySelector("button.st-toolrow")!);

    expect(container.querySelector(".st-toolrow-empty")).toBeNull();
    const detail = container.querySelector(".st-toolrow-detail");
    expect(detail?.textContent).toContain("ls -la /tmp");
    expect(detail?.textContent).toContain("drwxr-xr-x");
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

  it("opens an inline composer for selected trace text and submits the anchor", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const { container } = render(
      <SessionTrace
        items={[sayItem(3, "Select this exact passage for review.")]}
        onSubmitTraceComment={onSubmitTraceComment}
      />
    );

    selectRenderedText(container, "exact passage");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "Please explain this."
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmitTraceComment).toHaveBeenCalledWith({
      anchor: expect.objectContaining({
        endOffset: 25,
        row: 3,
        selectedText: "exact passage",
        sourceText: "Select this exact passage for review.",
        startOffset: 12,
        traceId: expect.any(String),
        turnId: expect.any(String),
      }),
      body: "Please explain this.",
    });
  });

  it("threads a selected @-mention through the draft (FEA-3490)", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const { container } = render(
      <SessionTrace
        items={[sayItem(3, "Select this exact passage for review.")]}
        onSubmitTraceComment={onSubmitTraceComment}
      />
    );

    selectRenderedText(container, "exact passage");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    const textarea = screen.getByPlaceholderText("Comment on this passage...");
    await user.type(textarea, "cc @ad");
    await user.click(await screen.findByText("Ada Lovelace"));
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmitTraceComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "cc @Ada Lovelace",
        mentions: ["u-ada"],
      })
    );
  });

  it("uses the actual selected range when repeated text appears in one row", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const { container } = render(
      <SessionTrace
        items={[sayItem(8, "target before the second target phrase")]}
        onSubmitTraceComment={onSubmitTraceComment}
      />
    );

    selectRenderedText(container, "target", 1);
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "Second one"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmitTraceComment).toHaveBeenCalledWith({
      anchor: expect.objectContaining({
        endOffset: 31,
        row: 8,
        selectedText: "target",
        startOffset: 25,
        traceId: expect.any(String),
        turnId: expect.any(String),
      }),
      body: "Second one",
    });
  });

  it("anchors selections inside formatted markdown using rendered text offsets", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const item = sayItem(
      15,
      "Use **bold** now and [docs](https://example.com)."
    );
    const { container, rerender } = render(
      <SessionTrace
        items={[item]}
        onSubmitTraceComment={onSubmitTraceComment}
      />
    );

    selectRenderedText(container, "bold");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "Keep the emphasis."
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    const anchor = onSubmitTraceComment.mock.calls[0][0]
      .anchor as TraceTextAnchor;
    expect(anchor).toEqual(
      expect.objectContaining({
        endOffset: 8,
        row: 15,
        selectedText: "bold",
        sourceText: "Use bold now and docs.",
        startOffset: 4,
        traceId: expect.any(String),
        turnId: expect.any(String),
      })
    );

    rerender(<SessionTrace highlightAnchor={anchor} items={[item]} />);

    const selected = container.querySelector("[data-trace-selected-passage]");
    expect(selected?.textContent).toBe("bold");
    expect(container.querySelector('[data-trace-highlight="row"]')).toBeNull();
    expect(container.querySelector(".st-bubble")?.textContent).toContain(
      "Use bold now and docs."
    );
    expect(container.querySelector(".st-bubble")?.textContent).not.toContain(
      "**"
    );
  });

  it("renders only the exact anchored passage when offsets still match", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const item = sayItem(9, "Keep these chosen words precise.");
    const { container, rerender } = render(
      <SessionTrace
        items={[item]}
        onSubmitTraceComment={onSubmitTraceComment}
      />
    );

    selectRenderedText(container, "chosen words");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "Note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    const anchor = onSubmitTraceComment.mock.calls[0][0]
      .anchor as TraceTextAnchor;

    rerender(<SessionTrace highlightAnchor={anchor} items={[item]} />);

    const selected = container.querySelector("[data-trace-selected-passage]");
    expect(selected?.textContent).toBe("chosen words");
    expect(selected?.textContent).not.toContain("Keep these");
    expect(container.querySelector('[data-trace-highlight="row"]')).toBeNull();
  });

  it("does not row-highlight when the anchored source text drifts", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const original = sayItem(10, "Keep these chosen words precise.");
    const { container, rerender } = render(
      <SessionTrace
        items={[original]}
        onSubmitTraceComment={onSubmitTraceComment}
      />
    );

    selectRenderedText(container, "chosen words");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "Note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    const anchor = onSubmitTraceComment.mock.calls[0][0]
      .anchor as TraceTextAnchor;

    rerender(
      <SessionTrace
        highlightAnchor={anchor}
        items={[sayItem(10, "Keep these updated words precise.")]}
      />
    );

    expect(container.querySelector("[data-trace-selected-passage]")).toBeNull();
    expect(container.querySelector('[data-trace-highlight="row"]')).toBeNull();
  });

  it("does not highlight a refreshed row when the stable trace identity changes", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const original = sayItem(14, "Keep this stable quoted row.");
    const { container, rerender } = render(
      <SessionTrace
        items={[original]}
        onSubmitTraceComment={onSubmitTraceComment}
      />
    );

    selectRenderedText(container, "stable quoted");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "Note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    const anchor = onSubmitTraceComment.mock.calls[0][0]
      .anchor as TraceTextAnchor;

    rerender(
      <SessionTrace
        highlightAnchor={anchor}
        items={[sayItem(14, "Keep this stable quoted row.", { t: "00:01" })]}
      />
    );

    expect(container.querySelector("[data-trace-selected-passage]")).toBeNull();
    expect(container.querySelector('[data-trace-highlight="row"]')).toBeNull();
  });

  it("clears stale selection drafts when trace items change before submit", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const { container, rerender } = render(
      <SessionTrace
        items={[sayItem(16, "Remove this stale anchor.")]}
        onSubmitTraceComment={onSubmitTraceComment}
      />
    );

    selectRenderedText(container, "stale");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    expect(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    ).toBeVisible();

    rerender(
      <SessionTrace
        items={[sayItem(17, "Replacement trace row.")]}
        onSubmitTraceComment={onSubmitTraceComment}
      />
    );

    expect(
      screen.queryByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    ).toBeNull();
    expect(container.querySelector("[data-trace-selected-passage]")).toBeNull();

    selectRenderedText(container, "Replacement");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    expect(
      screen.getByPlaceholderText("Comment on this passage...")
    ).toBeVisible();

    rerender(
      <SessionTrace
        items={[sayItem(18, "Changed again before submit.")]}
        onSubmitTraceComment={onSubmitTraceComment}
      />
    );

    expect(
      screen.queryByPlaceholderText("Comment on this passage...")
    ).toBeNull();
    expect(onSubmitTraceComment).not.toHaveBeenCalled();
  });

  it("shows the live mention picker controls in the inline composer", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SessionTrace
        items={[sayItem(11, "Composer controls stay visible.")]}
        onSubmitTraceComment={vi.fn()}
      />
    );

    selectRenderedText(container, "controls");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );

    // FEA-3490: the "@" button is now a working picker trigger, not the old
    // inert placeholder; clicking it opens the org-member suggestion list.
    const mentionButton = screen.getByRole("button", { name: "Mention" });
    expect(mentionButton).toBeVisible();
    expect(
      screen.getByPlaceholderText("Comment on this passage...")
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Comment" })).toBeVisible();

    await user.click(mentionButton);
    expect(await screen.findByText("Ada Lovelace")).toBeVisible();
  });

  it("clamps the inline composer inside a narrow trace viewport", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SessionTrace
        items={[promptItem(1, "Add the flags and examples.")]}
        onSubmitTraceComment={vi.fn()}
      />
    );
    const root = container.querySelector(".st") as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(
      createRect({ left: 16, right: 374, width: 358 })
    );

    const range = selectRenderedText(container, "flags and examples");
    Object.defineProperty(range, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        createRect({
          bottom: 48,
          left: 144.25,
          right: 250.8125,
          top: 32,
          width: 106.5625,
        }),
    });

    fireEvent.mouseUp(root);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );

    const composer = container.querySelector(
      ".st-comment-compose"
    ) as HTMLElement;
    expect(composer).not.toBeNull();
    expect(composer.style.left).toBe("10px");
  });

  it("fails closed for selections outside trace text and cancels drafts without submitting", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const { container } = render(
      <div>
        <p>outside selectable text</p>
        <SessionTrace
          items={[sayItem(4, "A valid trace passage.")]}
          onSubmitTraceComment={onSubmitTraceComment}
        />
      </div>
    );

    selectRenderedText(container, "outside selectable text");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    expect(
      screen.queryByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    ).toBeNull();

    selectRenderedText(container, "valid trace");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    fireEvent.keyDown(document, { key: "Escape" });

    expect(
      screen.queryByPlaceholderText("Comment on this passage...")
    ).toBeNull();
    expect(onSubmitTraceComment).not.toHaveBeenCalled();
  });

  it("cancels drafts on outside pointer down without submitting", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const { container } = render(
      <div>
        <button type="button">outside target</button>
        <SessionTrace
          items={[sayItem(12, "Click-away draft cancellation.")]}
          onSubmitTraceComment={onSubmitTraceComment}
        />
      </div>
    );

    selectRenderedText(container, "draft");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "outside target" })
    );

    expect(
      screen.queryByPlaceholderText("Comment on this passage...")
    ).toBeNull();
    expect(onSubmitTraceComment).not.toHaveBeenCalled();
  });
});

function createRect(rect: Partial<DOMRect>): DOMRect {
  return {
    bottom: rect.bottom ?? 0,
    height: rect.height ?? 0,
    left: rect.left ?? 0,
    right: rect.right ?? 0,
    toJSON: () => ({}),
    top: rect.top ?? 0,
    width: rect.width ?? 0,
    x: rect.x ?? rect.left ?? 0,
    y: rect.y ?? rect.top ?? 0,
  };
}
