import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { expect, fn, within } from "storybook/test";
import {
  buildSessionTrace,
  flattenSpans,
} from "../../../lib/session-trace/build-session-trace";
import {
  SESSION_TRACE_EXTENT_LABEL,
  SessionTraceExtentSource,
  type SessionTraceInvocation,
  type SessionTraceSpan,
} from "../../../lib/session-trace/session-trace-node";
import { traceInvocation } from "./__tests__/session-trace-span-fixtures";
import {
  SessionTraceChartRows,
  SessionTraceChartRuler,
} from "./session-trace-chart";

/**
 * ISS-10737 — the span canvas, and the three claims only a render can check.
 *
 * `__tests__/session-trace-chart-rows.test.tsx` already pins the arithmetic: the
 * failure floor is 1.2%, the bar is the intersection of span and window, the
 * accessible name carries kind, extent provenance and failure. What it cannot
 * check is whether a reader can SEE the difference between the claims those
 * numbers encode, and that is what these stories are for:
 *
 * - A MEASURED bar and an INFERRED bar are different statements. Measured width
 *   is latency; inferred width is only an upper bound on it. The separation is a
 *   fill difference (a hatch), not a hue difference, so it has to survive both
 *   themes and greyscale — and the ruler's own key has to keep matching the
 *   bars it explains, since both draw from `sessionTraceHatchFill`.
 * - A FAILED span is filled destructive and carries the word, because failure is
 *   never hue alone (WCAG 1.4.1). In {@link FailedSpan} the failed row is 64ms
 *   inside a 100s session, which is the case where the floor is the only reason
 *   it is on screen at all.
 * - The CRITICAL PATH marks the row with a spine at a fixed left edge rather
 *   than outlining the bar, so the chain joins up down the rows. Whether it
 *   actually reads as a chain is a geometry question.
 *
 * {@link UnsourcedColumns} and {@link MeasuredAndInferredExtents} are the two
 * halves of the `SessionTraceColumns` gate: a column with no producer anywhere
 * on the session states that once in its header by not existing, while a column
 * some rows report keeps the numeric slot and an individual gap says it was not
 * recorded (PRD-753 R9).
 *
 * The ruler is rendered above the rows in every story because production always
 * pairs them, and because the hatch key lives in the ruler while the hatch
 * itself lives in the rows — reviewing either alone cannot catch them drifting
 * apart.
 */

/** The header the footprint column shows only when some row reports one. */
const FOOTPRINT_HEADER = "Footprint";
/** The header the turn-token column shows only when some row reports one. */
const TURN_TOKENS_HEADER = "Tokens in";
/** The per-cell gap sentence, for a column that IS sourced on other rows. */
const CELL_NOT_RECORDED = "not recorded";

const ALL_COLUMNS = { footprintSourced: true, turnTokensSourced: true };
const NO_COLUMNS = { footprintSourced: false, turnTokensSourced: false };

/** A phone viewport, where the name gutter narrows and both number cells drop. */
const PHONE_VIEWPORT = "390-844";

/** The window every story opens on: the whole session, from the origin. */
const WHOLE_SESSION_TO_MS = 100_001;

/**
 * A 100s measured root holding a 99s measured child and a hook that recorded
 * only a start instant, so its extent is inferred from the parent's close.
 *
 * The root and the long child are the longest chain, so the derivation marks
 * them as the critical path and leaves the hook off it.
 */
function measuredAndInferredRows(): readonly SessionTraceInvocation[] {
  return [
    traceInvocation("root", 0, {
      componentKey: "Task",
      kind: AgentComponentInvocationKind.Subagent,
      durationMs: 100_000,
      succeeded: true,
      footprintTokens: 9600,
      inputTokens: 18_400,
    }),
    traceInvocation("long", 100, {
      componentKey: "Bash",
      parentExternalInvocationId: "root",
      durationMs: 99_000,
      succeeded: true,
      footprintTokens: 4200,
      inputTokens: 1500,
    }),
    traceInvocation("hook", 99_200, {
      componentKey: "PreToolUse",
      kind: AgentComponentInvocationKind.Hook,
      parentExternalInvocationId: "root",
      succeeded: true,
    }),
  ];
}

/**
 * The same session plus a measured 64ms hook, mid-window, that failed.
 *
 * Mid-window on purpose: the failure floor can never push a bar past the
 * window's right edge, so a failure in the last second of a 100s session is
 * clamped by the edge rather than by the floor and proves nothing about it.
 */
function failedRows(): readonly SessionTraceInvocation[] {
  return [
    ...measuredAndInferredRows(),
    traceInvocation("failed-hook", 50_000, {
      componentKey: "PostToolUse",
      kind: AgentComponentInvocationKind.Hook,
      parentExternalInvocationId: "root",
      durationMs: 64,
      succeeded: false,
    }),
  ];
}

function spansOf(rows: readonly SessionTraceInvocation[]): SessionTraceSpan[] {
  return flattenSpans(buildSessionTrace(rows).roots);
}

const MEASURED_AND_INFERRED_SPANS = spansOf(measuredAndInferredRows());
const FAILED_SPANS = spansOf(failedRows());

const meta = {
  title: "Composites/Artifacts/Sessions/Session Detail/Session Trace Chart",
  component: SessionTraceChartRows,
  tags: ["stable", "autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    // `spans` is the derived tree `buildSessionTrace` produces from the shared
    // invocation fixture. An editable object control would let a reviewer hand
    // the chart a shape the derivation cannot produce, so the extent/failure/
    // critical-path axes are stories rather than controls.
    spans: { control: false },
    onSelect: { control: false },
    selectedId: { control: { type: "text" } },
    windowFromMs: { control: { type: "number" } },
    windowToMs: { control: { type: "number" } },
  },
  args: {
    onSelect: fn(),
    selectedId: null,
    windowFromMs: 0,
    windowToMs: WHOLE_SESSION_TO_MS,
  },
  render: (args) => (
    <div className="overflow-hidden rounded-md border border-border">
      <SessionTraceChartRuler
        columns={args.columns}
        totalMs={args.spans.reduce((max, span) => Math.max(max, span.endMs), 0)}
        windowFromMs={args.windowFromMs}
        windowToMs={args.windowToMs}
      />
      <SessionTraceChartRows {...args} />
    </div>
  ),
} satisfies Meta<typeof SessionTraceChartRows>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shipped shape: two solid bars whose width is latency, and one hatched bar
 * whose width is only "it had not yet given way to the parent's close".
 *
 * Read the hook's bar against the ruler's key at the top left — they are the
 * same gradient from the same helper, and the key stops being one the moment
 * they diverge. Read the two solid bars against the hatched one for the thing
 * the hatch exists to prevent: an upper bound being taken for a measurement.
 *
 * Both columns are sourced here, so the hook — which reports neither population
 * — shows the per-cell gap rather than a zero. A zero in that slot would be a
 * measurement nothing made.
 */
export const MeasuredAndInferredExtents: Story = {
  args: { spans: MEASURED_AND_INFERRED_SPANS, columns: ALL_COLUMNS },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bars = canvasElement.querySelectorAll<HTMLElement>(
      'span[aria-hidden="true"][style*="width"]'
    );
    const hatched = [...bars].filter((bar) =>
      bar.getAttribute("style")?.includes("repeating-linear-gradient")
    );
    // One hatched bar for the one inferred span. The two measured bars must not
    // pick the hatch up, and the ruler's key must not lose it — one number
    // covers both regressions.
    expect(hatched).toHaveLength(1);
    expect(
      canvas.getByText(
        SESSION_TRACE_EXTENT_LABEL[SessionTraceExtentSource.Inferred]
      )
    ).toBeVisible();
    expect(canvas.getByText(FOOTPRINT_HEADER)).toBeVisible();
    expect(canvas.getByText(TURN_TOKENS_HEADER)).toBeVisible();
    // Both of the hook's cells, since it reports neither population.
    expect(canvas.getAllByText(CELL_NOT_RECORDED)).toHaveLength(2);
  },
};

/**
 * A window the spans do not reach. The chart says so in a sentence that names
 * both ways out, instead of rendering an empty list — an empty list under a
 * populated ruler reads as "this session has no spans", which is a different
 * and false claim.
 */
export const EmptyWindow: Story = {
  args: {
    spans: [],
    columns: ALL_COLUMNS,
    windowFromMs: 500_000,
    windowToMs: 600_000,
  },
};

/**
 * A measured 64ms hook, half way through a 100s session, that failed. Its bar
 * takes the destructive fill and holds the 1.2% floor, so a third of a pixel is
 * still findable — the whole point of the row is that it failed, and a bar too
 * small to see says the opposite.
 *
 * Failure is not carried by the fill alone: the row gains an alert glyph beside
 * its name and the word closes its accessible name. Those are what the render
 * has to keep — a red bar on its own is not separable from the seven kind hues
 * for a reader with a colour-vision deficiency (WCAG 1.4.1).
 *
 * The late inferred hook is still in this tree, so one render carries both the
 * hatch and the failure fill and shows that neither borrows the other's
 * vocabulary.
 */
export const FailedSpan: Story = {
  args: { spans: FAILED_SPANS, columns: ALL_COLUMNS },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const failedRow = canvas.getByText("PostToolUse").closest("button");
    const bar = failedRow?.querySelector<HTMLElement>(
      'span[aria-hidden="true"][style*="width"]'
    );
    expect(bar?.getAttribute("style")).toContain("var(--destructive)");
    // The floor, not the measured width: 64ms of 100s is 0.064%.
    expect(Number.parseFloat(bar?.style.width ?? "0")).toBeCloseTo(1.2, 5);
    // The word, in the row's own statement for assistive tech.
    expect(failedRow?.textContent).toContain("failed");
  },
};

/**
 * The critical path, as the rows draw it: a spine at the left edge of the root
 * and the long child, and nothing on the hook.
 *
 * This is a geometry claim. The spine is 2px at a FIXED left edge precisely so
 * consecutive marked rows join into one stroke the eye can follow down the
 * tree; if it ever drifts with indentation, or the two marked rows stop reading
 * as one line, the lens has lost the only thing it adds over comparing widths.
 */
export const CriticalPathChain: Story = {
  args: { spans: MEASURED_AND_INFERRED_SPANS, columns: NO_COLUMNS },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const key of ["Task", "Bash"]) {
      expect(canvas.getByText(key).closest("button")?.textContent).toContain(
        "on the critical path"
      );
    }
    expect(
      canvas.getByText("PreToolUse").closest("button")?.textContent
    ).not.toContain("on the critical path");
  },
};

/**
 * The same session with no producer for either telemetry population, which is
 * every session until ISS-10718 widens the read row.
 *
 * Both columns are GONE rather than full of dashes. Five hundred identical
 * dashes read as "each of these happens to be blank"; an absent column reads as
 * "this session has no source for it", which is the true statement. Compare the
 * header row against {@link MeasuredAndInferredExtents}: the extent column and
 * the name gutter are unchanged, and the space the two numeric columns held
 * goes back to the time axis rather than leaving a gap.
 */
export const UnsourcedColumns: Story = {
  args: { spans: MEASURED_AND_INFERRED_SPANS, columns: NO_COLUMNS },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByText(FOOTPRINT_HEADER)).not.toBeInTheDocument();
    expect(canvas.queryByText(TURN_TOKENS_HEADER)).not.toBeInTheDocument();
    // And no per-cell gap sentence either: there is no column to put one in.
    expect(canvas.queryByText(CELL_NOT_RECORDED)).not.toBeInTheDocument();
  },
};

/**
 * A 390px phone. The name gutter drops from 240px to 144px, both numeric
 * columns leave with their headers, and the time axis keeps whatever is left —
 * which is where the ruler's own tick-dropping rule earns its place, since two
 * timestamps closer than 76px apart smear into one unreadable mark.
 *
 * Watch the truncation in the name gutter and the last tick at the right edge:
 * it is translated fully left of its own position, so if it ever wraps it
 * stacks two lines of axis over the chart.
 */
export const NarrowWidth: Story = {
  args: { spans: FAILED_SPANS, columns: ALL_COLUMNS },
  globals: { viewport: { value: PHONE_VIEWPORT } },
  decorators: [phoneColumn()],
};

/** Constrains the chart to a phone column, the way the detail pane hands it one. */
function phoneColumn(): Decorator {
  return (Story) => (
    <div className="mx-auto w-[358px]">
      <Story />
    </div>
  );
}
