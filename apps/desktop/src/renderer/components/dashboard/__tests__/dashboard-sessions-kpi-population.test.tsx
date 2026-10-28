import {
  InsightsPeriod,
  InsightsScope,
  type KpiStat,
} from "@closedloop-ai/loops-api/insights";
import { KpiFormat } from "@repo/api/src/types/insights";
import { getMetricValueRow } from "@repo/app/insights/components/__tests__/metric-card-test-utils";
import { SCOPE_TOGGLE_OPTIONS } from "@repo/app/insights/components/overview/dashboard-scope-copy";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DATE_RANGE_LABELS } from "@repo/app/shared/lib/format-utils";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { DashboardPage } from "../DashboardPage";

/**
 * ISS-10413 AC-2 and AC-4, at the rendered surface the ticket names.
 *
 * The report was that the Dashboard's "Sessions" KPI held ONE number across a
 * date change and a Me/Organization change while the Cost and Merged-PRs cards
 * beside it moved. The ticket blamed `sessionsTotal`, the unfiltered
 * `useAgentSessions({ limit })` read; that read feeds only backfill-settle
 * detection and the empty/loading branch and reaches no rendered number. The
 * card is the Utilization `sessions` KPI, and its producers do window and
 * owner-scope — `fetchSessionRollup` on cloud (pinned against a real database by
 * `apps/api/app/insights/session-rollup-population.integration.test.ts`) and
 * `computeUtilization` on this machine (pinned by
 * `apps/desktop/test/local-insights-activity-window-alignment.test.ts`).
 *
 * WHAT NEITHER OF THOSE CAN SEE is the half in between: that this page hands
 * the selection it is showing to the read, and renders that read's answer.
 * `dashboard-scope-toggle.test.tsx` asserts the scope ARGUMENT reaches all three
 * section hooks and stops there — it pins no range at all (it mocks
 * `useDashboardRange` to a fixed period) and never reads the number on the card.
 * A page that passed a constant window, or drew a number from some other read,
 * keeps every one of those suites green and reproduces the report exactly.
 *
 * So the fake below is the PRODUCER, not the payload: it counts a seeded corpus
 * under whatever `(period, scope)` the page asks it for. Every one of the four
 * answers is distinct, because a fixture whose sessions are all in-window and
 * all self-owned counts the same under the bug as under the fix.
 *
 * WHAT THIS SUITE STILL CANNOT SEE, so that it is not read as guarding the
 * reported symptom (marisolashgrove review): `useUtilizationInsights` is mocked
 * here and answers every key immediately, so the `keepPreviousData` +
 * `staleTime: Infinity` starvation that actually froze the recording's 3,197 —
 * a settled 90-day payload still on screen under a 7d selection — is outside
 * this file by construction. That mechanism belongs to ISS-10414, and nothing
 * below would go red if it regressed.
 */

const hooks = vi.hoisted(() => ({
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  useDesktopAuth: vi.fn(),
  useApiClient: vi.fn(),
  useDesktopAppCoreMode: vi.fn(),
  useDesktopLocalReadReason: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/app/agents/hooks/use-agent-sessions")
    >();
  return { ...actual, useAgentSessions: hooks.useAgentSessions };
});
// The local-store readiness probe reaches the agent-monitor over IPC, which the
// partial `window.desktopApi` below does not provide. `useSessionsCountFresh` is
// subject-tested in `dashboard-state.test.ts`; `useDashboardSessionSource` is
// not tested anywhere, which is why it is named here as a stub and not as
// covered elsewhere. The real state machine still runs either way.
vi.mock("../dashboard-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-state")>()),
  useDashboardSessionSource: () => ({
    ready: true,
    importInProgress: false,
    unavailable: false,
  }),
  useSessionsCountFresh: () => true,
}));
vi.mock("@repo/app/insights/hooks/use-insights", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/app/insights/hooks/use-insights")
    >();
  return {
    ...actual,
    useDeliveryInsights: hooks.useDeliveryInsights,
    useUtilizationInsights: hooks.useUtilizationInsights,
    useAgentsInsights: hooks.useAgentsInsights,
  };
});
// `useDashboardRange` is deliberately NOT mocked: the range control driving the
// period is half of what this file exists to prove.
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: hooks.useDesktopAuth,
}));
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: hooks.useApiClient,
}));
vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: hooks.useDesktopAppCoreMode,
  useDesktopLocalReadReason: hooks.useDesktopLocalReadReason,
}));

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

/** The signed-in reader. */
const OWNER = "owner";
/** A colleague in the same org: `org` counts their work, `me` must not. */
const COLLEAGUE = "colleague";

/**
 * The seeded corpus, as (owner, age-in-days) rows.
 *
 * Every window the control offers has rows INSIDE it and rows BEYOND it, for
 * both owners. The rows past 90 days are what make the 90-day cells mean
 * anything: with a corpus that fitted inside 90 days, "90 days" and "no window
 * at all" count the same rows, so a selection that resolved to the wrong period
 * — or to none — would still render the number the 90-day assertion expects.
 */
const SESSION_CORPUS: readonly { owner: string; ageDays: number }[] = [
  { owner: OWNER, ageDays: 2 },
  { owner: OWNER, ageDays: 3 },
  { owner: OWNER, ageDays: 4 },
  { owner: OWNER, ageDays: 20 },
  { owner: OWNER, ageDays: 40 },
  { owner: OWNER, ageDays: 41 },
  { owner: OWNER, ageDays: 42 },
  { owner: OWNER, ageDays: 200 },
  { owner: OWNER, ageDays: 300 },
  { owner: COLLEAGUE, ageDays: 2 },
  { owner: COLLEAGUE, ageDays: 3 },
  { owner: COLLEAGUE, ageDays: 4 },
  { owner: COLLEAGUE, ageDays: 5 },
  { owner: COLLEAGUE, ageDays: 6 },
  { owner: COLLEAGUE, ageDays: 20 },
  { owner: COLLEAGUE, ageDays: 21 },
  { owner: COLLEAGUE, ageDays: 40 },
  { owner: COLLEAGUE, ageDays: 200 },
];

/**
 * Written out rather than derived from {@link SESSION_CORPUS}: a fixture that
 * recomputes its expectation with the same arithmetic the fake uses agrees with
 * the fake's mistakes, and would keep agreeing if a window predicate were
 * dropped from both.
 *
 * All eight (period, scope) cells of this corpus resolve to a different number,
 * so no selection can render the number another selection is entitled to. The
 * six named here are the ones a case drives.
 */
const SESSIONS_7D_ME = "3";
const SESSIONS_30D_ME = "4";
const SESSIONS_90D_ME = "7";
const SESSIONS_ALL_ME = "9";
const SESSIONS_7D_ORG = "8";
const SESSIONS_90D_ORG = "15";

/**
 * The unfiltered `useAgentSessions` total — the read ISS-10413 blamed, and the
 * number the recording showed. Deliberately unlike every count above, so a page
 * that went back to drawing the card from it fails here by name rather than by
 * a coincidence of fixture arithmetic.
 */
const UNFILTERED_LIST_TOTAL = 3197;

/**
 * Explicit, rather than the runner's 5s default (repo rule: a timing-sensitive
 * integration test states its own bound). Each case drives up to four awaited
 * transitions through a full dashboard render, and vitest's default is a
 * runner setting, not a contract — on a loaded box these cases legitimately
 * need longer, and a default-timeout failure reads as a product defect.
 */
const CASE_TIMEOUT_MS = 30_000;

const SESSIONS_CARD_LABEL = "Sessions";
/**
 * The range control's accessible names, read from the map that PRODUCES them:
 * `DateRangeFilter` renders `aria-label={DATE_RANGE_LABELS[range]}`. Re-typing
 * the four strings here would survive a reword of that map and fail as
 * "unable to find a label", pointing at nothing rather than at the rename
 * (marisolashgrove review). The contract these cases assert is the rendered COUNT,
 * never this copy, so following the map costs no coverage.
 *
 * `SESSIONS_CARD_LABEL` stays written out: it is fixture-owned — the
 * {@link KpiStat} below supplies it. `ORG_SCOPE_LABEL` is read from the toggle's
 * own option list for the same reason the range labels are read from their map.
 */
const RANGE_7D_LABEL = DATE_RANGE_LABELS["7d"];
const RANGE_30D_LABEL = DATE_RANGE_LABELS["30d"];
const RANGE_90D_LABEL = DATE_RANGE_LABELS["90d"];
const RANGE_ALL_LABEL = DATE_RANGE_LABELS.all;
const ORG_SCOPE_LABEL = orgScopeLabel();

/**
 * Exhaustive over {@link InsightsPeriod}, and the fake THROWS on anything not
 * here rather than falling through to "no window". A fallthrough would turn a
 * selection the page failed to translate into an unwindowed count — the exact
 * answer the widest cell already expects, so the mis-translation would render
 * as a pass.
 */
const WINDOW_DAYS: Record<InsightsPeriod, number> = {
  [InsightsPeriod.Week]: 7,
  [InsightsPeriod.Month]: 30,
  [InsightsPeriod.Quarter]: 90,
  // Past the oldest row, so "All" is the whole corpus and still a real bound.
  [InsightsPeriod.All]: 3650,
};

describe("desktop Dashboard Sessions KPI population (ISS-10413)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.useDesktopLocalReadReason.mockReturnValue(undefined);
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    hooks.useDesktopAuth.mockReturnValue({
      beginSignIn: vi.fn(async () => ({ ok: true })),
      state: { status: "authenticated" },
    });
    hooks.useApiClient.mockReturnValue({ get: vi.fn() });
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Cloud);
    installDesktopApi();
    stubSections();
  });

  // `localStorage` is deliberately NOT cleared. The renderer lane seeds
  // `dashboardOnboardedStorageKey` in `renderer-returning-install-setup.ts` so
  // suites mount a RETURNING install; clearing it here would put every case
  // back on the first-launch reveal and tour-arming path this suite does not
  // stub. The range the control persists is neutralized per case instead, by
  // `renderAtMonth` establishing a known selection through the control itself.
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it(
    "counts only the selected window when the range changes",
    async () => {
      await renderAtMonth();

      fireEvent.click(screen.getByLabelText(RANGE_7D_LABEL));
      await waitFor(() => expect(sessionsValue()).toBe(SESSIONS_7D_ME));

      fireEvent.click(screen.getByLabelText(RANGE_90D_LABEL));
      await waitFor(() => expect(sessionsValue()).toBe(SESSIONS_90D_ME));

      // Three windows, three different numbers, none of them the corpus size. A
      // card that had lost its window would read the same count at all three, and
      // a card whose selection resolved to the WRONG window would read one of the
      // other two — which is why every cell is asserted rather than the steps
      // between them.
    },
    CASE_TIMEOUT_MS
  );

  it(
    "treats All time as its own unbounded period",
    async () => {
      await renderAtMonth();

      fireEvent.click(screen.getByLabelText(RANGE_ALL_LABEL));

      // `All` is a fourth period, not the absence of one — it maps through
      // `RANGE_TO_PERIOD.all` like the other three. Nothing else in this file
      // drives it, so a mapping that collapsed it onto Quarter (or onto the
      // 30-day selection this case starts from) would render one of the
      // numbers already asserted elsewhere and pass. This is the only cell
      // where the whole corpus is the right answer.
      await waitFor(() => expect(sessionsValue()).toBe(SESSIONS_ALL_ME));
    },
    CASE_TIMEOUT_MS
  );

  it(
    "counts only the selected owner scope when the scope changes",
    async () => {
      await renderAtMonth();

      fireEvent.click(screen.getByLabelText(RANGE_7D_LABEL));
      await waitFor(() => expect(sessionsValue()).toBe(SESSIONS_7D_ME));

      fireEvent.click(screen.getByText(ORG_SCOPE_LABEL));

      // Same seven-day window, five more sessions, all the colleague's.
      await waitFor(() => expect(sessionsValue()).toBe(SESSIONS_7D_ORG));
    },
    CASE_TIMEOUT_MS
  );

  it(
    "holds both axes at once rather than one at a time",
    async () => {
      await renderAtMonth();

      fireEvent.click(screen.getByLabelText(RANGE_90D_LABEL));
      fireEvent.click(screen.getByText(ORG_SCOPE_LABEL));

      await waitFor(() => expect(sessionsValue()).toBe(SESSIONS_90D_ORG));
    },
    CASE_TIMEOUT_MS
  );

  it(
    "leaves the settle-detection session read unfiltered",
    async () => {
      await renderAtMonth();

      fireEvent.click(screen.getByLabelText(RANGE_7D_LABEL));
      await waitFor(() => expect(sessionsValue()).toBe(SESSIONS_7D_ME));

      // The read ISS-10413 blamed. It feeds boot-import settle detection and the
      // empty-state gate, both of which need the RAW local-store total, so it must
      // stay unwindowed and unscoped while the card beside it moves. Filtering it
      // to "fix" this ticket is the mutation this case exists to catch — and the
      // assertion above is what proves the card is not drawn from it.
      // ISS-11927 adds a SEPARATE count-only read in the KPIs' viewer scope
      // (the date-range empty's all-time history). It is not this read, so it
      // is set aside by its count-only hint, and only by that.
      for (const call of hooks.useAgentSessions.mock.calls.filter(
        ([query]) => (query as { countOnly?: boolean })?.countOnly !== true
      )) {
        // Sorted before comparing: `Object.keys` is insertion-ordered, so a new
        // leading key would redden this with a diff that reads like an ordering
        // problem for what is a filtering contract (marisolashgrove review). Still
        // an exhaustive comparison — an ADDED key fails here, which a pair of
        // `not.toHaveProperty` checks for `period` and `scope` would not.
        expect(Object.keys(call[0] ?? {}).sort()).toEqual(["limit"]);
      }
      expect(hooks.useAgentSessions).toHaveBeenCalled();
      expect(sessionsValue()).not.toBe(String(UNFILTERED_LIST_TOTAL));
    },
    CASE_TIMEOUT_MS
  );
});

/**
 * Render, then put the range control on the 30-day selection through the
 * control itself and prove it landed.
 *
 * Every case then moves OFF a known non-target window, so no assertion can be
 * satisfied by a starting state — whether that is the 7-day default or the
 * selection a previous case in this file persisted.
 */
async function renderAtMonth(): Promise<void> {
  render(dashboard());
  fireEvent.click(await screen.findByLabelText(RANGE_30D_LABEL));
  await waitFor(() => expect(sessionsValue()).toBe(SESSIONS_30D_ME));
}

function sessionsValue(): string {
  return getMetricValueRow(SESSIONS_CARD_LABEL).textContent?.trim() ?? "";
}

/**
 * The Utilization section, computed from {@link SESSION_CORPUS} under the
 * `(period, scope)` the page asks for. Standing in for the producer rather than
 * for its payload is what lets a mis-wired selection show up as the wrong
 * rendered number instead of as a passing argument assertion.
 */
function utilizationFor(period: InsightsPeriod, scope: InsightsScope) {
  const windowDays = WINDOW_DAYS[period];
  if (windowDays === undefined) {
    throw new Error(`No window seeded for period ${period}`);
  }
  const counted = SESSION_CORPUS.filter(
    (session) =>
      session.ageDays <= windowDays &&
      (scope === InsightsScope.Org || session.owner === OWNER)
  );
  const sessions: KpiStat = {
    key: InsightsKpiKey.Sessions,
    label: SESSIONS_CARD_LABEL,
    value: counted.length,
    format: KpiFormat.Number,
    sub: "agent sessions run",
    deltaPct: null,
  };
  return {
    isSuccess: true,
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData: false,
    data: { kpis: [sessions], charts: { eventActivity: { points: [] } } },
  };
}

function settledSection(data: unknown) {
  return {
    isSuccess: true,
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData: false,
    data,
  };
}

function stubSections() {
  hooks.useDeliveryInsights.mockReturnValue(
    settledSection({ kpis: [], charts: { prTrend: { points: [] } } })
  );
  hooks.useUtilizationInsights.mockImplementation(
    (period: InsightsPeriod, scope: InsightsScope) =>
      utilizationFor(period, scope)
  );
  hooks.useAgentsInsights.mockReturnValue(
    settledSection({ kpis: [], charts: { modelBreakdown: [] } })
  );
  hooks.useAgentSessions.mockReturnValue({
    data: { total: UNFILTERED_LIST_TOTAL, items: [] },
    isLoading: false,
    isSuccess: true,
    isError: false,
    dataUpdatedAt: 1,
  });
}

function installDesktopApi() {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        getInsights: vi.fn(async () => ({ charts: {}, kpis: [] })),
      },
      getGitHubIntegrationStatus: vi.fn(async () => ({ connected: true })),
      openGitHubConnect: vi.fn(async () => ({ ok: true })),
    },
  });
}

/**
 * The Organization segment's visible label, from the toggle's own option list.
 * Throws rather than falling back: a `?? "Organization"` would let the segment
 * be renamed and keep this file green against a label nothing renders.
 */
function orgScopeLabel(): string {
  const option = SCOPE_TOGGLE_OPTIONS.find(
    (candidate) => candidate.value === InsightsScope.Org
  );
  if (!option) {
    throw new Error("The scope toggle no longer offers an Organization option");
  }
  return option.label;
}

function dashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const memory = createMemoryNavigation({ initialPath: "/dashboard" });
  return (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider adapter={memory.adapter}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <DashboardPage />
        </FeatureFlagAdapterProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
}
