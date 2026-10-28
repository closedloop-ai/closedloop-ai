import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../mock-detail";
import { SessionTrace } from "../session-trace";
import {
  buildTestSessionDetail,
  buildTurn,
} from "./support/session-detail-builders";

const COMPOSER_LABEL = "Comment on selected trace passage";
const AFFORDANCE_NAME = "Comment";
const ROOT_RECT = DOMRect.fromRect({ height: 400, width: 600, x: 100, y: 50 });

const selectionDetail = buildTestSessionDetail({
  trace: [
    buildTurn({ blocks: [{ spans: ["Hello there"], type: "p" }], id: "a" }),
    buildTurn({
      blocks: [{ spans: ["Second turn"], type: "p" }],
      id: "b",
      side: "human",
    }),
  ],
});

let selectionRect = DOMRect.fromRect({ height: 20, width: 40, x: 150, y: 70 });
const originalRangeRect = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getBoundingClientRect"
);

beforeEach(() => {
  selectionRect = DOMRect.fromRect({ height: 20, width: 40, x: 150, y: 70 });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => selectionRect,
  });
});

afterEach(() => {
  globalThis.getSelection()?.removeAllRanges();
  if (originalRangeRect) {
    Object.defineProperty(
      Range.prototype,
      "getBoundingClientRect",
      originalRangeRect
    );
  } else {
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
  vi.restoreAllMocks();
});

function renderTrace(
  detail: SessionDetail = selectionDetail,
  onSubmitTraceComment:
    | ((comment: {
        anchorPreview: string;
        body: string;
        traceRow: number;
      }) => void)
    | null = vi.fn()
) {
  render(
    <>
      <p>Outside the trace</p>
      <SessionTrace
        activeTraceRow={0}
        detail={detail}
        onActiveTraceRowChange={vi.fn()}
        onSubmitTraceComment={onSubmitTraceComment ?? undefined}
      />
    </>
  );
  const root = screen.getByRole("heading", { name: "Session Trace" })
    .parentElement?.nextElementSibling;
  if (!(root instanceof HTMLElement)) {
    throw new Error("trace root missing");
  }
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(ROOT_RECT);
  return { onSubmitTraceComment, root };
}

function textNode(text: string): Text {
  const node = screen.getByText(text).firstChild;
  if (!(node instanceof Text)) {
    throw new Error(`text node for ${text} missing`);
  }
  return node;
}

function select(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number
) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectHello(root: HTMLElement) {
  select(textNode("Hello there"), 0, textNode("Hello there"), 11);
  fireEvent.mouseUp(root);
}

function commentControl(): HTMLElement {
  const control = screen
    .getByRole("button", { name: AFFORDANCE_NAME })
    .closest<HTMLElement>("[data-comment-control]");
  if (!control) {
    throw new Error("comment control missing");
  }
  return control;
}

function openComposer(root: HTMLElement): HTMLElement {
  selectHello(root);
  fireEvent.click(screen.getByRole("button", { name: AFFORDANCE_NAME }));
  return screen.getByRole("textbox", { name: COMPOSER_LABEL });
}

describe("SessionTrace selection affordance", () => {
  it("offers a Comment button below a single-row selection", () => {
    const { root } = renderTrace();

    selectHello(root);

    expect(
      screen.queryByRole("textbox", { name: COMPOSER_LABEL })
    ).not.toBeInTheDocument();
    expect(commentControl().style.left).toBe("50px");
    expect(commentControl().style.top).toBe("48px");
  });

  it("opens from a keyboard selection and from an element-bounded range", () => {
    const { root } = renderTrace();
    const paragraph = screen.getByText("Hello there").closest("p");
    if (!paragraph) {
      throw new Error("paragraph missing");
    }

    select(paragraph, 0, paragraph, 1);
    fireEvent.keyUp(root);

    expect(
      screen.getByRole("button", { name: AFFORDANCE_NAME })
    ).toBeInTheDocument();
  });

  it.each([
    ["left and top edges", { x: 90, y: 0 }, ROOT_RECT, "8px", "8px"],
    ["right edge", { x: 900, y: 70 }, ROOT_RECT, "252px", "48px"],
    [
      "a root narrower than the composer",
      { x: 300, y: 70 },
      DOMRect.fromRect({ height: 400, width: 300, x: 100, y: 50 }),
      "8px",
      "48px",
    ],
  ])("clamps the control inside the %s", (_, point, rootRect, left, top) => {
    const { root } = renderTrace();
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(rootRect);
    selectionRect = DOMRect.fromRect({ height: 20, width: 40, ...point });

    selectHello(root);

    expect(commentControl().style.left).toBe(left);
    expect(commentControl().style.top).toBe(top);
  });

  it("ignores selections without a comment handler", () => {
    const { root } = renderTrace(selectionDetail, null);

    selectHello(root);

    expect(
      screen.queryByRole("button", { name: AFFORDANCE_NAME })
    ).not.toBeInTheDocument();
  });

  it("ignores empty, collapsed, outside, cross-row and blank selections", () => {
    const { root } = renderTrace();
    const hello = textNode("Hello there");
    const attempts: Array<() => void> = [
      () => globalThis.getSelection()?.removeAllRanges(),
      () => select(hello, 3, hello, 3),
      () => {
        const outside = textNode("Outside the trace");
        select(outside, 0, outside, 7);
      },
      () => select(hello, 0, textNode("Second turn"), 6),
      () => select(hello, 5, hello, 6),
    ];

    for (const attempt of attempts) {
      attempt();
      fireEvent.mouseUp(root);
      expect(
        screen.queryByRole("button", { name: AFFORDANCE_NAME })
      ).not.toBeInTheDocument();
    }
  });

  it("ignores a selection inside a row whose number is not finite", () => {
    const { root } = renderTrace(
      buildTestSessionDetail({
        trace: [
          buildTurn({
            blocks: [{ spans: ["Hello there"], type: "p" }],
            row: Number.NaN,
          }),
        ],
      })
    );

    select(textNode("Hello there"), 0, textNode("Hello there"), 5);
    fireEvent.mouseUp(root);

    expect(
      screen.queryByRole("button", { name: AFFORDANCE_NAME })
    ).not.toBeInTheDocument();
  });
});

describe("SessionTrace selection composer", () => {
  it("submits a trimmed comment anchored to the selected passage", () => {
    const { onSubmitTraceComment, root } = renderTrace();

    const textarea = openComposer(root);
    expect(textarea).toHaveAttribute(
      "placeholder",
      "Comment and @mention someone…"
    );
    expect(screen.getAllByText("Hello there")).toHaveLength(2);
    const submit = screen.getByRole("button", { name: "Comment" });
    expect(submit).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "  looks good  " } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    expect(onSubmitTraceComment).toHaveBeenCalledWith({
      anchorPreview: "Hello there",
      body: "looks good",
      traceRow: 0,
    });
    expect(
      screen.queryByRole("textbox", { name: COMPOSER_LABEL })
    ).not.toBeInTheDocument();
    expect(globalThis.getSelection()?.rangeCount).toBe(0);
    expect(openComposer(root)).toHaveValue("");
  });

  it("cancels without submitting and starts the next draft empty", () => {
    const { onSubmitTraceComment, root } = renderTrace();
    fireEvent.change(openComposer(root), { target: { value: "draft" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSubmitTraceComment).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: COMPOSER_LABEL })
    ).not.toBeInTheDocument();
    expect(openComposer(root)).toHaveValue("");
  });

  it("closes on Escape but not on other keys, clearing the draft", () => {
    const { root } = renderTrace();
    fireEvent.change(openComposer(root), { target: { value: "draft" } });

    fireEvent.keyDown(document, { key: "a" });
    expect(screen.getByRole("textbox", { name: COMPOSER_LABEL })).toHaveValue(
      "draft"
    );
    fireEvent.keyDown(document, { key: "Escape" });

    expect(
      screen.queryByRole("textbox", { name: COMPOSER_LABEL })
    ).not.toBeInTheDocument();
    expect(openComposer(root)).toHaveValue("");
  });

  it("stays open for pointer presses inside the control and closes for presses elsewhere", () => {
    const { root } = renderTrace();
    const textarea = openComposer(root);
    fireEvent.change(textarea, { target: { value: "draft" } });

    fireEvent.pointerDown(textarea);
    expect(screen.getByRole("textbox", { name: COMPOSER_LABEL })).toHaveValue(
      "draft"
    );
    fireEvent.pointerDown(screen.getByText("Outside the trace"));

    expect(
      screen.queryByRole("textbox", { name: COMPOSER_LABEL })
    ).not.toBeInTheDocument();
    expect(openComposer(root)).toHaveValue("");
  });

  it("closes the affordance for a press on the document itself", () => {
    const { root } = renderTrace();
    selectHello(root);

    fireEvent.pointerDown(document);

    expect(
      screen.queryByRole("button", { name: AFFORDANCE_NAME })
    ).not.toBeInTheDocument();
  });
});
