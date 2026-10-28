import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, within } from "storybook/test";
import {
  buildSessionTrace,
  flattenSpans,
} from "../../../lib/session-trace/build-session-trace";
import {
  SESSION_TRACE_KIND_LABEL,
  SESSION_TRACE_KIND_ORDER,
  type SessionTraceSpan,
} from "../../../lib/session-trace/session-trace-node";
import { traceInvocation } from "./__tests__/session-trace-span-fixtures";
import {
  SessionTraceFocusTrail,
  SessionTraceToolbar,
} from "./session-trace-toolbar";

/**
 * ISS-10737 — the toolbar IS the chart's key, so its states are the vocabulary.
 *
 * Nothing in the chart spells a kind: the rows carry it by colour alone, by the
 * explicit operator decision in DOC-37 section 5. What makes that legible is
 * this row of chips — a blue Subagent chip beside blue bars teaches the mapping
 * with nothing to look up, the critical-path chip wears the same 2px spine the
 * marked rows draw, and the Errors chip wears the destructive fill a failed bar
 * takes. A separate seven-swatch legend would restate all of it in a block
 * nobody operates, and the vocabulary would then have two places to drift in.
 *
 * Which makes the ON/OFF pair the load-bearing render here, and the reason
 * {@link KindsFiltered} exists: a filtered-off chip KEEPS its marker, because
 * the marker is the key and a key that empties out as you hide kinds stops being
 * one. What carries the state is the chip around it — tinted with a solid edge
 * is showing, hollow with a dashed edge is not. Those two must not read as two
 * brightnesses of the same thing, and they must survive greyscale, since seven
 * of them sit in one row.
 *
 * The failure chip has THREE states and they are three different sentences,
 * split across {@link EveryLensOff}, {@link ErrorsOnlyOn} and
 * {@link FailuresNotRecorded}. The third is the one that matters: with
 * `succeeded` unread on every row, "Errors 0" would be a measurement nothing
 * made — exactly the quietly-low number DOC-37 section 10 warns about — so the
 * chip says so in words and is inert rather than a filter, because there is
 * nothing to filter to.
 *
 * {@link ZoomControlsDisabled} pins the other half of the keyboard contract:
 * every zoom gesture has a button, and a button whose precondition is unmet is
 * disabled rather than absent, so the control's existence is not itself a
 * state signal.
 */

const ALL_KINDS = SESSION_TRACE_KIND_ORDER;

/** A phone viewport, where the chips wrap and the zoom buttons drop to icons. */
const PHONE_VIEWPORT = "390-844";

/** The session's failure count, carried by the chip in {@link EveryLensOff}. */
const ERROR_COUNT = 3;
/** The failure chip's own name, count included, for the sourced states. */
const ERRORS_CHIP_NAME = new RegExp(`Errors ${ERROR_COUNT}`);
/**
 * Any failure chip at all — used only to assert that the UNSOURCED state has
 * none, so it must stay broader than {@link ERRORS_CHIP_NAME}.
 */
const ANY_ERRORS_CHIP_NAME = /Errors/;

/** A root, a subagent beneath it, and the tool that subagent ran. */
function trailSpans(): readonly SessionTraceSpan[] {
  return flattenSpans(
    buildSessionTrace([
      traceInvocation("root", 0, {
        componentKey: "Task",
        kind: AgentComponentInvocationKind.Subagent,
        durationMs: 40_000,
      }),
      traceInvocation("review", 1000, {
        componentKey: "code-review",
        kind: AgentComponentInvocationKind.Skill,
        parentExternalInvocationId: "root",
        durationMs: 30_000,
      }),
      traceInvocation("bash", 2000, {
        componentKey: "Bash",
        parentExternalInvocationId: "review",
        durationMs: 20_000,
      }),
    ]).roots
  );
}

const TRAIL_SPANS = trailSpans();

const meta = {
  title: "Composites/Artifacts/Sessions/Session Detail/Session Trace Toolbar",
  component: SessionTraceToolbar,
  tags: ["stable", "autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    activeKinds: {
      control: { type: "multi-select" },
      options: ALL_KINDS,
      labels: SESSION_TRACE_KIND_LABEL,
    },
    errorCount: { control: { type: "number", min: 0 } },
    criticalPathOnly: { control: { type: "boolean" } },
    errorsOnly: { control: { type: "boolean" } },
    failureStateSourced: { control: { type: "boolean" } },
    canZoomToSpan: { control: { type: "boolean" } },
    isZoomed: { control: { type: "boolean" } },
    onToggleKind: { control: false },
    onToggleErrorsOnly: { control: false },
    onToggleCriticalPath: { control: false },
    onZoomToSpan: { control: false },
    onZoomOut: { control: false },
    onFit: { control: false },
  },
  args: {
    activeKinds: ALL_KINDS,
    criticalPathOnly: false,
    errorsOnly: false,
    errorCount: ERROR_COUNT,
    failureStateSourced: true,
    canZoomToSpan: true,
    isZoomed: true,
    onToggleKind: fn(),
    onToggleErrorsOnly: fn(),
    onToggleCriticalPath: fn(),
    onZoomToSpan: fn(),
    onZoomOut: fn(),
    onFit: fn(),
  },
} satisfies Meta<typeof SessionTraceToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Every kind showing, no lens narrowed, three failures on the session and a span
 * selected so all three zoom controls are live.
 *
 * This is the key at rest, and the render to judge the seven hues against each
 * other on: they are one row of chips at 10px of colour each, so if two of them
 * stop being separable here they are not separable in the bars either. The tint
 * is deliberately 20% of the accent rather than the accent itself — seven
 * saturated fills would out-shout the chart they are a key to.
 */
export const EveryLensOff: Story = {
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Seven kind chips, each pressed, plus the critical-path chip unpressed and
    // the errors chip unpressed.
    for (const kind of ALL_KINDS) {
      expect(
        canvas.getByRole("button", { name: SESSION_TRACE_KIND_LABEL[kind] })
      ).toHaveAttribute("aria-pressed", "true");
    }
    expect(canvas.getByText(`Errors ${ERROR_COUNT}`)).toBeVisible();
  },
};

/**
 * Two kinds showing, five hidden. The five hollow dashed chips keep their
 * markers at full strength, which is the point: the reader is still being told
 * what each colour means while being told that colour is currently out.
 *
 * Read the two states against each other rather than individually. A dashed
 * hollow chip and a tinted solid one have to be distinguishable at a glance and
 * in greyscale; an "off" state that reads as a dimmer "on" means the reader
 * cannot tell what the chart is hiding, and the chart is then quietly
 * incomplete.
 */
export const KindsFiltered: Story = {
  args: {
    activeKinds: [
      AgentComponentInvocationKind.Command,
      AgentComponentInvocationKind.Subagent,
    ],
  },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByRole("button", {
        name: SESSION_TRACE_KIND_LABEL[AgentComponentInvocationKind.Subagent],
      })
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      canvas.getByRole("button", {
        name: SESSION_TRACE_KIND_LABEL[AgentComponentInvocationKind.Hook],
      })
    ).toHaveAttribute("aria-pressed", "false");
  },
};

/**
 * The errors-only lens engaged. The chip takes the destructive tint a failed bar
 * is filled with, and reports `aria-expanded` as well as `aria-pressed` because
 * it is narrowing the rows below it rather than toggling an ornament.
 *
 * The count is never dismissable (DOC-37 section 6): it stays on screen in both
 * states, so turning the lens off cannot make the failures look like they went
 * away.
 */
export const ErrorsOnlyOn: Story = {
  args: { errorsOnly: true },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole("button", { name: ERRORS_CHIP_NAME });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveAttribute("aria-expanded", "true");
  },
};

/**
 * No row on this session reports success or failure, which is every session
 * until ISS-10718 widens the read row. The chip states the absence in words and
 * is inert — not a button, not pressable, no count.
 *
 * Compare it against {@link EveryLensOff}. "Errors 0" in that slot would read as
 * a measurement and get acted on; this reads as "we did not look", which is the
 * true statement. The dashed border is the same vocabulary an off filter uses,
 * which is right here too: nothing is being shown.
 */
export const FailuresNotRecorded: Story = {
  args: { failureStateSourced: false, errorCount: 0 },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Failures not recorded")).toBeVisible();
    // Inert: the slot holds a statement, not a filter.
    expect(
      canvas.queryByRole("button", { name: ANY_ERRORS_CHIP_NAME })
    ).toBeNull();
  },
};

/**
 * The critical-path lens engaged, carrying the row's own spine at the chip's
 * left edge — same width, same token, so the chain the lens narrows to is
 * recognisable by shape before it is read.
 *
 * The spine is the only marker here that is a line rather than a patch, and it
 * sits inside an `overflow-hidden` chip at `inset-y-0`, so this is the render
 * that shows whether it still reaches both edges once the chip is tinted.
 */
export const CriticalPathOnlyOn: Story = {
  args: { criticalPathOnly: true },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByRole("button", { name: "Critical path only" })
    ).toHaveAttribute("aria-pressed", "true");
  },
};

/**
 * Nothing selected and the window already fitted, so two of the three zoom
 * controls have unmet preconditions: there is no span to zoom to, and no zoom
 * to leave. They are DISABLED rather than hidden — a control that disappears
 * when it cannot act makes its own absence a state the reader has to decode,
 * and the toolbar's layout shifts under them while they do.
 *
 * "Zoom out" stays live, because widening past the current window is always
 * something the reader can ask for.
 */
export const ZoomControlsDisabled: Story = {
  args: { canZoomToSpan: false, isZoomed: false },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("button", { name: "Zoom to span" })).toBeDisabled();
    expect(
      canvas.getByRole("button", { name: "Fit the whole session" })
    ).toBeDisabled();
    expect(canvas.getByRole("button", { name: "Zoom out" })).toBeEnabled();
  },
};

/**
 * A 390px phone. The "Show" caption and every zoom button's text label drop,
 * leaving the icons with their full names on `aria-label` (WCAG 4.1.2), and the
 * critical-path chip loses its trailing word.
 *
 * This is the crowding story. The toolbar is pinned inside the scrolling pane,
 * so every line it wraps to is a line of chart the reader does not get — nine
 * controls over two lines is the budget, and a third line is a regression.
 */
export const NarrowWidth: Story = {
  globals: { viewport: { value: PHONE_VIEWPORT } },
};

/**
 * The focus trail, the toolbar file's second export and the way back out of a
 * focused subtree. Every ancestor is a live step, not a label, so a reader three
 * levels in can leave at any level instead of only all the way out.
 *
 * It renders through this meta's story type rather than its own file because the
 * two ship together above the chart; the toolbar args below are inherited and
 * unused by it.
 */
export const FocusTrail: Story = {
  render: () => (
    <SessionTraceFocusTrail
      focused={TRAIL_SPANS[2]}
      onClearFocus={fn()}
      onFocusSpan={fn()}
      trail={TRAIL_SPANS.slice(0, 2)}
    />
  ),
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("navigation", { name: "Focused subtree" }));
    // Two ancestors as live steps, and the focused span as the current page
    // rather than a third button.
    expect(canvas.getByRole("button", { name: "Task" })).toBeEnabled();
    expect(canvas.getByRole("button", { name: "code-review" })).toBeEnabled();
    expect(canvas.queryByRole("button", { name: "Bash" })).toBeNull();
  },
};
