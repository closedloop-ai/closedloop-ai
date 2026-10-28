import { afterEach, describe, expect, it } from "vitest";
import {
  getTraceTextHighlight,
  resolveTraceSelection,
} from "../session-trace-selection";
import type { TraceTextAnchor } from "../trace-comments";

const SOURCE_TEXT = "alpha beta gamma";

type SourceAttrs = {
  row?: string;
  traceId?: string;
  turnId?: string;
  actor?: string;
  human?: string;
  sessionId?: string;
};

function mountSource(text: string, attrs: SourceAttrs = {}) {
  const root = document.createElement("div");
  const source = document.createElement("p");
  source.dataset.traceTextRow = attrs.row ?? "3";
  source.dataset.traceText = text;
  if (attrs.traceId !== "") {
    source.dataset.traceId = attrs.traceId ?? "trace-1";
  }
  source.dataset.traceTurnId = attrs.turnId ?? "turn-1";
  if (attrs.actor !== undefined) {
    source.dataset.traceActor = attrs.actor;
  }
  if (attrs.human !== undefined) {
    source.dataset.traceHuman = attrs.human;
  }
  if (attrs.sessionId !== undefined) {
    source.dataset.traceSessionId = attrs.sessionId;
  }
  source.textContent = text;
  root.append(source);
  document.body.append(root);
  return { root, source };
}

function selectIn(node: Node, start: number, end: number): Selection {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = globalThis.getSelection();
  if (selection === null) {
    throw new Error("no selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function textNodeOf(element: HTMLElement): Text {
  const node = element.firstChild;
  if (!(node instanceof Text)) {
    throw new Error("expected a text node");
  }
  return node;
}

afterEach(() => {
  globalThis.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("resolveTraceSelection", () => {
  it("returns null without a selection or a root", () => {
    const { root } = mountSource(SOURCE_TEXT);
    expect(resolveTraceSelection(null, root)).toBeNull();
    expect(resolveTraceSelection(globalThis.getSelection(), null)).toBeNull();
  });

  it("builds an affordance draft with the trimmed passage and the default actor", () => {
    const { root, source } = mountSource(SOURCE_TEXT);
    const selection = selectIn(textNodeOf(source), 5, 11);

    const draft = resolveTraceSelection(selection, root);

    expect(draft).toStrictEqual({
      anchor: {
        actor: { human: null, name: "Agent" },
        endOffset: 10,
        row: 3,
        selectedText: "beta",
        sessionId: null,
        sourceText: SOURCE_TEXT,
        startOffset: 6,
        traceId: "trace-1",
        turnId: "turn-1",
      },
      mode: "affordance",
      position: { x: 8, y: 8 },
    });
  });

  it("carries the actor, human, and session id from the source row", () => {
    const { root, source } = mountSource(SOURCE_TEXT, {
      actor: "claude",
      human: "Ada",
      sessionId: "s-9",
    });
    const selection = selectIn(textNodeOf(source), 0, 5);

    const anchor = resolveTraceSelection(selection, root)?.anchor;

    expect(anchor?.actor).toStrictEqual({ human: "Ada", name: "claude" });
    expect(anchor?.sessionId).toBe("s-9");
  });

  it("accepts a selection whose start container is the source element itself", () => {
    const { root, source } = mountSource(SOURCE_TEXT);
    const selection = selectIn(source, 0, 1);

    expect(resolveTraceSelection(selection, root)?.anchor.selectedText).toBe(
      SOURCE_TEXT
    );
  });

  it("returns null when the selection spans two source rows", () => {
    const { root, source } = mountSource(SOURCE_TEXT);
    const second = document.createElement("p");
    second.dataset.traceTextRow = "4";
    second.dataset.traceText = "other";
    second.textContent = "other";
    root.append(second);
    const range = document.createRange();
    range.setStart(textNodeOf(source), 0);
    range.setEnd(textNodeOf(second), 3);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(resolveTraceSelection(selection, root)).toBeNull();
  });

  it("returns null when the selection lies outside the root", () => {
    const { source } = mountSource(SOURCE_TEXT);
    const otherRoot = document.createElement("div");
    document.body.append(otherRoot);
    const selection = selectIn(textNodeOf(source), 0, 5);

    expect(resolveTraceSelection(selection, otherRoot)).toBeNull();
  });

  it("returns null when the row carries no trace id", () => {
    const { root, source } = mountSource(SOURCE_TEXT, { traceId: "" });
    const selection = selectIn(textNodeOf(source), 0, 5);

    expect(resolveTraceSelection(selection, root)).toBeNull();
  });

  it("returns null when the row number is not numeric", () => {
    const { root, source } = mountSource(SOURCE_TEXT, { row: "x" });
    const selection = selectIn(textNodeOf(source), 0, 5);

    expect(resolveTraceSelection(selection, root)).toBeNull();
  });

  it("returns null for a whitespace-only selection", () => {
    const { root, source } = mountSource("alpha   beta");
    const selection = selectIn(textNodeOf(source), 5, 8);

    expect(resolveTraceSelection(selection, root)).toBeNull();
  });

  it("places the popover at the gutter when the root reports a non-finite left edge", () => {
    const { root, source } = mountSource(SOURCE_TEXT);
    root.getBoundingClientRect = () => new DOMRect(Number.NaN, 0, 400, 50);
    const selection = selectIn(textNodeOf(source), 0, 5);

    expect(resolveTraceSelection(selection, root)?.position).toStrictEqual({
      x: 8,
      y: 8,
    });
  });

  it("clamps the popover x to the room left beside the composer", () => {
    const { root, source } = mountSource(SOURCE_TEXT);
    root.getBoundingClientRect = () => new DOMRect(-500, -40, 400, 50);
    const selection = selectIn(textNodeOf(source), 0, 5);

    expect(resolveTraceSelection(selection, root)?.position).toStrictEqual({
      x: 52,
      y: 48,
    });
  });
});

function anchor(overrides: Partial<TraceTextAnchor> = {}): TraceTextAnchor {
  return {
    traceId: "trace-1",
    turnId: "turn-1",
    row: 3,
    selectedText: "beta",
    sourceText: SOURCE_TEXT,
    startOffset: 6,
    endOffset: 10,
    ...overrides,
  };
}

describe("getTraceTextHighlight", () => {
  it("returns null without an anchor or for a different row, trace, or turn", () => {
    expect(
      getTraceTextHighlight(null, 3, SOURCE_TEXT, "trace-1", "turn-1")
    ).toBeNull();
    expect(
      getTraceTextHighlight(anchor(), 4, SOURCE_TEXT, "trace-1", "turn-1")
    ).toBeNull();
    expect(
      getTraceTextHighlight(anchor(), 3, SOURCE_TEXT, "trace-2", "turn-1")
    ).toBeNull();
    expect(
      getTraceTextHighlight(anchor(), 3, SOURCE_TEXT, "trace-1", "turn-2")
    ).toBeNull();
  });

  it("returns the exact offsets when the anchor matches the raw source", () => {
    expect(
      getTraceTextHighlight(anchor(), 3, SOURCE_TEXT, "trace-1", "turn-1")
    ).toStrictEqual({ kind: "exact", startOffset: 6, endOffset: 10 });
  });

  it("maps an anchor taken from rendered markdown back to exact offsets", () => {
    const markdown =
      "see **bold** and [docs](https://x.test) and ![pic](i.png)";
    const rendered = "see bold and docs and pic";
    const result = getTraceTextHighlight(
      anchor({
        sourceText: rendered,
        selectedText: "docs",
        startOffset: 13,
        endOffset: 17,
      }),
      3,
      markdown,
      "trace-1",
      "turn-1"
    );
    expect(result).toStrictEqual({
      kind: "exact",
      startOffset: 13,
      endOffset: 17,
    });
  });

  it("falls back to a whole-row highlight when the passage no longer matches", () => {
    expect(
      getTraceTextHighlight(
        anchor({ selectedText: "zeta" }),
        3,
        SOURCE_TEXT,
        "trace-1",
        "turn-1"
      )
    ).toStrictEqual({ kind: "row" });
  });
});
