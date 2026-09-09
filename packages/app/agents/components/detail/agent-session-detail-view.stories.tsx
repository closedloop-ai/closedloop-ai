import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { expect } from "storybook/test";
import {
  SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY,
  SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
} from "../../../shared/lib/feature-flags";
import {
  columnHitTargetAgentSessionDetailFixture,
  createAgentSessionDetailFixture,
  emptyAgentsAgentSessionDetailFixture,
  errorChainAgentSessionDetailFixture,
  idleJumpTargetsAgentSessionDetailFixture,
  longContentAgentSessionDetailFixture,
  noErrorAgentSessionDetailFixture,
  nullDateAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
  truncatedEventsAgentSessionDetailFixture,
  truncatedEventsWithTranscriptAgentSessionDetailFixture,
  unknownStateAgentSessionDetailFixture,
} from "./agent-session-detail-fixtures";
import { SessionDetailErrorKind } from "./agent-session-detail-states";
import { AgentSessionDetailView } from "./agent-session-detail-view";

/**
 * ISS-5697: the full-height page frame, declared once. `.storybook/preview.tsx`
 * mounts the app-core harness globally (ISS-5665), so a story that needs a flag
 * sets `parameters.appCore.enabledFlags` instead of re-wrapping itself — six
 * copies of this same frame is what that pattern had grown into.
 */
const detailViewDecorator: Decorator = (Story) => (
  <div className="flex h-screen min-h-0 flex-col bg-background">
    <Story />
  </div>
);

const meta: Meta<typeof AgentSessionDetailView> = {
  title: "App Core/Agents/Session Detail",
  component: AgentSessionDetailView,
  args: { commentsRailOpen: true, isError: false },
  argTypes: {
    session: { control: "object", table: { category: "Data" } },
    isLoading: { control: "boolean", table: { category: "State" } },
    isError: {
      control: "boolean",
      description: "The read settled to a failure rather than an empty result.",
      table: { category: "State" },
    },
    errorKind: {
      control: { type: "radio" },
      options: Object.values(SessionDetailErrorKind),
      description: "Only consulted when isError is set and no session arrived.",
      table: { category: "State" },
    },
    commentsRailOpen: { control: "boolean", table: { category: "State" } },
    artifactHrefPending: {
      control: "boolean",
      description:
        "True while the shell cannot yet say whether artifact links resolve.",
      table: { category: "State" },
    },
    transcriptFileKey: {
      control: "text",
      description:
        "Transcript the conversation region renders: main, or a subagent:{id} sidechain.",
      table: { category: "Content" },
    },
    invocationAnchor: { control: "object", table: { category: "Content" } },
    backHref: { control: "text", table: { category: "Routing" } },
    buildTranscriptFileHref: { control: false, table: { category: "Routing" } },
    buildArtifactHref: { control: false, table: { category: "Routing" } },
    getBranchHref: { control: false, table: { category: "Routing" } },
  },
  parameters: {
    layout: "fullscreen",
  },
  decorators: [detailViewDecorator],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: {
    backHref: "/sessions",
    isLoading: true,
  },
};

export const NotFound: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
  },
};

/**
 * The Session detail page as it ships: the title row carries the session's
 * status chip beside the `h1` at the prototype's `text-2xl` size (a sibling,
 * never part of the heading, so the heading still names the session and not its
 * state); Properties sits ABOVE the Timeline, identity first and cost chart
 * second, and the collapsed strip below it does not restate status; only the
 * Timeline is pinned, so the title and Properties scroll away; and Timeline,
 * Trace and Comments are real `h2`s, with Timeline and Trace inside named
 * `section[aria-labelledby]` landmarks that CONTAIN their sections.
 *
 * ISS-5999 retired the `sessions-detail-prototype-parity` gate, so this is now
 * every story in this file rather than one flag-ON variant — which is why the
 * outline assertions that used to live on that variant moved here.
 */
export const PopulatedHierarchyTimeline: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
  play: ({ canvasElement }) => {
    // A screenshot cannot diff a landmark. Assert the two things the retired
    // gate was responsible for: the real heading, and the landmark that actually
    // contains its section.
    const trace = Array.from(canvasElement.querySelectorAll("h2")).find(
      (node) => node.textContent?.trim() === "Session Trace"
    );
    expect(trace).toBeDefined();
    expect(trace?.closest("section[aria-labelledby]")).not.toBeNull();
  },
};

export const TraceCommentTarget: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
};

export const DesktopShellTraceCommentTarget: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
  render: (args) => (
    <div className="flex h-screen min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <AgentSessionDetailView {...args} />
    </div>
  ),
};

export const PopulatedToolFlowInitialTab: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
};

export const PopulatedEffectivenessInitialTab: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
};

export const EmptyAgents: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: emptyAgentsAgentSessionDetailFixture,
  },
};

export const NoError: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: noErrorAgentSessionDetailFixture,
  },
};

export const ErrorChain: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: errorChainAgentSessionDetailFixture,
  },
};

export const RetryErrorSafe: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
  },
};

export const StaleRefetchWithData: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
};

export const LongContent: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: longContentAgentSessionDetailFixture,
  },
};

export const NullDate: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: nullDateAgentSessionDetailFixture,
  },
};

/**
 * ISS-5075: the read hit its event-row ceiling. The panel paints the capped DB
 * projection, so every disclosure is visible at once — the "· later events
 * truncated" trace-header qualifier, the end-of-trace footer, and the Session
 * Timeline strip's unread tail with its legend.
 *
 * The unread tail needs no flag. This story used to claim it was "mounted with
 * the ISS-4792 reconciliation flag ON", which was wrong twice over: ISS-4792
 * gates the project completion-ring empty state, nothing to do with the
 * timeline, and the flag actually meant —
 * `session-timeline-axis-reconciliation` — was retired to its enabled state by
 * ISS-5366, so the axis-on-the-whole-run behaviour is now unconditional. The
 * story never set a flag (it carried a prop-less harness wrapper, removed in
 * ISS-5697 now that the preview mounts that harness globally), so what it
 * renders is unchanged.
 */
export const EventsTruncated: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: truncatedEventsAgentSessionDetailFixture,
  },
};

/**
 * ISS-5075: the same flag, but the trace source is an archived transcript read
 * whole. The header qualifier still prints — that count is the capped DB
 * projection whatever the panel painted — while the end-of-trace footer must NOT
 * appear, because that one claims the ROWS on screen stop early and these do
 * not. The pair with the story above is the point: they differ only in trace
 * source, and so only in the footer.
 */
export const TruncatedWithWholeTranscript: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: truncatedEventsWithTranscriptAgentSessionDetailFixture,
  },
};

/**
 * ISS-4654: the session whose `state` this build has no entry for — what an
 * installed client sees once the server emits an `AgentSessionState` member
 * added after that build shipped. Unreachable in the running app by design (it
 * needs a value newer than the code reading it), which is exactly why it wants
 * a story: this is the only place the treatment can actually be LOOKED at.
 *
 * What to check, in this order:
 *  • The collapsed Properties strip, which is what the view opens on. The status
 *    word reads muted (FEA-3780), matching the unresolved repository cell two
 *    spans over, so the hedge does not sit at full strength beside real values.
 *    Its dot carries the reason in `title`/`aria-label`, because the word beside
 *    it is `aria-hidden`.
 *  • Then expand Properties. The Status row's glyph is CircleHelp, NOT the
 *    CircleDashed that "Awaiting your approval" owns — in that row the glyph is
 *    the one non-text signal, so the two must not differ by colour alone. Hover
 *    OR focus the value: the ISS-4997 sentence is in the tooltip for a sighted
 *    user and in the accessible name for everyone else.
 *
 * Compare against {@link PopulatedHierarchyTimeline}, which is the same fixture
 * on a recognized state: full-strength word, no disclosure, no tab stop.
 */
export const UnrecognizedState: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: unknownStateAgentSessionDetailFixture,
  },
};

/**
 * ISS-5479: the Session Timeline's jump-feedback vocabulary, unconditional since
 * ISS-6006 retired its gate ON. This fixture is what makes the vocabulary
 * visible — a strip that mixes jumpable and unjumpable buckets.
 *
 * What to look at, all on one strip:
 * - the middle bar carries no jump row, so it drops its pointer cursor and its
 *   hover outline and is `aria-disabled` — compare it against the jumpable bars
 *   on either side, which keep both;
 * - hovering that bar answers in place on the tooltip's meta row ("nothing to
 *   open here") where the jumpable bars say "click to open in trace". The
 *   answer is at the bar deliberately, not in a corner toast;
 * - the dot rail carries the same two states: the "Commits & PRs" dot has no
 *   resolvable turn, so it drops its scale-on-hover and its "Jump to" name,
 *   while the "Human steering" dot stays live.
 */
export const TimelineJumpFeedback: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: idleJumpTargetsAgentSessionDetailFixture,
  },
  play: ({ canvasElement }) => {
    // ISS-5697: the all-stories sweep only proves a story MOUNTS, so without
    // this the fixture could be swapped for one with no unjumpable bucket and
    // nothing would notice. The disabled marking is the machine-readable half of
    // the vocabulary described above.
    expect(
      canvasElement.querySelectorAll('[aria-disabled="true"]').length
    ).toBeGreaterThan(0);
  },
};

/**
 * ISS-5566: the Session Timeline on a session the collector never persisted
 * `activityBuckets` for, with the disclosure flag ON.
 *
 * `populatedAgentSessionDetailFixture` reaches this state the same way most real
 * sessions do — it carries a full `turnItems` transcript and an empty
 * `activityBuckets`, so `buildActivityBuckets` reconstructs the strip and
 * reports `synthesized: true`. What to look for on the strip:
 *
 * - the active bars carry the 45deg `.synthesized` hatch and NO in/out/cache
 *   stack, because behind a synthesized bar that split is three fixed ratios
 *   repeated identically on every bar;
 * - no `$` label above any bar, and hovering one shows no dollar total and no
 *   per-model table — only the measured event and tool-call counts;
 * - the quiet slices keep their own `.idle` / `.cb-gap` hatch rather than the
 *   synthesized one, and hovering those says "Nothing recorded in this slice"
 *   instead of the measured strip's "no tokens billed";
 * - one caption under the axis names the whole strip.
 *
 * The flag-OFF baseline is every other story in this file: the same strip
 * printing fabricated cents as if they had been measured, which is the defect.
 */
export const TimelineSynthesizedCost: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
  parameters: {
    appCore: {
      enabledFlags: [SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY],
    },
  },
};

/**
 * ISS-5566 design review: the caption-stacking case. A synthesized strip can
 * ALSO be a truncated read, and then two captions render back to back under the
 * axis — this one exists so that pairing is looked at rather than reasoned
 * about. The synthesized legend carries the `mb-1` that keeps the two from
 * reading as one run-on block.
 */
export const TimelineSynthesizedCostTruncated: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: truncatedEventsWithTranscriptAgentSessionDetailFixture,
  },
  parameters: {
    appCore: {
      enabledFlags: [SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY],
    },
  },
};

/**
 * ISS-5548 with the column hit target ON — the state design and QA cannot
 * otherwise see.
 *
 * The colocated jsdom test can only assert the `.reach` class contract (jsdom
 * implements no layout, every rect is zero) and the e2e spec measures pixels
 * without a human looking, so neither shows what the treatment READS like. This
 * story is the isolated look.
 *
 * What to look at, both bars on one strip:
 * - the FIRST bar is a ~6px sliver that can be jumped to. Hover anywhere up its
 *   column — not just on the sliver — and the whole column outlines and the
 *   readout appears; the bar itself is untouched, still the honest encoding of a
 *   near-zero spend. Tab to it and the outline goes to 2px `--ring`, louder than
 *   the hover stroke rather than equal to it;
 * - the SECOND bar is visibly TALLER and has no transcript anchor, so it gains
 *   no target at all: hovering the blank space above it does nothing. That is
 *   the invariant — this flag never enlarges a dead target, it only rescues a
 *   live one, and the pair proves the fix keys off jumpability and not size.
 *
 * The flag-OFF baseline is every other story in this file, where that first bar
 * is a 6px target in a 62px column — the defect ISS-5548 exists to fix.
 */
export const TimelineColumnHitTarget: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: columnHitTargetAgentSessionDetailFixture,
  },
  parameters: {
    appCore: {
      enabledFlags: [SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY],
    },
  },
};

/**
 * ISS-5818 on a session with nothing to plot.
 *
 * The Timeline takes a SEPARATE early return for the no-buckets case, and that
 * branch has to carry the heading and the landmark too — an empty region is
 * exactly the one a screen-reader user most needs named, because there is no
 * content to infer it from. Worth a look rather than only an assertion: the
 * empty strip now sits under a real title with a labelled region around it, and
 * the page must not read as though the Timeline failed to load.
 */
export const EmptyTimelineLandmark: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: createAgentSessionDetailFixture({
      activityBuckets: [],
      events: [],
      markers: [],
      name: "Nothing to plot",
      timeline: [],
      turnItems: [],
    }),
  },
  play: ({ canvasElement }) => {
    // The empty branch is the one that would silently lose the landmark, so it
    // gets the same machine-readable check rather than only a screenshot.
    const timeline = Array.from(canvasElement.querySelectorAll("h2")).find(
      (node) => node.textContent?.trim() === "Session Timeline"
    );
    expect(timeline).toBeDefined();
    expect(timeline?.closest("section[aria-labelledby]")).not.toBeNull();
  },
};
