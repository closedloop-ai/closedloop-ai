import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { AGENTS_PAGE_SIZE } from "../../lib/agents-timeframe";
import { createAgentSessionListItemFixture } from "../sessions/session-list-fixtures";
import { makeComponent } from "./agent-component-fixtures";
import { DetailSessionsTab } from "./detail-sessions-tab";

/**
 * ISS-4979 (wongk review, #4291): canvas for the agent-component detail Sessions
 * tab, which had no story anywhere.
 *
 * The child `SessionsTable` has its own story, but none of the states THIS
 * wrapper owns are reachable from it — and they are exactly the states that are
 * painful to reach in the running app and cheap to regress silently:
 *
 *   - the SPLIT empty states: a true zero (nothing has invoked this component)
 *     vs. details-unavailable (a source reports usage it cannot hydrate into
 *     rows). Collapsing those two into one "no sessions yet" is the lying empty
 *     state wongk caught in #3688;
 *   - the `Showing N of M sessions` truncation footer past `AGENTS_PAGE_SIZE`;
 *   - the optional Version column, which only appears when version attribution
 *     resolves;
 *   - the ISS-4979 flag-ON floored-span row, which must render the shared empty
 *     rather than a fabricated "0s".
 *
 * The co-located tests pin the ADAPTER threading; these stories pin what the tab
 * actually renders.
 */

const STARTED_AT = new Date("2026-06-10T10:00:00.000Z");

const component = makeComponent({
  id: "uuid-sub-1",
  slug: "subagent::orchestrator",
  name: "My Orchestrator Agent",
});

/** A component whose metrics claim usage — the details-unavailable precondition. */
const componentWithUsage = makeComponent({
  id: "uuid-sub-1",
  slug: "subagent::orchestrator",
  name: "My Orchestrator Agent",
  sessions: 7,
});

/**
 * ISS-5464: the heavy component from the report — 1218 real sessions behind a
 * payload bounded to 50. This is the fixture the credible-total notice needs;
 * `componentWithUsage` (sessions: 7) is BELOW the delivered row count, so it
 * exercises the floor branch instead and can never show "Showing 50 of 1,218
 * sessions" no matter how many rows it is handed.
 */
const componentWithHeavyUsage = makeComponent({
  id: "uuid-sub-3",
  slug: "tool::bash",
  name: "Bash",
  sessions: 1218,
});

/** A component with no usage anywhere — the honest true-zero precondition. */
const componentWithoutUsage = makeComponent({
  id: "uuid-sub-2",
  slug: "subagent::unused",
  name: "Never Invoked Agent",
  sessions: 0,
});

/**
 * ISS-5363: the producer could NOT compute the session count, so the Sessions
 * card above this tab renders a dash. Neither "no sessions yet" nor "recorded
 * usage" is true of this payload.
 */
const componentWithUnknownUsage = makeComponent({
  id: "uuid-sub-3",
  slug: "subagent::unknown-count",
  name: "Unmeasured Agent",
  sessions: null,
  invocations: null,
});

const ordinarySessions = [
  createAgentSessionListItemFixture({
    id: "session-ordinary-1",
    name: "Wire the checkout retry",
    startedAt: STARTED_AT,
    lastActivityAt: new Date("2026-06-10T13:33:00.000Z"),
    wallClock: "3h 33m",
  }),
  createAgentSessionListItemFixture({
    id: "session-ordinary-2",
    name: "Backfill the session index",
    startedAt: STARTED_AT,
    lastActivityAt: new Date("2026-06-10T10:12:00.000Z"),
    wallClock: "12m",
  }),
];

/**
 * The ISS-4979 pair, side by side: a floored calendar span (nothing measured
 * anything) and a genuinely observed zero-length window. They must not render
 * identically.
 */
const durationRuleSessions = [
  createAgentSessionListItemFixture({
    id: "session-unmeasurable",
    name: "Terminal, no end instant (unmeasurable)",
    status: SESSION_STATUS.INACTIVE,
    startedAt: STARTED_AT,
    lastActivityAt: STARTED_AT,
    endedAt: null,
    wallClock: null,
  }),
  createAgentSessionListItemFixture({
    id: "session-inflated",
    name: "Completed, sync-inflated wallClock",
    status: SESSION_STATUS.INACTIVE,
    startedAt: new Date("2026-07-28T14:58:31.028Z"),
    endedAt: new Date("2026-07-29T22:02:53.365Z"),
    lastActivityAt: new Date("2026-08-04T17:28:37.425Z"),
    wallClock: "170h 30m",
  }),
];

/** One more than the page size, so the truncation footer renders. */
const manySessions = Array.from(
  { length: AGENTS_PAGE_SIZE + 12 },
  (_unused, index) =>
    createAgentSessionListItemFixture({
      id: `session-bulk-${index}`,
      name: `Bulk session ${index + 1}`,
      startedAt: STARTED_AT,
      lastActivityAt: new Date(STARTED_AT.getTime() + index * 60_000),
      wallClock: `${index + 1}m`,
    })
);

const versions: AgentComponentDetail["versions"] = [
  {
    hash: "abc1234def5678",
    source: "acme/repo",
    format: "md",
    createdAt: "2026-06-10T00:00:00.000Z",
    isCurrent: true,
    content: "You are an expert orchestrator agent.",
  },
  {
    hash: "0999888777666",
    source: "acme/repo",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent: false,
    content: "You are an orchestrator agent.",
  },
];

// Attribution rows keyed by session id — the current revision for the first
// bulk page, so the Version column resolves a label rather than an em dash.
const usageSessions: AgentComponentDetail["usageSessions"] = Array.from(
  { length: AGENTS_PAGE_SIZE },
  (_unused, index) => ({
    sessionId: `session-bulk-${index}`,
    invocationCount: 1,
    versionHash: index % 2 === 0 ? "abc1234def5678" : "0999888777666",
  })
);

function PanelFrame({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="max-w-5xl p-6">{children}</div>;
}

// ISS-5697: the app-core harness is mounted globally by `.storybook/preview.tsx`
// (ISS-5665), so this decorator is now only the panel frame. Flags default to
// disabled — the closed-by-default baseline — and a story that needs one sets
// `parameters.appCore.enabledFlags`.
const storyDecorator: Decorator = (Story) => (
  <PanelFrame>
    <Story />
  </PanelFrame>
);

/**
 * The Sessions tab on an agent component's detail page: a table listing the
 * sessions that have invoked this component, with an optional Version column
 * showing which revision each session ran. Use it inside a component's
 * detail view rather than the general Sessions list, since it's scoped to
 * one component's usage history and caps how many rows it renders so a
 * heavily used component can't freeze the page. When there are no rows to
 * show, it picks from three different empty messages depending on what's
 * actually known: genuinely zero uses, usage that exists but can't be listed
 * individually, or a count that was never measured at all. Past the page
 * limit, a footer notes how many sessions are shown against the real total,
 * or against a floor like '50 of 50+' when the true total isn't known.
 */
const meta = {
  title: "Composites/Sessions/Detail/Detail Sessions Tab",
  component: DetailSessionsTab,
  tags: ["autodocs"],
  argTypes: {
    component: { control: "object" },
    sessions: { control: "object" },
    sessionsTabTruncated: {
      control: "boolean",
      description:
        "The producer's own statement that `sessions` is a bounded sample.",
    },
    usageSessions: { control: "object" },
    versions: { control: "object" },
    getSessionHref: { control: false },
  },
  parameters: { layout: "fullscreen" },
  args: {
    component,
    sessions: ordinarySessions,
    sessionsTabTruncated: false,
    getSessionHref: (row: { id: string }) => `/sessions/${row.id}`,
  },
  decorators: [storyDecorator],
} satisfies Meta<typeof DetailSessionsTab>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The ordinary case: a handful of sessions, no Version column, no footer. */
export const Default: Story = {};

/**
 * True zero — nothing has invoked this component, and no metric claims
 * otherwise. "No sessions yet" is honest here.
 */
export const EmptyTrueZero: Story = {
  args: { component: componentWithoutUsage, sessions: [] },
};

/**
 * Details unavailable — the component's own metrics report 7 sessions, but this
 * data source cannot project the individual rows (the desktop local reader's
 * case). Saying "no sessions have invoked this component" here would contradict
 * the numbers rendered directly above the tab, which is why the two empties are
 * split rather than shared.
 */
export const EmptyDetailsUnavailable: Story = {
  args: { component: componentWithUsage, sessions: [] },
};

/**
 * ISS-5363 — the third empty state. The count was never measured, so the tab
 * must neither deny sessions nor claim usage was recorded. Sits beside
 * `EmptyTrueZero` so the two are legible as different answers, not styling.
 */
export const EmptyCountUnavailable: Story = {
  args: { component: componentWithUnknownUsage, sessions: [] },
};

/**
 * Past `AGENTS_PAGE_SIZE`, with version attribution resolved — the truncation
 * footer AND the optional Version column together, since both are off in the
 * default story and neither is reachable from the child table's own story.
 *
 * ISS-5464 (review): this story used `componentWithUsage` (sessions: 7) against
 * 62 delivered rows, so 7 was below the delivered count, the floor branch took
 * over, and the story rendered the total-unavailable state under a name that
 * promised the opposite — the honest "Showing 50 of 1,218 sessions" case from
 * the report had no story anywhere. It now carries the heavy fixture, and the
 * two other notice states are stories of their own directly below, so the trio
 * is legible side by side the way the three empty states already are.
 */
export const TruncatedWithVersionColumn: Story = {
  args: {
    component: componentWithHeavyUsage,
    sessions: manySessions,
    usageSessions,
    versions,
  },
};

/**
 * The floor branch: the producer could not give a total this tab can believe.
 * `componentWithUsage` reports 7 sessions while 62 rows arrived, and a total
 * BELOW the delivered count is not a total — the desktop adapter's placeholder
 * `0` (`shared-agent-components-api.ts`, `resolved?.sessions ?? 0`) lands here
 * too. The notice states what it can defend: at least this many, marked with the
 * house `+` rather than reporting on our own data pipeline.
 */
export const TruncatedWithUnknownTotal: Story = {
  args: {
    component: componentWithUsage,
    sessions: manySessions,
  },
};

/**
 * The edge the renderer cannot see for itself: a payload cut by the SERVER
 * arrives at exactly the rendered page size, so `delivered > rendered` is false
 * and silence would imply completeness. Only the producer's
 * `sessionsTabTruncated` distinguishes it from a desktop payload that was simply
 * complete at 50 — which is why the flag travels on the wire instead of being
 * inferred from a constant one producer honours and the other does not.
 */
export const TruncatedAtTheBoundWithUnknownTotal: Story = {
  args: {
    component: componentWithUsage,
    sessions: manySessions.slice(0, AGENTS_PAGE_SIZE),
    sessionsTabTruncated: true,
  },
};

/**
 * ISS-5131: the two Duration cases that are easy to get wrong, side by side. The
 * first row is terminal with no end instant, so its cell is the shared empty —
 * never a fabricated "0s" and never a span against `now()` that would grow on a
 * finished session. The second is the reported `019fb3e3` shape: a completed
 * session whose collector `wallClock` was anchored on a sync timestamp six days
 * past its own end, so the cell must read 31h 4m rather than 170h 30m.
 */
export const DurationRule: Story = {
  args: { component: componentWithUsage, sessions: durationRuleSessions },
};
