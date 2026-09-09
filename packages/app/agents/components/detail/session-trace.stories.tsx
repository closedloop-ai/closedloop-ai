import { TraceCommentKind } from "@repo/api/src/types/comment";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { useRef } from "react";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";
import { ParsingBugFlagProvider } from "../../data-source/parsing-bug-flag-provider";
import {
  createSessionTraceItemsOfLength,
  flaggedSessionTraceItems,
  longTraceTextItems,
  populatedSessionTraceItems,
  traceCostReadoutItems,
  traceToolCardItems,
} from "./agent-session-detail-fixtures";
import { SessionTrace, type SessionTraceItem } from "./session-trace";
import type { SessionTraceHandle } from "./session-trace-contract";

const REASONING_BUTTON_NAME = "Reasoning";
const FAILED_TOOL_CARD_NAME = /Ran 2 tools/;
const CLEAN_TOOL_CARD_NAME = /^Ran 2 tools$/;
const DEGRADED_TOOL_CARD_NAME = /Ran 6 tools/;
const BASH_TOOL_ROW_NAME = /pnpm turbo typecheck/;
const COMMENT_CONTROL_NAME = "Comment";
const PARSING_BUG_CHECKBOX_NAME = "Flag as parsing/data bug";

const THINKING_TEXT =
  "The dashboard mixes metrics and transcript; a dedicated trace view reads better.";
/** A passage inside the row-2 agent turn, selected by the comment stories. */
const SELECTED_PASSAGE = "Session Trace workspace";

/** Turns for the windowed story, well past what one viewport can hold. */
const WINDOWED_TRACE_ITEMS = createSessionTraceItemsOfLength(120);

/**
 * The row {@link Virtualized} jumps to — deliberately far outside the window
 * that story mounts, so the handle has to resolve a row it is not already
 * showing rather than one already on screen.
 */
const VIRTUALIZED_TARGET_ROW = 100;

/** Injects the staff signal the parsing-bug affordance is gated on (FEA-4347). */
const staffDecorator: Decorator = (Story) => (
  <ParsingBugFlagProvider canFlagParsingBug>
    <Story />
  </ParsingBugFlagProvider>
);

/**
 * ISS-5698: the Session Trace, on its own.
 *
 * It is the densest component on the session detail and the one carrying the
 * most state, and until now the only way to see any of it was to load a real
 * session that happened to contain the shape you wanted. That is why its
 * degraded branches (a tool card with nothing to expand into, a turn whose cost
 * was never measured, a producer-flagged turn) went unlooked-at. Each story
 * below pins one of those branches with a fixture that reaches it deliberately.
 *
 * The trace takes its rows as a prop and mounts no queries, so nothing here
 * seeds the app-core harness. The interaction stories rely only on the API port
 * the preview already provides, which is what resolves the composer's @-mention
 * list to an empty set.
 */
const meta = {
  title: "App Core/Agents/Timeline/Session Trace",
  component: SessionTrace,
  tags: ["autodocs"],
  argTypes: {
    activeRow: {
      control: { min: 0, step: 1, type: "number" },
      table: { category: "State" },
    },
    className: { control: "text", table: { category: "Appearance" } },
    highlightAnchor: { control: "object", table: { category: "State" } },
    invocationAnchor: { control: "object", table: { category: "State" } },
    items: { control: "object", table: { category: "Data" } },
    /*
     * The callbacks are documented, not defaulted to `fn()` here. The trace
     * reads `onSubmitTraceComment || onTraceSelectionChange` as its switch into
     * selection mode, so a meta-level spy would turn every story on this page
     * into a comment surface. The two comment stories pass their own spies.
     */
    onJump: { control: false, table: { category: "Events" } },
    onSubmitTraceComment: { control: false, table: { category: "Events" } },
    onTraceSelectionChange: { control: false, table: { category: "Events" } },
    renderGutterActor: { control: false, table: { category: "Appearance" } },
    scrollElementRef: { control: false, table: { category: "Data" } },
    virtualize: { control: "boolean", table: { category: "State" } },
  },
  parameters: { layout: "padded" },
  args: {
    activeRow: null,
    highlightAnchor: null,
    invocationAnchor: null,
    items: populatedSessionTraceItems,
    virtualize: false,
  },
} satisfies Meta<typeof SessionTrace>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The whole row vocabulary in one canvas: a human prompt, a reasoning
 * disclosure, an agent turn, a tool card that auto-opened because a call inside
 * it failed, a system event row, a collapsed sub-agent box, and the terminal
 * row.
 *
 * The `play` drives the reasoning disclosure both ways. Reasoning defaults OPEN
 * and is the only row that hides real content when closed, so a regression that
 * inverted the default, or that left the body mounted after a collapse, would
 * look like nothing at all in a screenshot.
 */
export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const reasoning = canvas.getByRole("button", {
      name: REASONING_BUTTON_NAME,
    });
    await expect(reasoning).toHaveAttribute("aria-expanded", "true");
    expect(canvasElement.textContent).toContain(THINKING_TEXT);

    await userEvent.click(reasoning);
    await expect(reasoning).toHaveAttribute("aria-expanded", "false");
    expect(canvasElement.textContent).not.toContain(THINKING_TEXT);

    await userEvent.click(reasoning);
    expect(canvasElement.textContent).toContain(THINKING_TEXT);

    // A card holding a failed call opens itself, so the failure is never one
    // click away from a reader scanning for it.
    await expect(
      canvas.getByRole("button", { name: FAILED_TOOL_CARD_NAME })
    ).toHaveAttribute("aria-expanded", "true");
  },
};

/**
 * Zero rows. The trace renders its container and NOTHING else: no spinner, no
 * "0 turns", no empty-state card claiming the session had no conversation.
 *
 * That silence is deliberate and it is the reason this story exists: the trace
 * does not know whether its rows are still loading, so any message it invented
 * here would be a claim its caller owns. The panel above it (see
 * `Session Transcript Panel`) is what distinguishes loading from empty from
 * unavailable, and it can only do that if the trace stays quiet.
 */
export const Empty: Story = {
  args: { items: [] },
  play: ({ canvasElement }) => {
    const trace = canvasElement.querySelector(".st");
    expect(trace).not.toBeNull();
    expect(trace?.childElementCount).toBe(0);
    expect(trace?.textContent).toBe("");
  },
};

/**
 * Four cost readouts side by side, which is the only way to see that they are
 * four and not one.
 *
 * Top to bottom: a sub-cent turn that prints `$0.0034` rather than flooring to
 * `$0.00`; a turn below the 4dp rounding floor that states `< $0.0001` rather
 * than fabricating a zero; a turn carrying no per-turn delta, which falls back
 * to the running total; and a turn that genuinely cost nothing measurable,
 * which prints no figure at all.
 *
 * The `play` asserts the negative: `$0.00` must not appear anywhere on this
 * trace. It is the one string that would mean two different things at once,
 * "this cost nothing" and "we never priced this", and collapsing the four
 * readouts back into it is the regression to catch.
 */
export const CostReadout: Story = {
  args: { items: traceCostReadoutItems },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getAllByText("$0.0034").length).toBeGreaterThan(0);
    expect(canvas.getAllByText("< $0.0001").length).toBeGreaterThan(0);
    expect(canvas.getAllByText("$2.50").length).toBeGreaterThan(0);
    expect(canvas.queryAllByText("$0.00")).toHaveLength(0);
  },
};

/**
 * Two tool cards in one bubble, differing only in whether the producer captured
 * the per-call rows.
 *
 * The first is a real disclosure: closed by default (nothing failed), it opens
 * to two call rows, and each of those opens again to that call's command and
 * output. The second card came back with no rows at all, so it renders as a
 * static summary: no chevron, no button, no tab stop. A dropdown that opens
 * onto nothing is the failure mode this pairing guards, and it is invisible in
 * a screenshot because both cards look identical until you try to click one.
 */
export const CollapsedToolCards: Story = {
  args: { items: traceToolCardItems },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByRole("button", { name: CLEAN_TOOL_CARD_NAME });
    await expect(card).toHaveAttribute("aria-expanded", "false");

    // The degraded card is present as text but offers no control to press.
    expect(canvasElement.textContent).toContain("Ran 6 tools");
    expect(
      canvas.queryByRole("button", { name: DEGRADED_TOOL_CARD_NAME })
    ).toBeNull();

    await userEvent.click(card);
    await expect(card).toHaveAttribute("aria-expanded", "true");

    const toolRow = canvas.getByRole("button", { name: BASH_TOOL_ROW_NAME });
    await expect(toolRow).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toolRow);
    await expect(toolRow).toHaveAttribute("aria-expanded", "true");
    expect(canvasElement.textContent).toContain("44 successful");
  },
};

/**
 * A turn the producer flagged. `flag` lives only on the trace's own row type,
 * so this state cannot be reached from any session-detail fixture and has no
 * other home in the catalog.
 *
 * What to look at: the reason rides ABOVE the bubble as its own tag rather than
 * being folded into the turn text, and the bubble itself carries the flagged
 * treatment. The flag is a claim about the row, not part of what the agent
 * said, and the two must not read as one message.
 */
export const FlaggedTurn: Story = {
  args: { items: flaggedSessionTraceItems },
  play: ({ canvasElement }) => {
    expect(canvasElement.textContent).toContain(
      "Disputed: watchdog attribution"
    );
    expect(canvasElement.querySelector(".st-flagged")).not.toBeNull();
  },
};

/**
 * Long prose and an unbreakable token, in a column narrow enough to crowd them.
 *
 * The signed archive URL is the shape that actually breaks a trace: it has no
 * break opportunity, so a bubble that does not wrap it overflows its column and
 * pushes the gutter off screen. The paragraph beside it is there so wrapping and
 * overflow can be judged against each other at the same width.
 */
export const LongContent: Story = {
  args: { items: longTraceTextItems },
  render: (args) => (
    <div className="max-w-md">
      <SessionTrace {...args} />
    </div>
  ),
  play: ({ canvasElement }) => {
    // A renderer that silently clipped the token would still look tidy.
    expect(canvasElement.textContent).toContain("X-Amz-Signature=");
  },
};

/**
 * 120 turns through the windowed path (PLN-1148 Phase 4), inside the bounded
 * scroller the parent owns.
 *
 * The stage supplies a real, height-constrained scroll element because that is
 * the whole precondition: without one the virtualizer has nothing to measure
 * and the trace degrades to mounting every row. The windowed branch is
 * structurally different, not just smaller: `.st` becomes a sized
 * `position: relative` sizer and each row is absolutely positioned at its
 * measured offset.
 *
 * PR #4814 review: that structure ALONE does not prove the wiring. The
 * virtualizer is seeded with `initialRect: { height: ASSUMED_TRACE_VIEWPORT_PX }`
 * so it windows from the first render, which means the relative sizer, the
 * `[data-index]` rows and their absolute positioning all appear even when
 * `getScrollElement()` returns null — the assertions would have held against a
 * `scrollElementRef` that was never attached, i.e. against the very defect the
 * stage exists to prevent.
 *
 * So the `play` drives the imperative handle instead. `scrollToRow` on the
 * windowed path resolves the row to a group index and calls
 * `virtualizer.scrollToIndex`, which reaches `scrollElement.scrollTo(...)`
 * synchronously — on the SCROLL ELEMENT and nowhere else. Recording that call
 * on the bounded container is therefore a claim about the connection itself:
 * point `scrollElementRef` at nothing and the recorder stays empty.
 *
 * What is deliberately NOT asserted is the scroll OFFSET. `getOffsetForAlignment`
 * clamps to `getMaxScrollOffset()`, which is `scrollHeight - clientHeight`, and
 * jsdom reports 0 for both — so every row in this fixture resolves to `top: 0`
 * here and a `toBeGreaterThan(0)` would be asserting the layout engine rather
 * than the trace. The same reason row COUNTS are not pinned.
 */
export const Virtualized: Story = {
  args: { items: WINDOWED_TRACE_ITEMS },
  render: (args) => <VirtualizedTraceStage items={args.items} />,
  play: ({ canvasElement }) => {
    const trace = canvasElement.querySelector<HTMLElement>(".st");
    expect(trace?.style.position).toBe("relative");
    const rows = Array.from(
      trace?.querySelectorAll<HTMLElement>("[data-index]") ?? []
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.style.position === "absolute")).toBe(true);
    // Windowing is only meaningful if it is actually dropping rows; 120 turns
    // all mounted would satisfy every structural check above.
    expect(rows.length).toBeLessThan(WINDOWED_TRACE_ITEMS.length);

    const { handle, scroller } = virtualizedStage;
    if (!(handle && scroller)) {
      throw new Error("VirtualizedTraceStage published no handle or scroller");
    }
    // Installed on the BOUNDED CONTAINER specifically, and only after mount, so
    // anything it records was addressed to this element by the call below.
    // jsdom leaves `Element.prototype.scrollTo` undefined, so without this the
    // virtualizer's optional `scrollElement?.scrollTo?.(…)` is a silent no-op
    // and there is nothing to observe either way.
    const scrollCalls: ScrollToOptions[] = [];
    scroller.scrollTo = ((options?: ScrollToOptions | number) => {
      scrollCalls.push(
        typeof options === "number" ? { top: options } : (options ?? {})
      );
    }) as HTMLDivElement["scrollTo"];

    handle.scrollToRow(VIRTUALIZED_TARGET_ROW);

    // One instruction, delivered to the stage's own scroller. This is the part
    // `initialRect` cannot fake: `scrollToIndex` reaches `scrollTo` only via
    // `virtualizer.scrollElement`, which is `getScrollElement()`'s return — so
    // an unattached `scrollElementRef` leaves this empty. It also proves the row
    // RESOLVED, since an index with no measurement returns before the scroll.
    expect(scrollCalls).toHaveLength(1);
    expect(typeof scrollCalls[0]?.top).toBe("number");
  },
};

/**
 * The local trace-comment flow, end to end: select a passage, take the
 * affordance, write, submit.
 *
 * Selection is native. The trace listens for it rather than owning a selection
 * UI, so the `play` builds a real `Range` over the rendered text and lets the
 * component resolve it, which is the only way to prove the offset arithmetic
 * that turns a browser selection into a durable anchor still holds.
 *
 * The parsing-bug checkbox is deliberately ABSENT here. It is staff-only and the
 * context defaults closed, so an un-updated surface (a customer) gets a plain
 * composer; {@link TraceCommentParsingBugFlag} is the same flow with the signal
 * injected.
 */
export const TraceComment: Story = {
  args: { onSubmitTraceComment: fn() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await openTraceCommentComposer(canvasElement);

    // The composer quotes the exact passage back, so the reader can see what the
    // comment will be anchored to rather than trusting the selection survived.
    expect(canvasElement.querySelector(".st-comment-quote")?.textContent).toBe(
      SELECTED_PASSAGE
    );
    expect(
      canvas.queryByRole("checkbox", { name: PARSING_BUG_CHECKBOX_NAME })
    ).toBeNull();

    await userEvent.type(
      canvas.getByPlaceholderText("Comment on this passage..."),
      "Pin this turn for the handoff."
    );
    await userEvent.click(
      canvas.getByRole("button", { name: COMMENT_CONTROL_NAME })
    );

    await expect(args.onSubmitTraceComment).toHaveBeenCalledWith({
      anchor: expect.objectContaining({
        row: 2,
        selectedText: SELECTED_PASSAGE,
      }),
      body: "Pin this turn for the handoff.",
    });
  },
};

/**
 * The same flow on a staff surface, which is the only place the parsing-bug
 * checkbox exists (FEA-4171 / FEA-4347).
 *
 * Worth its own story rather than a variant assertion: checking that box changes
 * what the comment IS. It routes the passage into the golden-dataset candidate
 * pipeline as a data-quality report instead of filing an ordinary comment, so
 * the `play` asserts the submitted payload carries that kind, not merely that
 * the control rendered.
 */
export const TraceCommentParsingBugFlag: Story = {
  args: { onSubmitTraceComment: fn() },
  decorators: [staffDecorator],
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await openTraceCommentComposer(canvasElement);

    await userEvent.click(
      canvas.getByRole("checkbox", { name: PARSING_BUG_CHECKBOX_NAME })
    );
    await userEvent.type(
      canvas.getByPlaceholderText("Comment on this passage..."),
      "The tool output was folded into the wrong turn."
    );
    await userEvent.click(
      canvas.getByRole("button", { name: COMMENT_CONTROL_NAME })
    );

    await expect(args.onSubmitTraceComment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: TraceCommentKind.ParsingBug })
    );
  },
};

/**
 * Handles {@link VirtualizedTraceStage} publishes for its `play` to drive.
 *
 * The stage owns both the imperative handle and the bounded scroller, and a
 * `play` only receives `canvasElement` — so the two are surfaced here rather
 * than re-derived from the DOM, where the scroller would have to be matched by
 * class name and the handle could not be reached at all.
 */
const virtualizedStage: {
  handle: SessionTraceHandle | null;
  scroller: HTMLDivElement | null;
} = { handle: null, scroller: null };

/**
 * The bounded scroll viewport the windowed trace measures itself against. The
 * real parent (the branch detail page) owns this element; a story that rendered
 * the trace bare would leave `scrollElementRef` pointing at nothing and quietly
 * exercise the non-windowed fallback instead.
 */
function VirtualizedTraceStage({
  items,
}: Readonly<{ items: readonly SessionTraceItem[] }>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      className="h-96 overflow-y-auto"
      ref={(node) => {
        scrollRef.current = node;
        virtualizedStage.scroller = node;
      }}
    >
      <SessionTrace
        items={items}
        ref={(handle) => {
          virtualizedStage.handle = handle;
        }}
        scrollElementRef={scrollRef}
        virtualize
      />
    </div>
  );
}

/**
 * Select {@link SELECTED_PASSAGE} in the rendered trace, raise the affordance
 * the way a real mouse-up does, and open the composer behind it.
 *
 * Shared by both comment stories so they differ only in the branch under test.
 */
async function openTraceCommentComposer(
  canvasElement: HTMLElement
): Promise<void> {
  const canvas = within(canvasElement);
  const trace = canvasElement.querySelector(".st");
  if (!trace) {
    throw new Error("The trace root did not render.");
  }
  selectRenderedTraceText(canvasElement, SELECTED_PASSAGE);
  await fireEvent.mouseUp(trace);
  await userEvent.click(
    await canvas.findByRole("button", { name: COMMENT_CONTROL_NAME })
  );
}

/** Place a native selection over `text` inside the rendered trace. */
function selectRenderedTraceText(root: HTMLElement, text: string): void {
  const node = findTraceTextNode(root, text);
  if (!node) {
    throw new Error(`Unable to find rendered trace text: ${text}`);
  }
  const start = (node.textContent ?? "").indexOf(text);
  const range = root.ownerDocument.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const selection = root.ownerDocument.defaultView?.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The first text node under `node` whose content includes `text`. */
function findTraceTextNode(node: Node, text: string): Text | null {
  if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes(text)) {
    return node as Text;
  }
  for (const child of Array.from(node.childNodes)) {
    const found = findTraceTextNode(child, text);
    if (found) {
      return found;
    }
  }
  return null;
}
