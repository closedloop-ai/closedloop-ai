import type {
  DeliveryInsightsResponse,
  TimeSeries,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import {
  InsightsSection,
  KpiDeltaBasis,
  KpiFormat,
} from "@repo/api/src/types/insights";
import { mixedAgentSessionListFixtures } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { SESSIONS_GLANCEABLE_COLUMNS } from "@repo/app/agents/hooks/use-sessions-view-state";
import { makeTimeSeries } from "@repo/app/insights/components/insights-section-fixtures";
import { AiImpactCard } from "@repo/app/insights/components/overview/ai-impact-card";
import { DashboardCard } from "@repo/app/insights/components/overview/dashboard-card";
import { DashboardRowContent } from "@repo/app/insights/components/overview/dashboard-rows";
import {
  DASHBOARD_ROWS,
  type DashboardRow,
  type DashboardRowGates,
  DashboardRowTour,
} from "@repo/app/insights/components/overview/dashboard-tiles";
import {
  DashboardTourAnchor,
  ROW_TOUR_ANCHORS,
} from "@repo/app/insights/components/overview/dashboard-tour-anchors";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";
import {
  DASHBOARD_PAGE_DESCRIPTION,
  DASHBOARD_PAGE_TITLE,
} from "@repo/app/insights/lib/dashboard-header-copy";
import type { DateRange } from "@repo/app/insights/lib/dashboard-range";
import { GROWTH_LABEL } from "@repo/app/insights/lib/dashboard-range";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import { Tour } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour";
import { resolveDashboardTourSteps } from "@repo/app/onboarding/components/dashboard-tour/resolve-dashboard-tour-steps";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { Meta, StoryObj } from "@storybook/react";
import { Clock3Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { AppScreenShell } from "./app-shell";

// Derived from the same canonical nav the shell renders, so the control can
// never offer a destination the product does not have.
const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

// The two rows this surface mounts, pulled from the SAME row order the real
// dashboard resolves through `dashboardRowsFor` rather than re-declared here,
// so a renamed or reordered row cannot silently drift the two apart.
//
// Throwing rather than `as DashboardRow`: renaming a tour member fails tsc,
// but DELETING a row from DASHBOARD_ROWS compiles clean, and a cast would hand
// `row={undefined}` to DashboardRowContent at render time. This fails the
// story sweep at import with the name of the row that went missing.
function dashboardRowFor(tour: DashboardRowTour): DashboardRow {
  const row = DASHBOARD_ROWS.find((candidate) => candidate.tour === tour);
  if (!row) {
    throw new Error(
      `DASHBOARD_ROWS no longer contains a row for tour "${tour}". This surface mounts it; update the surface or restore the row.`
    );
  }
  return row;
}

const STATS_ROW = dashboardRowFor(DashboardRowTour.Stats);
const MODELS_ROW = dashboardRowFor(DashboardRowTour.Models);

// Neither row this surface renders is gated, so the gates object is a constant
// rather than the `useDashboardRowGates` hook the real page reads it from.
const ROW_GATES: DashboardRowGates = { agentCollaborationNetwork: false };

/**
 * `InsightsSectionData` feeding the real "stats" row's five KPI tiles
 * (`kpi:sessions`, `kpi:cost`, `kpi:merged`, `kpi:pr-size`, `kpi:kloc`) exactly
 * as `DashboardRowContent` / `TileRow` / `OverviewKpiCard` read it in
 * production, in place of the `useDeliveryInsights` / `useUtilizationInsights`
 * hooks that resolve to this shape on the real page (that data layer is the one
 * thing this surface cannot borrow, same as the Sessions surface's `listState`).
 * No shared fixture builds a full section response covering every KPI this row
 * reads, so the values below are hand-built to the wire shape rather than
 * lookalike markup. `prTrend` reuses the shared `makeTimeSeries` builder since
 * its "merged"-keyed shape is exactly what that helper already produces.
 */
// The one date window every fixture on this page plots against — PR trend,
// session activity, and the model usage series below all read this instead
// of each hand-typing their own copy of the same seven dates.
const FIXTURE_DATES = [
  "2026-05-30",
  "2026-05-31",
  "2026-06-01",
  "2026-06-02",
  "2026-06-03",
  "2026-06-04",
  "2026-06-05",
] as const;
const PR_TREND_COUNTS = [9, 11, 8, 14, 12, 16, 13];
const SESSION_COUNTS = [96, 104, 88, 132, 118, 151, 141];

const DASHBOARD_SECTIONS: InsightsSectionData = {
  [InsightsSection.Delivery]: {
    kpis: [
      {
        deltaBasis: KpiDeltaBasis.Computed,
        deltaPct: 12,
        format: KpiFormat.Currency,
        key: InsightsKpiKey.Cost,
        label: "Cost",
        sub: "Agent spend this period",
        value: 4206,
      },
      {
        deltaBasis: KpiDeltaBasis.Computed,
        deltaPct: 4,
        format: KpiFormat.Number,
        key: InsightsKpiKey.Merged,
        label: "Merged PRs",
        sub: "pull requests merged",
        value: 92,
      },
      {
        deltaBasis: KpiDeltaBasis.NotComputed,
        deltaPct: null,
        format: KpiFormat.Number,
        key: InsightsKpiKey.PrSize,
        label: "Median PR size",
        sub: "lines changed per pull request",
        value: 148,
      },
      {
        deltaBasis: KpiDeltaBasis.NotComputed,
        deltaPct: null,
        format: KpiFormat.Number,
        key: InsightsKpiKey.Kloc,
        label: "KLOC merged",
        sub: "thousand lines merged",
        value: 12.4,
      },
    ],
    charts: {
      branchesWithoutPr: [],
      branchLifespan: [],
      meanTimeToMerge: [],
      prByRepo: [],
      prByState: [],
      prTrend: makeTimeSeries(
        FIXTURE_DATES.map((date, i): [string, number] => [
          date,
          PR_TREND_COUNTS[i],
        ])
      ),
    },
  } satisfies DeliveryInsightsResponse,
  [InsightsSection.Utilization]: {
    charts: {
      // No shared builder covers a "sessions"-keyed series (`makeTimeSeries`
      // above is fixed to "merged"), so this one chart is hand-built to the
      // same `TimeSeries` shape rather than borrowed.
      eventActivity: {
        points: FIXTURE_DATES.map((date, i) => ({
          date,
          values: { sessions: SESSION_COUNTS[i] },
        })),
        series: [{ key: "sessions", label: "Sessions" }],
      },
      reviewQueue: [],
    },
    kpis: [
      {
        deltaBasis: KpiDeltaBasis.Computed,
        deltaPct: 12,
        format: KpiFormat.Number,
        key: InsightsKpiKey.Sessions,
        label: "Agent sessions",
        sub: "sessions started",
        value: 1284,
      },
    ],
  } satisfies UtilizationInsightsResponse,
};

/**
 * Spend and token-volume series for the real "models" row's `ModelUsageChart`.
 * Not sourced from a shared fixture: the chart-story's own generator
 * (`model-usage-chart.stories.tsx`) builds the same shape but is local to that
 * file, so this is hand-built to the `TimeSeries` wire shape rather than a
 * lookalike chart.
 */
const MODEL_NAMES = ["claude-opus", "claude-sonnet", "codex"];
const MODEL_SHARE = [0.54, 0.31, 0.15];
function modelTimeSeries(scale: number): TimeSeries {
  const days = FIXTURE_DATES;
  return {
    points: days.map((date, dayIndex) => ({
      date,
      values: Object.fromEntries(
        MODEL_NAMES.map((name, index) => [
          name,
          Number(
            (MODEL_SHARE[index] * scale * (1 + dayIndex * 0.08)).toFixed(2)
          ),
        ])
      ),
    })),
    series: MODEL_NAMES.map((name) => ({ key: name, label: name })),
  };
}
const MODEL_SPEND_SERIES = modelTimeSeries(600);
const MODEL_TOKEN_SERIES = modelTimeSeries(2_400_000);

const DASHBOARD_COPY = {
  heading: DASHBOARD_PAGE_TITLE,
  description: DASHBOARD_PAGE_DESCRIPTION,
} as const;

/**
 * The three readings the real "Recent Sessions" card can be in
 * (`insights-overview-dashboard.tsx`'s inline `RecentSessions`), named for what
 * the reader sees rather than for the query flag that produces it.
 */
const SESSIONS_STATES = ["populated", "loading", "unavailable"] as const;
type SessionsState = (typeof SESSIONS_STATES)[number];

const SESSIONS = mixedAgentSessionListFixtures;

/** The guided tour's "Next" control -- a regex, not an exact string, because
 * `Tour` renders an `ArrowRightIcon` alongside the label. */
const TOUR_NEXT_BUTTON_NAME = /Next/;

type DashboardScreenProps = {
  /** Org-relative path the sidebar should mark as current. */
  activePath?: string;
  /** Page heading. */
  heading?: string;
  /** Supporting line under the heading. */
  description?: string;
  /** Show the five KPI cards across the top. */
  showMetrics?: boolean;
  /** Show the Recent sessions table. */
  showRecentSessions?: boolean;
  /** Show the Model usage breakdown. */
  showModelUsage?: boolean;
  /** Rows the fixture renders, up to the shared mixed-sync-state fixture's five. */
  sessionCount?: number;
  /** Which of the Recent Sessions card's three readings to render. */
  sessionsState?: SessionsState;
  /**
   * The dashboard's time window. It decides the KPI delta caption, which
   * production derives from this rather than writing a fixed phrase.
   */
  dateRange?: DateRange;
};

const DashboardScreen = ({
  dateRange = "7d",
  activePath = "/dashboard",
  description = DASHBOARD_COPY.description,
  heading = DASHBOARD_COPY.heading,
  sessionCount = SESSIONS.length,
  sessionsState = "populated",
  showMetrics = true,
  showModelUsage = true,
  showRecentSessions = true,
}: DashboardScreenProps) => (
  <AppScreenShell activePath={activePath} breadcrumbs={["Dashboard"]}>
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      {/* Hand-written on purpose: the real page
          (apps/app/app/.../dashboard/page.tsx) renders the same
          dashboard-header-copy pair inline above the composed dashboard rather than mounting
          a heading component, so there is no real component to mount here
          either. */}
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">{heading}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5">
        {/* Real component: `DashboardRowContent` rendering the "stats" row
            exactly as `InsightsOverviewDashboard` mounts it -- the same
            catalog-driven KPI tiles (design-system `MetricCard` /
            `CostMetricCard` underneath), reading the same
            `InsightsSectionData` shape the page's insights hooks resolve to.
            `data-tour` matches production byte-for-byte: `ROW_TOUR_ANCHORS`
            keyed off the row's own `tour` identity, the same const both the
            web and desktop shells emit through (dashboard-tour-anchors.ts) --
            what the real guided tour (see the `GuidedTour*` stories below)
            actually rings on this Surface. */}
        {showMetrics ? (
          <div data-tour={ROW_TOUR_ANCHORS[STATS_ROW.tour]}>
            <DashboardRowContent
              autonomySeries={undefined}
              deltaLabel={GROWTH_LABEL[dateRange]}
              gates={ROW_GATES}
              heatmap={undefined}
              modelSeries={undefined}
              row={STATS_ROW}
              sections={DASHBOARD_SECTIONS}
            />
          </div>
        ) : null}

        {/* Real component: `AiImpactCard`, which production mounts directly
            under the stats row whenever that row is not loading. It derives its
            four figures from the same `InsightsSectionData` the tiles above
            read, so it cannot disagree with them. `data-tour`: same anchor
            `InsightsOverviewDashboard` puts on this exact wrapper -- see the
            note above. */}
        {showMetrics ? (
          <div className="mt-5" data-tour={DashboardTourAnchor.Impact}>
            <AiImpactCard sections={DASHBOARD_SECTIONS} />
          </div>
        ) : null}

        {/* Real components: the same `DashboardCard` + `SyncedSessionsTable`
            pair the real page's inline `RecentSessions` composes, fed by the
            shared mixed-sync-state fixture instead of the page's
            `useAgentSessions` hook -- that hook is the page's data layer,
            which this surface cannot borrow (same reasoning as the Sessions
            surface's `listState`). The loading/unavailable copy below is
            copied verbatim from that same `RecentSessions`. `data-tour`:
            production withholds this anchor only when the real query errored
            (`sessionsQuery.isError`); `sessionsState === "unavailable"` is
            this surface's stand-in for that same failure, so the mapping
            below matches it rather than a new rule. */}
        {showRecentSessions ? (
          <div
            data-tour={
              sessionsState === "unavailable"
                ? undefined
                : DashboardTourAnchor.Sessions
            }
          >
            <DashboardCard
              description="Latest synced agent runs"
              title="Recent Sessions"
            >
              {sessionsState === "loading" ? (
                <div className="py-8 text-center text-[var(--muted-foreground)] text-sm">
                  Loading sessions…
                </div>
              ) : null}
              {sessionsState === "unavailable" ? (
                <div className="py-8 text-center text-[var(--destructive)] text-sm">
                  Recent sessions are temporarily unavailable.
                </div>
              ) : null}
              {sessionsState === "populated" ? (
                <SyncedSessionsTable
                  emptyState={
                    <EmptyState
                      className="py-12"
                      description="No synced sessions have arrived yet."
                      icon={Clock3Icon}
                      title="No recent sessions"
                    />
                  }
                  getSessionHref={(item) => `#/sessions/${item.id}`}
                  items={SESSIONS.slice(0, sessionCount)}
                  visibleColumns={SESSIONS_GLANCEABLE_COLUMNS}
                />
              ) : null}
            </DashboardCard>
          </div>
        ) : null}

        {/* Real component: `DashboardRowContent`'s "models" row, which wraps
            the real `ModelUsageChart` in the real `DashboardCard` chrome,
            below Recent Sessions. Production can seat a heatmap row between
            the two when that row is enabled; this surface does not mount one,
            so the pair sits adjacent here. `data-tour`: same
            `ROW_TOUR_ANCHORS` mapping as the stats row above. */}
        {showModelUsage ? (
          <div data-tour={ROW_TOUR_ANCHORS[MODELS_ROW.tour]}>
            <DashboardRowContent
              autonomySeries={undefined}
              deltaLabel={GROWTH_LABEL[dateRange]}
              gates={ROW_GATES}
              heatmap={undefined}
              modelSeries={MODEL_SPEND_SERIES}
              modelTokenSeries={MODEL_TOKEN_SERIES}
              row={MODELS_ROW}
              sections={DASHBOARD_SECTIONS}
            />
          </div>
        ) : null}
      </div>
    </div>
  </AppScreenShell>
);

/**
 * This Surface's Dashboard PLUS ISS-8351 / PLN-1875's guided tour, genuinely
 * active on top of it -- not the tour in isolation, which
 * `Composites/Onboarding/Dashboard Tour` already covers well across its own
 * state matrix (intro card, anchor-off-screen fallback, reduced motion, and
 * so on). See the `GuidedTour*` stories below for what this renders.
 *
 * `DashboardTourHost` (`apps/app/.../dashboard/dashboard-tour-host.tsx`) is
 * NOT what's mounted here, and that is a deliberate scope call, not a wall:
 * its own job is arming logic keyed to things a static fixture has no
 * equivalent for -- a live `dashboardContentState` read, server-recorded
 * "has this org already seen it" completion, the zero-session-org reduced-run
 * branch (ISS-9727). None of that is Clerk-adjacent (confirmed by reading its
 * imports before writing this), it is simply route/analytics plumbing this
 * Surface's fixture data has no analogue for. What a Surface can and should
 * show is the real `Tour` ENGINE (`dashboard-tour.tsx`) -- the same one
 * `DashboardTourHost` mounts -- genuinely spotlighting the real `data-tour`
 * anchors `DashboardScreen` above emits, which are themselves copied
 * attribute-for-attribute from `InsightsOverviewDashboard`
 * (insights-overview-dashboard.tsx): `ROW_TOUR_ANCHORS[row.tour]` on the
 * stats and models rows, `DashboardTourAnchor.Impact` on the AI Impact card,
 * `DashboardTourAnchor.Sessions` on Recent Sessions. A renamed or reordered
 * anchor in production fails typecheck here too, since both files import the
 * same consts rather than restating the strings.
 *
 * `active` starts `false` and flips to `true` from an effect after this
 * component's own first commit -- not on the initial render -- mirroring the
 * real host's "arm only once the page has actually painted its anchors"
 * shape (`dashboard-tour-host.tsx`'s own doc comment: a page measured
 * mid-load resolves to a run pointed at nothing). `Tour` resolves its step
 * list by querying the DOM on the render that flips `active` from `false` to
 * `true` (see `dashboard-tour.tsx`'s own doc comment on `resolveSteps`), so
 * flipping on the very first render -- before `DashboardScreen` below it has
 * painted -- would measure an empty document and freeze a run with nothing
 * in it.
 *
 * VERIFIED, NOT ASSUMED, THAT THIS RUN HAS NO INTRO CARD: the brief that
 * asked for this surface suggested a story "showing the intro card," but
 * reading both real callers of `resolveDashboardTourSteps` first shows that
 * is a Desktop-only shape -- `first-launch-dashboard.tsx` is the one caller
 * that ever passes `leadingSteps`, and `dashboard-tour-host.tsx` (this
 * Surface's real web equivalent) calls it with none. The web dashboard's
 * guided tour genuinely never has an intro card, so no story here claims one;
 * see `GuidedTourOpening` below for what the real first step is instead.
 *
 * VERIFIED, NOT ASSUMED, WHICH STEPS ACTUALLY RUN: `resolveDashboardTourSteps`
 * drops any canonical step whose anchor does not measure (`dashboard-tour-
 * steps.ts` / `resolve-dashboard-tour-steps.ts`), and this Surface -- like
 * the real product for many orgs -- never mounts the Activity heatmap or the
 * Pull Requests row, so the `activity` and `prs` steps are genuinely absent
 * from the run here, the same way they are on a production org whose
 * dashboard never draws those two rows. What actually runs is four steps:
 * Stats, Impact, Sessions, Models -- a real, honest subset, not a
 * hand-trimmed list.
 *
 * WHY `isAnchorRenderedInStory` REPLACES THE RESOLVER'S OWN DEFAULT: found by
 * actually running the authoritative `story-sweep` suite, not assumed --
 * `resolveDashboardTourSteps()`'s real default, `isDashboardTourAnchorPresent`,
 * requires a MEASURABLE (non-zero-area) rect, not merely a present element
 * (`dashboard-tour-anchors.ts` / `dashboard-tour-geometry.ts`'s `spotlightHole`).
 * `vitest.config.ts`'s own comment says why that can never pass here: "jsdom
 * does no layout," so every element in this suite reads a zero-area
 * `getBoundingClientRect()` regardless of what it renders, and the resolver
 * would report all four real anchors absent and freeze an empty run --
 * exactly the failure `story-sweep` caught. This is not this Surface's
 * failure to seed something: it is the same real-browser-only limitation
 * `dashboard-tour.stories.tsx`'s own CanonicalSteps / ActivityAbsent /
 * WithIntroStep stories already work around by passing their OWN
 * `isAnchorPresent` rather than the resolver's default. `isAnchorRenderedInStory`
 * below is this Surface's version of that same pattern: it still queries the
 * real, unmodified `data-tour` DOM this Surface emits (not a hand-typed
 * truth table), it just stops at presence rather than area -- the one half
 * of the rule a jsdom sweep can never exercise either way. In an actual
 * browser (Storybook's live preview, or the Playwright pass the audit
 * describes) the real default would also pass for these same four anchors,
 * since none of them ever render collapsed to zero size.
 */
function isAnchorRenderedInStory(anchor: DashboardTourAnchor): boolean {
  return globalThis.document.querySelector(`[data-tour="${anchor}"]`) !== null;
}

function DashboardWithGuidedTour(props: DashboardScreenProps) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(true);
  }, []);
  return (
    <>
      <DashboardScreen {...props} />
      <Tour
        active={active}
        onClose={() => {
          // The real host (`dashboard-tour-host.tsx`) also stamps a
          // finish/defer server call and latches `run` to `Closed` so the
          // arm never reopens it; this story only needs the transition that
          // actually closes the overlay, since it has no arm to latch and
          // `Composites/Onboarding/Dashboard Tour`'s own meta already covers
          // the server-recording behavior for the isolated engine.
          setActive(false);
        }}
        resolveSteps={() =>
          resolveDashboardTourSteps({
            isAnchorPresent: isAnchorRenderedInStory,
          })
        }
      />
    </>
  );
}

/**
 * The landing screen after signing in, showing an organization's overall
 * activity at a glance rather than drilling into one session or branch.
 */
const meta = {
  title: "Surfaces v1.0/Dashboard",
  component: DashboardScreen,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    activePath: {
      options: NAV_PATHS,
      control: { type: "select" },
      description: "Which sidebar destination renders as current.",
      table: { category: "Shell" },
    },
    sessionCount: {
      control: { type: "number", min: 0, max: SESSIONS.length, step: 1 },
      description:
        "Rows the table renders, up to the shared fixture's five mixed-sync-state sessions.",
      table: { category: "Content" },
    },
    heading: { control: "text", table: { category: "Content" } },
    description: { control: "text", table: { category: "Content" } },
    showMetrics: {
      control: "boolean",
      description: "The five KPI cards across the top.",
      table: { category: "Composition" },
    },
    showRecentSessions: {
      control: "boolean",
      description: "The Recent sessions table.",
      table: { category: "Composition" },
    },
    showModelUsage: {
      control: "boolean",
      description: "The Model usage breakdown.",
      table: { category: "Composition" },
    },
    dateRange: {
      options: ["7d", "30d", "90d", "all"],
      control: { type: "radio" },
      description:
        "The window the figures cover. It also sets the delta caption: WoW, MoM, QoQ, or all time.",
      table: { category: "Content" },
    },
    sessionsState: {
      options: SESSIONS_STATES,
      control: { type: "radio" },
      description:
        "The three readings the Recent Sessions card can be in: rows, pending, or could not load.",
      table: { category: "State" },
    },
  },
  args: {
    dateRange: "7d",
    activePath: "/dashboard",
    description: DASHBOARD_COPY.description,
    heading: DASHBOARD_COPY.heading,
    sessionCount: SESSIONS.length,
    sessionsState: "populated",
    showMetrics: true,
    showModelUsage: true,
    showRecentSessions: true,
  },
  parameters: {
    layout: "fullscreen",
    // A fullscreen Surface, inlined into the Docs page's own prose-width
    // column, squeezes real components (this one's 5-column KPI row) into
    // far less width than they ever get in the product. `inline: false`
    // renders the Docs preview in its own full-width iframe instead, the
    // documented Storybook fix for exactly this mismatch.
    docs: { story: { inline: false, iframeHeight: 900 } },
  },
} satisfies Meta<typeof DashboardScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Filters narrowed the list to nothing. The real `SyncedSessionsTable` empty
 * state renders in place of the row, which the hand-built table never had. */
export const NoSessions: Story = {
  name: "No sessions",
  args: { sessionCount: 0 },
};

/** The read failed. The real `RecentSessions` degraded-state copy renders
 * instead of a table, rather than the hand-built version's silent header. */
export const RecentSessionsUnavailable: Story = {
  name: "Recent sessions unavailable",
  args: { sessionsState: "unavailable" },
};

/** Metrics only, the arrangement while the lower panels are still loading. */
export const MetricsOnly: Story = {
  name: "Metrics only",
  args: { showModelUsage: false, showRecentSessions: false },
};

/**
 * The guided tour (ISS-8351 / PLN-1875) the moment it opens: the real `Tour`
 * engine's own first step, spotlighting the real headline-metrics row via the
 * real `[data-tour="stats"]` anchor -- see `DashboardWithGuidedTour`'s doc
 * comment above for why this is the engine itself, not `DashboardTourHost`,
 * and why the web run has no leading intro card to open on instead.
 */
export const GuidedTourOpening: Story = {
  name: "Guided tour (opening step)",
  render: (args) => <DashboardWithGuidedTour {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("dialog", {
        name: "Start with the headline metrics",
      })
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: TOUR_NEXT_BUTTON_NAME })
    ).toBeInTheDocument();
  },
};

/**
 * The same real run, two steps in: Stats then Impact then Sessions, reached
 * by actually clicking "Next" twice rather than asserted from outside --
 * `Tour` keeps its step index as internal state with no prop to preset it, so
 * driving the real control is the only honest way to show a step past the
 * first. Rings the real `[data-tour="sessions"]` anchor around Recent
 * Sessions, the third of this run's four real steps (Stats, Impact, Sessions,
 * Models -- Activity and Prs drop out because this Surface never mounts
 * those two rows, exactly as `resolveDashboardTourSteps` would drop them on a
 * production org that never draws them either).
 */
export const GuidedTourMidRun: Story = {
  name: "Guided tour (mid-run)",
  render: (args) => <DashboardWithGuidedTour {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("dialog", {
      name: "Start with the headline metrics",
    });
    await userEvent.click(
      canvas.getByRole("button", { name: TOUR_NEXT_BUTTON_NAME })
    );
    await userEvent.click(
      canvas.getByRole("button", { name: TOUR_NEXT_BUTTON_NAME })
    );
    await expect(
      await canvas.findByRole("dialog", {
        name: "Open any session for the full story",
      })
    ).toBeVisible();
    // Third of four real steps: "Back" is available, "Next" (not the last
    // step's completion label) still is too.
    await expect(
      canvas.getByRole("button", { name: "Back" })
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: TOUR_NEXT_BUTTON_NAME })
    ).toBeInTheDocument();
  },
};
