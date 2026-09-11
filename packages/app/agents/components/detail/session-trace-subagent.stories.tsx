import { AgentComponentInvocationAnchorKind } from "@repo/api/src/types/agent-component-invocation";
import type {
  SubagentBodyLine,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { expect, userEvent, within } from "storybook/test";
import { createAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import { SessionTraceSubagent } from "./session-trace-subagent";

/**
 * ISS-5698: the collapsed sub-agent box, isolated.
 *
 * The whole design of this row is a set of things it REFUSES to show, and every
 * one of them is invisible on a canvas that only renders the happy path: a
 * chevron does not appear when there is no transcript behind it, an event count
 * does not appear when the only body lines are the projection's own synthetic
 * framing, and a meta row does not appear when no part of it has a value. Each
 * of those is a real regression that reads as "nothing changed" in a screenshot
 * of the populated fixture, which is why they are one story each below.
 *
 * The rows come from `createAgentSessionDetailFixture` rather than a hand-built
 * item, so the default story is the same sub-agent the detail-view stories and
 * the projection tests render — a story whose fixture drifts from theirs stops
 * describing the same sub-agent.
 */

/** The trace turn variant this row renders. Declared locally because the
 *  component keeps its own copy of the same `Extract` private. */
type SubagentItem = Extract<TurnItem, { type: "subagent" }>;

/**
 * The fixture's sub-agent turn, with overrides. Every story starts from the
 * shared row — a failed "Review lane (review)" with an 8m duration and a
 * three-line body — so a scenario says only what it changes.
 */
function subagentItem(overrides: Partial<SubagentItem> = {}): SubagentItem {
  const item = createAgentSessionDetailFixture().turnItems?.find(
    (turn): turn is SubagentItem => turn.type === "subagent"
  );
  if (!item) {
    throw new Error(
      "createAgentSessionDetailFixture no longer carries a subagent turn item"
    );
  }
  return { ...item, ...overrides };
}

/** The instant the fixture's sub-agent run starts, so every synthesized body
 *  line sits on the same clock as the row it hangs under. */
const RUN_START_MS = Date.parse("2026-06-10T12:04:00.000Z");

/** One real activity line: it carries a timestamp, so `countSubagentEvents`
 *  counts it. */
function eventLine(text: string, index: number): SubagentBodyLine {
  return {
    kind: "tool",
    t: new Date(RUN_START_MS + index * 1000).toISOString(),
    text,
  };
}

/**
 * Accessible-name matchers for the collapsed heads. The head concatenates an
 * sr-only kind prefix, the label, the event count, and the meta row into one
 * name, so each of these is a substring match on the part that identifies the
 * run. Module-level because Ultracite's `useTopLevelRegex` forbids the literals
 * inline.
 */
const REVIEW_LANE_HEAD = /Review lane/;
const UI_CHECKER_HEAD = /Rendered UI checker/;
const UNNAMED_HEAD = /Sub-agent/;
const LOGICAL_QA_HEAD = /Logical QA sweep/;
const MIGRATION_HEAD = /Bulk migration lane/;

/** The transcript of a run still in flight: the task descriptor plus the
 *  synthetic `currentTool` line the projection prepends. Neither carries a
 *  timestamp, so neither is a real event. */
const RUNNING_BODY: SubagentBodyLine[] = [
  { kind: "task", text: "Capture Storybook screenshots for the detail pane." },
  { kind: "tool", text: "playwright" },
];

/** A clean run: task, three real tool events, and the terminal status marker. */
const COMPLETED_BODY: SubagentBodyLine[] = [
  {
    kind: "task",
    text: "Verify the Properties pane reconciles with the trace.",
  },
  eventLine("rg", 0),
  eventLine("read packages/app/agents/components/detail", 1),
  eventLine("vitest --run session-output-diff", 2),
  {
    kind: "status",
    t: "2026-06-10T12:17:00.000Z",
    text: "completed",
  },
];

/** A busy run, long enough that the box has to stay one scannable line while
 *  collapsed and stay readable once opened. */
const LONG_BODY: SubagentBodyLine[] = [
  {
    kind: "task",
    text: "Sweep every Sessions surface for values that disagree with the table beneath them, and report without editing anything.",
  },
  ...Array.from({ length: 14 }, (_entry, index) =>
    eventLine(
      `rg --json 'lastAgentSessionSyncAttemptAt' packages/app/agents/components/detail --glob '!*.test.*' (pass ${index + 1})`,
      index
    )
  ),
  {
    kind: "event",
    t: "2026-06-10T12:19:00.000Z",
    err: true,
    text: "Aggregate on the KPI card does not reconcile with the rows below it.",
  },
];

/** A four-digit count, to pin the thousands grouping in the collapsed label. */
const HIGH_COUNT_BODY: SubagentBodyLine[] = Array.from(
  { length: 1204 },
  (_entry, index) => eventLine(`bash step ${index}`, index)
);

/** The agent this run is projected from, on both sides of the anchor match. */
const ANCHORED_AGENT_ID = "agent-review";

/** The attribute the trace scrolls to when an Agent Components invocation deep
 *  links into the transcript. */
const ANCHOR_TARGET_SELECTOR = "[data-invocation-anchor-target='true']";

/** Production ancestry: `session-trace.tsx` renders every sub-agent box inside
 *  the trace's `.st` root, and `styles.css` scopes the monospace face as
 *  `.st .mono` — the face the duration/cost meta row is drawn in. */
function TraceFrame({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="st">{children}</div>;
}

/**
 * A collapsed one line summary for a sub agent a session delegated to, its
 * name, event count, duration and cost, so it doesn't expand the trace until
 * clicked.
 */
const meta = {
  title: "Primitives/Data Display/Session Trace Subagent",
  component: SessionTraceSubagent,
  tags: ["autodocs"],
  argTypes: {
    invocationAnchor: { control: "object" },
    item: { control: "object" },
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <TraceFrame>
        <Story />
      </TraceFrame>
    ),
  ],
} satisfies Meta<typeof SessionTraceSubagent>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shipped default: one line per sub-agent, closed. Name and type, the event
 * count, the duration — and nothing else, because the point of the box is that a
 * delegating session's trace does not inflate by a whole sub-transcript per
 * delegation.
 *
 * The fixture's body carries exactly one timestamped activity line, so this also
 * pins the SINGULAR label: "(1 event)", not "(1 events)".
 */
export const Collapsed: Story = {
  args: { item: subagentItem() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const head = canvas.getByRole("button", { name: REVIEW_LANE_HEAD });
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await expect(head).toHaveTextContent("(1 event)");
    await expect(canvas.queryByText("gpt-5.5")).toBeNull();
  },
};

/**
 * The same row opened. Two things arrive that the collapsed line deliberately
 * withholds: the model, kept out of the summary to keep it scannable but
 * preserved here so the datum is not lost, and the body lines — with the failed
 * `vitest` call and the terminal `failed` marker in the destructive colour.
 */
export const Expanded: Story = {
  args: { item: subagentItem() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const head = canvas.getByRole("button", { name: REVIEW_LANE_HEAD });
    await userEvent.click(head);
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText("gpt-5.5")).toBeVisible();
    await expect(canvas.getByText("vitest")).toBeVisible();
    await expect(canvas.getByText("failed")).toBeVisible();
  },
};

/**
 * A clean run, opened, so the error treatment above has something to be read
 * against: same box, same body shapes, nothing in the destructive colour. Its
 * meta row carries duration AND cost, which the failed fixture does not, so this
 * is also where the ` · ` separator actually appears.
 */
export const CompletedRun: Story = {
  args: {
    item: subagentItem({
      body: COMPLETED_BODY,
      cost: "$0.42",
      duration: "9m",
      status: "completed",
      sub: "Rendered UI checker",
      subagentType: "visual",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const head = canvas.getByRole("button", { name: UI_CHECKER_HEAD });
    await expect(head).toHaveTextContent("(3 events)");
    await userEvent.click(head);
    await expect(canvas.getByText("completed")).toBeVisible();
  },
};

/**
 * REGRESSION GUARD (FEA-3416). A run still in flight has a body — the task
 * descriptor and the synthetic `currentTool` line the projection prepends — but
 * neither is a real turn, and neither carries a timestamp. The count label is
 * omitted entirely rather than rendered as a misleading "(0 events)".
 *
 * The two lines are still real content, so the disclosure stays: this is the
 * distinction between "nothing happened yet" and "nothing to show", and the box
 * has to make it without claiming a measurement it does not have.
 */
export const SyntheticLinesAreNotEvents: Story = {
  args: {
    item: subagentItem({
      body: RUNNING_BODY,
      cost: null,
      duration: null,
      status: "running",
      sub: "Rendered UI checker",
      subagentType: "visual",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const head = canvas.getByRole("button", { name: UI_CHECKER_HEAD });
    await expect(head).not.toHaveTextContent("event");
  },
};

/**
 * The body-less row (FEA-4178) — every row on a branch merged trace, whose lean
 * item carries no transcript at all. There is nothing behind the disclosure, so
 * there IS no disclosure: no chevron, no button, no hover lift.
 *
 * The play asserts the affordance is absent, which is the entire behavior. A
 * chevron here would promise a transcript and open onto "No transcript
 * captured." — an affordance that lies about what it holds.
 */
export const NoTranscriptStaticHead: Story = {
  args: {
    item: subagentItem({
      body: [],
      cost: "$0.20",
      duration: "3m",
      status: "completed",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
    await expect(canvasElement).toHaveTextContent("Review lane (review)");
    await expect(canvasElement).not.toHaveTextContent("event");
  },
};

/**
 * Nothing measured: no duration, no cost, and `tokens` — which is always null,
 * because no per-sub-agent token source exists. `buildSubagentMetaParts` returns
 * an empty list and the meta row is dropped whole, so the ` · ` separator never
 * renders as a dangling divider after the event count.
 */
export const NoMetaRow: Story = {
  args: {
    item: subagentItem({ cost: null, duration: null, tokens: null }),
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement).not.toHaveTextContent("·");
  },
};

/**
 * The cost part, which is the one figure on this row that could overpromise.
 * It is attributed by timestamp overlap with the main-agent turns, not metered
 * per sub-agent, so a bare `$0.20` would read as a measured number. The part
 * carries a hover title naming the attribution, and takes full `--foreground`
 * contrast to match the session-level gutter cost rather than sitting flat-muted
 * beside it.
 */
export const AttributedCost: Story = {
  args: { item: subagentItem({ cost: "$0.20", duration: "8m" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("$0.20")).toHaveAttribute(
      "title",
      "Cost attributed to this sub-agent"
    );
  },
};

/**
 * An invocation with no resolved name — the fallback label, which is also the
 * sr-only prefix the row already announces before its name. With `sub` empty and
 * `subagentType` absent there is no parenthetical either, so the head reads
 * "Sub-agent" once rather than "Sub-agent (null)".
 */
export const UnnamedInvocation: Story = {
  args: { item: subagentItem({ sub: "", subagentType: null }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: UNNAMED_HEAD })
    ).toBeVisible();
  },
};

/**
 * Deep-linked from the Agent Components tab. When the invocation anchor matches
 * this row's transcript identity the box opens WITHOUT a click and marks itself
 * as the scroll target, so arriving from a component's invocation list lands on
 * the transcript rather than on a closed summary the reader has to hunt for.
 *
 * Note that `open` is `anchored || userOpen`: while anchored the disclosure
 * cannot be closed, and the chevron's toggle only banks a preference that takes
 * effect once the anchor moves on.
 */
export const AnchoredByInvocation: Story = {
  args: {
    invocationAnchor: {
      kind: AgentComponentInvocationAnchorKind.Agent,
      agentId: ANCHORED_AGENT_ID,
    },
    item: subagentItem({
      transcriptIdentity: {
        agentId: ANCHORED_AGENT_ID,
        externalAgentId: ANCHORED_AGENT_ID,
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: REVIEW_LANE_HEAD })
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      canvasElement.querySelector(ANCHOR_TARGET_SELECTOR)
    ).not.toBeNull();
  },
};

/**
 * A long run, opened: fifteen body lines, a task descriptor that wraps, and a
 * failed event at the end. This is the density the box is actually asked to
 * survive, and the case where "one scannable line per sub-agent" either holds or
 * quietly stops holding.
 */
export const LongTranscript: Story = {
  args: {
    item: subagentItem({
      body: LONG_BODY,
      cost: "$3.18",
      duration: "41m",
      sub: "Logical QA sweep",
      subagentType: "logical-qa",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const head = canvas.getByRole("button", { name: LOGICAL_QA_HEAD });
    await expect(head).toHaveTextContent("(15 events)");
    await userEvent.click(head);
    await expect(head).toHaveAttribute("aria-expanded", "true");
  },
};

/**
 * A four-digit event count, left CLOSED on purpose: the count is grouped
 * (`toLocaleString`), so this is where "(1204 events)" would be caught. It also
 * shows the box doing its actual job — a run this size stays one line until
 * asked, which is the entire argument for the collapsed summary.
 */
export const HighEventCount: Story = {
  args: {
    item: subagentItem({
      body: HIGH_COUNT_BODY,
      cost: "$18.40",
      duration: "2h 14m",
      sub: "Bulk migration lane",
      subagentType: "migrate",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: MIGRATION_HEAD })
    ).toHaveTextContent("(1,204 events)");
  },
};
