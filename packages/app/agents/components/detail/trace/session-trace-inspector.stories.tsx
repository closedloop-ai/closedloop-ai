import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, within } from "storybook/test";
import {
  SESSION_TRACE_EXTENT_LABEL,
  SESSION_TRACE_EXTENT_NOTE,
  SessionTraceExtentSource,
} from "../../../lib/session-trace/session-trace-node";
import {
  spanFrom,
  traceInvocation,
} from "./__tests__/session-trace-span-fixtures";
import { SessionTraceInspector } from "./session-trace-inspector";

/**
 * ISS-10737 — the selected span in full, and the one thing this panel exists to
 * refuse.
 *
 * EVERY FIELD HERE IS UNSOURCED TODAY. `succeeded`, the token vector,
 * `estimatedCost` and `footprintTokens` are real columns that ride the
 * invocation sync item and are absent from the read row until ISS-10718 widens
 * it, so {@link UnsourcedTelemetry} is not an edge case — it is what the panel
 * renders on a current session, and it is the first story for that reason.
 * Every one of those rows says it was not recorded. A dash would read as "this
 * span happens to have none" and a `0` would be a measurement nothing made;
 * both are the same lie one step apart, and the sentence is the only honest
 * third option.
 *
 * THE TWO TOKEN POPULATIONS ARE NEVER SUMMED (DOC-37 section 4), which is a
 * layout claim as much as an arithmetic one: turn tokens and context footprint
 * sit in separate sections under separate headings because a component's
 * injected text is already inside the consuming turn's input count. One number
 * is an ATTRIBUTION of the other. {@link MeasuredFailure} is the render to judge
 * that separation on — if the two sections ever read as one block of token
 * numbers, a reader will add them.
 *
 * A FAILED SPAN LEADS WITH THE ERROR (DOC-37 section 6). If you selected a
 * failed span, the failure is what you came for, not something to reach by
 * scrolling past the token sections.
 *
 * {@link InferredExtent} carries the provenance sentence beside the width, which
 * is the inspector's half of the chart's hatch: the bar says "this is not a
 * measurement" visually, and this says why in one sentence.
 */

/**
 * The missing-operand sentence, which the component owns as a private constant.
 * Mirrored here the way `__tests__/session-trace-inspector.test.tsx` mirrors it,
 * so these stories assert the shipped string rather than a paraphrase.
 */
const NOT_RECORDED = "Not recorded for this session";

/** A phone viewport, where the rail's field values wrap rather than truncate. */
const PHONE_VIEWPORT = "390-844";

/** The rail width the detail pane gives the inspector on a desktop viewport. */
const RAIL_WIDTH_PX = 320;
/** At 390px the rail stops being a rail and becomes the whole column. */
const PHONE_RAIL_WIDTH_PX = 358;

const meta = {
  title: "Composites/Artifacts/Sessions/Session Detail/Session Trace Inspector",
  component: SessionTraceInspector,
  tags: ["stable", "autodocs"],
  parameters: { layout: "padded" },
  // No controls: `span` is a derived tree node from the shared invocation
  // fixture and `onFocusSubtree` is a callback, so every axis worth reviewing is
  // which SPAN is selected — one story each, below.
  argTypes: { span: { control: false }, onFocusSubtree: { control: false } },
  args: { onFocusSubtree: fn() },
  // The bordered rail the detail pane opens beside the chart. ONE decorator,
  // whose width a story overrides through `parameters.railWidthPx` rather than
  // by stacking a second rail inside this one.
  decorators: [
    (Story, context) => (
      <div
        className="overflow-hidden rounded-md border border-border"
        style={{ width: context.parameters.railWidthPx ?? RAIL_WIDTH_PX }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionTraceInspector>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A root span on a session with no telemetry producer at all — today's shipped
 * case. Three fields state the absence in words, the ancestry says this is a
 * root rather than rendering an empty breadcrumb, and the Definition row is
 * absent outright because an unsourced hash has nothing to say about the span.
 *
 * Read the three sentences as a block. They are the panel's whole defence
 * against a reader taking an unmeasured span for a free one, and if any of them
 * ever regresses to a dash it will regress silently — a dash looks like data.
 */
export const UnsourcedTelemetry: Story = {
  args: { span: spanFrom([traceInvocation("root", 0)], "root") },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Turn spend, turn tokens, and context footprint — three separate
    // populations, three separate absences, never collapsed into one.
    expect(canvas.getAllByText(NOT_RECORDED)).toHaveLength(3);
    expect(
      canvas.getByText(
        "A root of this session — nothing above it was recorded."
      )
    ).toBeVisible();
  },
};

/**
 * A failed skill call with every population sourced: the error banner leads, the
 * ancestry names the hand-off chain that reached it, and the two token sections
 * sit apart with the sentence that says why they are never added.
 *
 * The banner is the hierarchy claim — it is above the header, not beside the
 * kind badge, so a reader who selected this span from a red bar lands on the
 * failure rather than on a token table. Judge the two token headings against
 * each other for the other claim: "Turn tokens in / out" and "Context footprint
 * (a different population)" have to look like two answers, not two rows of one.
 */
export const MeasuredFailure: Story = {
  args: {
    span: spanFrom(
      [
        traceInvocation("parent", 0, {
          componentKey: "Task",
          kind: AgentComponentInvocationKind.Subagent,
          durationMs: 10_000,
        }),
        traceInvocation("child", 1000, {
          componentKey: "code-review",
          kind: AgentComponentInvocationKind.Skill,
          parentExternalInvocationId: "parent",
          durationMs: 2000,
          succeeded: false,
          externalAgentId: "ag-7",
          estimatedCost: 1.5,
          inputTokens: 1200,
          outputTokens: 34,
          footprintTokens: 5000,
          definitionHash: "sha256:9f2c41ab",
        }),
      ],
      "child"
    ),
  },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByText(
        "This call reported a failure. Its ancestry above is the hand-off chain that reached it."
      )
    ).toBeVisible();
    expect(canvas.queryByText(NOT_RECORDED)).not.toBeInTheDocument();
    expect(
      canvas.getByText(
        `Extent · ${SESSION_TRACE_EXTENT_LABEL[SessionTraceExtentSource.Measured]}`
      )
    ).toBeVisible();
  },
};

/**
 * A hook that recorded only a start instant, so its extent was reasoned to from
 * the parent's close. The heading names the provenance and the value carries the
 * sentence that says what the reader may conclude — an upper bound on latency,
 * not latency.
 *
 * This is the pair for the chart's hatched bar. The bar says the claim is weaker
 * without words; this says in what way, which is the part a hatch cannot carry.
 */
export const InferredExtent: Story = {
  args: {
    span: spanFrom(
      [
        traceInvocation("parent", 0, {
          componentKey: "Task",
          kind: AgentComponentInvocationKind.Subagent,
          durationMs: 8000,
        }),
        traceInvocation("hook", 500, {
          componentKey: "PreToolUse",
          kind: AgentComponentInvocationKind.Hook,
          parentExternalInvocationId: "parent",
          footprintTokens: 180,
        }),
      ],
      "hook"
    ),
  },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = canvas.getByText(
      `Extent · ${SESSION_TRACE_EXTENT_LABEL[SessionTraceExtentSource.Inferred]}`
    );
    expect(heading).toBeVisible();
    // The width and the sentence are one text node, so the value is read off
    // the heading's sibling rather than matched as standalone copy.
    expect(heading.nextElementSibling?.textContent).toContain(
      SESSION_TRACE_EXTENT_NOTE[SessionTraceExtentSource.Inferred]
    );
    // The footprint is sourced on this row; the other two populations are not,
    // so the panel mixes a real number with two absences in one column.
    expect(canvas.getAllByText(NOT_RECORDED)).toHaveLength(2);
  },
};

/**
 * The failed span again at 390px, where the rail becomes the full column width.
 *
 * Every value here is a long sentence or a hash, and the fields are a single
 * stacked column with `break-words` rather than truncation — the panel is the
 * place a reader comes to read, so a clipped definition hash or a cut-off
 * attribution sentence costs more than the vertical space. This is where that
 * trade is either holding or crowding.
 */
export const NarrowRail: Story = {
  args: MeasuredFailure.args,
  globals: { viewport: { value: PHONE_VIEWPORT } },
  parameters: { railWidthPx: PHONE_RAIL_WIDTH_PX },
};
