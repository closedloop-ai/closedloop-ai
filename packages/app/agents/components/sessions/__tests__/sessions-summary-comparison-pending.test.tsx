import type { AgentSessionsPageData } from "@repo/api/src/types/agent-session";
import {
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionUsageComparisonDeltas } from "@repo/api/src/types/agent-session-usage-comparison";
import { SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/sessions-summary-honest-loading-flag";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import {
  useAgentSessionsPageData,
  useAgentSessionUsage,
} from "@repo/app/agents/hooks/use-agent-sessions";
import {
  buildSessionSummaryDeltas,
  isSessionComparisonPending,
  type SessionSummaryDeltas,
  shouldSuppressSessionComparison,
} from "@repo/app/agents/lib/session-summary-deltas";
import { KPI_NOT_COMPUTED_REASON } from "@repo/app/insights/lib/kpi-no-comparison-copy";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import {
  keepPreviousData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  PRS_SHIPPED_METRIC_CARD_LABEL,
  SESSIONS_METRIC_CARD_LABEL,
} from "../sessions-summary-card-labels";
import { SessionsSummaryCards } from "../sessions-summary-cards";
import { SessionsSummaryCardsLoading } from "../sessions-summary-cards-loading";
import { SUMMARY_COMPARISON_PENDING_LABEL } from "../sessions-summary-delta-slots";

/**
 * ISS-7422 — the Sessions KPI comparison must never render a SETTLED negative
 * while the read behind it is still in flight.
 *
 * Three states, and the defect was that the first got printed as the second:
 *  1. pending — the comparison for the requested scope is not known yet;
 *  2. settled, no prior period — a real claim, which "All time" earns;
 *  3. settled, comparison exists — the graded chip.
 *
 * Each block below pins one of the three AND denies the other two, because the
 * bug was not "the wrong pixels" but two states rendering as one: a test that
 * accepted any two of these as interchangeable would be the very collapse under
 * repair.
 *
 * Reads are held open with an unresolved promise rather than a timer, so every
 * assertion runs against a stable blocking state instead of a wall-clock guess.
 */

const DELTA_CHIP = "metric-delta-chip";
const DELTA_PLACEHOLDER = "kpi-delta-placeholder";
const NO_PRIOR_PERIOD = "No prior period";
/** Pinned from the ticket's own production screenshot, not read from the code. */
const SETTLED_CHIP_TEXT = "+63%";
/**
 * A movement the settled fixture never produces, so the out-of-order case below
 * can tell "the superseded range's answer" apart from "the current one".
 */
const SUPERSEDED_SESSIONS = 12;
const SUPERSEDED_CHIP_TEXT = "+12%";
/** Long enough that no range's cache entry is evicted mid-test. */
const RETAIN_CACHE_MS = 5 * 60 * 1000;

// Typed, NOT cast. An `as AgentSessionUsageSummary` here hid a fixture whose
// comparison window used `priorStart`/`priorEnd` — fields the wire contract does
// not have — which would have quietly become the shape everyone copied.
function usageFixture(
  deltas?: AgentSessionUsageComparisonDeltas
): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 42,
    byHarness: [],
    byModel: [],
    byRepository: [],
    byUser: [],
    comparison: deltas
      ? {
          priorStartDate: "2026-05-01T00:00:00.000Z",
          priorEndDate: "2026-07-30T00:00:00.000Z",
          deltas,
        }
      : undefined,
    earliestSessionAt: null,
    lastSyncTargets: [],
    latestSessionAt: null,
    mergedLocPerDollar: 3.5,
    mergedPrCount: 7,
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 42,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalSessions: 12,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

/**
 * The web Sessions page's comparison wiring, in the order the page runs it: the
 * `keepPreviousData` usage read, the suppression gate, the delta build, and the
 * strip's own `isLoading` (which the page derives from `isPlaceholderData`).
 */
function Host({
  dateRange,
  honestLoadingEnabled = true,
  comparisonV2Enabled = false,
}: {
  dateRange: DateRange;
  honestLoadingEnabled?: boolean;
  comparisonV2Enabled?: boolean;
}) {
  const query = useAgentSessionUsage(
    { startDate: `${dateRange}-start`, endDate: `${dateRange}-end` },
    { placeholderData: keepPreviousData }
  );
  const deltas = buildSessionSummaryDeltas({
    comparisonV2Enabled,
    current: query.data,
    dateRange,
    pending: isSessionComparisonPending(query),
    suppressed: shouldSuppressSessionComparison(query, honestLoadingEnabled),
  });
  return (
    <SessionsSummaryCards
      deltas={deltas}
      // `isLoadingError`, not `isError` — the page's own choice, and the reason
      // a failed refetch holding last-good data renders as a SETTLED card. That
      // asymmetry is what makes the errored case below worth pinning.
      isError={query.isLoadingError}
      isLoading={query.isLoading || query.isPlaceholderData}
      usage={query.data}
    />
  );
}

/**
 * The DESKTOP Sessions surface's comparison wiring, in the order `SessionsView`
 * runs it: the combined `pageData` read with `keepPreviousData`, the summary
 * lifted off `pageData.usage`, and the same pending derivation the web host uses.
 *
 * Deliberately the same strip and the same delta builder as {@link Host} — the
 * point of difference under test is the READ and its query key, so everything
 * downstream is held identical rather than re-mocked.
 */
function DesktopHost({ dateRange }: { dateRange: DateRange }) {
  const query = useAgentSessionsPageData(
    { startDate: `${dateRange}-start`, endDate: `${dateRange}-end` },
    { placeholderData: keepPreviousData }
  );
  const usage = query.data?.usage;
  const deltas = buildSessionSummaryDeltas({
    comparisonV2Enabled: false,
    current: usage,
    dateRange,
    pending: isSessionComparisonPending(query),
    suppressed: shouldSuppressSessionComparison(query, true),
  });
  return (
    <SessionsSummaryCards
      deltas={deltas}
      isError={query.isLoadingError}
      isLoading={query.isLoading || query.isPlaceholderData}
      usage={usage}
    />
  );
}

/**
 * A silent observer of one range's read, mounted beside the visible host in the
 * AC4 cases below.
 *
 * ISS-7852 is why it exists. The summary hooks now consume TanStack Query's
 * `AbortSignal`, so a range that loses its LAST observer is CANCELLED and its
 * late answer is never written to the cache at all — strictly stronger than the
 * "canceled, ignored, or deduplicated" disjunction AC4 accepted, and pinned in
 * its own right by `use-agent-sessions-abort-signal.test.tsx` plus the two
 * surface suites. But it also makes the mechanism THESE cases exist for
 * unobservable: an answer that never arrives cannot demonstrate that arriving
 * late is harmless. Keeping one observer on the superseded range holds its query
 * alive, so the answer really does land after the newer one and AC4's question —
 * can it reach the entry the visible card reads? — is asked rather than
 * sidestepped. That is not a contrivance: any surface that still holds the older
 * range open, and any response already on the wire when a source ignores the
 * signal, is this shape.
 */
function SupersededUsageProbe({ dateRange }: { dateRange: DateRange }) {
  useAgentSessionUsage(rangeFilters(dateRange));
  return null;
}

/** The `pageData` twin of {@link SupersededUsageProbe}, for the desktop case. */
function SupersededPageDataProbe({ dateRange }: { dateRange: DateRange }) {
  useAgentSessionsPageData(rangeFilters(dateRange));
  return null;
}

/** The filters both hosts build for a range, in one place. */
function rangeFilters(dateRange: DateRange) {
  return {
    startDate: `${dateRange}-start`,
    endDate: `${dateRange}-end`,
  };
}

/** The combined desktop payload, carrying the same summary the web read serves. */
function pageDataFixture(
  deltas?: AgentSessionUsageComparisonDeltas
): AgentSessionsPageData {
  return {
    list: { sessions: [], total: 0 },
    usage: usageFixture(deltas),
  } as unknown as AgentSessionsPageData;
}

function createPageDataSource(
  pageData: AgentSessionsDataSource["pageData"]
): AgentSessionsDataSource {
  return {
    scope: "source",
    list: vi.fn().mockRejectedValue(new Error("list unused")),
    detail: vi.fn().mockRejectedValue(new Error("detail unused")),
    usage: vi.fn().mockRejectedValue(new Error("usage unused")),
    pageData,
    analytics: vi.fn().mockRejectedValue(new Error("analytics unused")),
  } as unknown as AgentSessionsDataSource;
}

/**
 * The desktop twin of {@link cachedComparisonMovements}: every sessions movement
 * any cached PAGE-DATA entry holds, reached through `.usage` because that is
 * where the combined payload keeps the summary. Read from the cache itself, so
 * the observation stays independent of the keying it is used to police.
 */
function cachedPageDataMovements(client: QueryClient): (number | undefined)[] {
  return client
    .getQueryCache()
    .getAll()
    .map(
      (query) =>
        (query.state.data as AgentSessionsPageData | undefined)?.usage
          ?.comparison?.deltas.sessions
    );
}

function createSource(
  usage: AgentSessionsDataSource["usage"]
): AgentSessionsDataSource {
  return {
    scope: "source",
    list: vi.fn().mockRejectedValue(new Error("list unused")),
    detail: vi.fn().mockRejectedValue(new Error("detail unused")),
    usage,
    pageData: vi.fn().mockRejectedValue(new Error("pageData unused")),
    analytics: vi.fn().mockRejectedValue(new Error("analytics unused")),
  } as unknown as AgentSessionsDataSource;
}

/**
 * Both defaults are the point of the fixture, not shortcuts. A retained cache
 * entry (`gcTime`) plus `staleTime: 0` is exactly the state the web shell is in
 * when a reader re-selects a range more than sixty seconds after first viewing
 * it: the figures are served from cache immediately — so the host does NOT
 * skeleton — while the read revalidates underneath them.
 */
function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: RETAIN_CACHE_MS, staleTime: 0 },
    },
  });
}

function wrapper(
  source: AgentSessionsDataSource,
  honestLoadingEnabled: boolean,
  // Passed in only by the case that must OBSERVE the cache rather than the
  // render — see the out-of-order block.
  client: QueryClient = buildQueryClient()
) {
  // The story providers supply the auth/API stack `useAgentSessionsDataSource`
  // constructs its fallback client against (a documented requirement even for an
  // injected source). Its own QueryClient pins `staleTime` at infinity, so ours
  // is nested INSIDE it and is the one the read hooks resolve.
  // One key gates both halves in production — the host's suppression decision
  // and the strip's own placeholder — so the fixture flips them together. Two
  // independently-set gates would let this suite pass a build where only one
  // of them actually read the flag.
  return ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders
      enabledFlags={
        honestLoadingEnabled ? [SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY] : []
      }
    >
      <QueryClientProvider client={client}>
        <AgentSessionsDataSourceProvider dataSource={source}>
          {children}
        </AgentSessionsDataSourceProvider>
      </QueryClientProvider>
    </AppCoreStoryProviders>
  );
}

/**
 * Every sessions movement any cache entry currently holds — read from the cache
 * itself, never from a key this test reconstructs, so the observation stays
 * independent of the keying it is used to police.
 */
function cachedComparisonMovements(
  client: QueryClient
): (number | undefined)[] {
  return client
    .getQueryCache()
    .getAll()
    .map(
      (query) =>
        (query.state.data as AgentSessionUsageSummary | undefined)?.comparison
          ?.deltas.sessions
    );
}

/** The card carrying `label`, so an assertion cannot drift onto a sibling. */
function cardFor(label: string): HTMLElement {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error(`No metric card found for "${label}"`);
  }
  return card;
}

function sessionsCard(): HTMLElement {
  return cardFor(SESSIONS_METRIC_CARD_LABEL);
}

/**
 * Drive the reported journey: settle 7d, settle 30d, then re-select 7d, whose
 * revalidation is held open. Returns once that third read is in flight.
 */
async function reachHeldRevalidation(honestLoadingEnabled: boolean) {
  const held = deferred<AgentSessionUsageSummary>();
  let call = 0;
  const usage = vi.fn().mockImplementation(() => {
    call += 1;
    // Calls 1 and 2 settle the two ranges. Call 3 is the revalidation of the
    // re-selected 7d range, and is held open for the assertions.
    if (call >= 3) {
      return held.promise;
    }
    return Promise.resolve(usageFixture({ sessions: 63 }));
  });
  const Wrapper = wrapper(createSource(usage), honestLoadingEnabled);
  const props = { honestLoadingEnabled };

  const view = render(<Host dateRange="7d" {...props} />, { wrapper: Wrapper });

  // Positive sibling: the settled 7d view really does render the chip, so the
  // negative assertions below cannot pass on a card that never compares at all.
  await waitFor(() =>
    expect(within(sessionsCard()).getByTestId(DELTA_CHIP)).toHaveTextContent(
      SETTLED_CHIP_TEXT
    )
  );

  view.rerender(<Host dateRange="30d" {...props} />);
  await waitFor(() =>
    expect(within(sessionsCard()).getByTestId(DELTA_CHIP)).toBeInTheDocument()
  );

  view.rerender(<Host dateRange="7d" {...props} />);
  await waitFor(() => expect(usage).toHaveBeenCalledTimes(3));
  return { held, view };
}

describe("Sessions KPI comparison across a range change (ISS-7422)", () => {
  it("keeps the settled comparison while the re-selected range revalidates", async () => {
    const { held } = await reachHeldRevalidation(true);

    const card = sessionsCard();
    // The figures are on screen unskeletoned, so whatever fills the delta slot
    // reads as settled. It must not be the no-prior-period claim...
    expect(within(card).getByText("12")).toBeInTheDocument();
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).toBeNull();
    // ...and the comparison we are still holding is the honest thing to show:
    // it came from the same response as the figures beside it.
    expect(within(card).getByTestId(DELTA_CHIP)).toHaveTextContent(
      SETTLED_CHIP_TEXT
    );

    held.resolve(usageFixture({ sessions: 63 }));
    await waitFor(() =>
      expect(within(sessionsCard()).getByTestId(DELTA_CHIP)).toHaveTextContent(
        SETTLED_CHIP_TEXT
      )
    );
  });

  // The gate's other branch must be able to fail this suite: with it off the
  // strip is expected to behave exactly as it shipped, false claim included.
  // Without this, a build that silently resolved the flag OFF everywhere would
  // still pass the block above.
  it("still shows the pre-gate false claim when the flag is off", async () => {
    const { held } = await reachHeldRevalidation(false);

    const card = sessionsCard();
    expect(within(card).getByText("12")).toBeInTheDocument();
    expect(within(card).getByText(NO_PRIOR_PERIOD)).toBeInTheDocument();
    expect(within(card).queryByTestId(DELTA_CHIP)).toBeNull();

    held.resolve(usageFixture({ sessions: 63 }));
  });

  // The mirror-image false claim, and the one three reviewers caught in the
  // first cut of this fix. A refetch that FAILS while last-good data is retained
  // has settled — on a failure. `isLoadingError` is false there, so the page
  // deliberately keeps rendering the settled cards; announcing "Comparison
  // loading" over them promises an arrival from a read that has already stopped
  // and will not resume on its own.
  it("does not announce a wait after the revalidation has failed", async () => {
    const { held } = await reachHeldRevalidation(true);

    held.reject(new Error("usage refetch failed"));
    // The settled figures are the stable state to wait on — the failure keeps
    // them, so their presence alone cannot prove the rejection landed.
    await waitFor(() =>
      expect(
        within(sessionsCard()).queryByText(SUMMARY_COMPARISON_PENDING_LABEL)
      ).toBeNull()
    );

    const card = sessionsCard();
    // No live region left claiming a fetch, under either query.
    expect(within(card).queryByRole("status")).toBeNull();
    // Positive siblings: the card is genuinely still rendering its settled
    // figure, so the two negatives above are not satisfied by an absent card.
    expect(within(card).getByText("12")).toBeInTheDocument();
    expect(within(card).getByText(SESSIONS_METRIC_CARD_LABEL)).toBeVisible();
  });
});

/**
 * ISS-7422 AC4 — latest-selection-wins. The ticket accepts cancellation,
 * ignoring, or deduplication; the read is keyed by its filters, so a superseded
 * range's answer lands in ITS OWN cache entry and the mounted entry is never
 * written by it. That is a real mechanism and nothing pinned it: flattening the
 * key (dropping `filters`, or scoping only by data source) would silently make
 * the two ranges share one entry and hand the reader the loser of a race, which
 * is the defect the reporter would have described next.
 *
 * The superseded response is made to arrive strictly AFTER the newer one, since
 * a case where it arrives first proves nothing a naive implementation would not
 * also pass.
 *
 * ISS-7852 later took the CANCELLATION arm of that disjunction too, which is why
 * both cases now mount a probe to keep the superseded read alive — see
 * {@link SupersededUsageProbe} for why that keeps the key mechanism under test
 * instead of quietly retiring it.
 */
describe("a superseded range cannot overwrite the latest selection (ISS-7422)", () => {
  it("keeps the newest range's comparison when the older read lands after it", async () => {
    const supersededRead = deferred<AgentSessionUsageSummary>();
    const usage = vi
      .fn()
      .mockImplementation((filters: { startDate?: string }) =>
        filters.startDate === "7d-start"
          ? supersededRead.promise
          : Promise.resolve(usageFixture({ sessions: 63 }))
      );
    const client = buildQueryClient();
    const Wrapper = wrapper(createSource(usage), true, client);

    const view = render(
      <>
        <Host dateRange="7d" />
        <SupersededUsageProbe dateRange="7d" />
      </>,
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(1));

    // 30d is selected while 7d is still open, and settles first. The probe stays
    // on 7d so that read is not cancelled (see SupersededUsageProbe) and its
    // answer genuinely lands late — which is the premise of this case.
    view.rerender(
      <>
        <Host dateRange="30d" />
        <SupersededUsageProbe dateRange="7d" />
      </>
    );
    await waitFor(() =>
      expect(within(sessionsCard()).getByTestId(DELTA_CHIP)).toHaveTextContent(
        SETTLED_CHIP_TEXT
      )
    );
    // Nothing holds the superseded movement yet, so the wait below is a real
    // wait rather than a condition that is already true.
    expect(cachedComparisonMovements(client)).not.toContain(
      SUPERSEDED_SESSIONS
    );

    // Only now does the abandoned 7d read answer — with a movement 30d never
    // produces, so a card that adopted it would say so unmistakably.
    supersededRead.resolve(usageFixture({ sessions: SUPERSEDED_SESSIONS }));
    // Wait for the DELIVERY, not for a call count: the superseded answer is in
    // the cache. Asserting the render before this point would race the write
    // the case exists to catch. Observed through the cache rather than a key
    // this test builds, so a flattened key still satisfies it — and then fails
    // the render assertions below, which is exactly the defect being policed.
    await waitFor(() =>
      expect(cachedComparisonMovements(client)).toContain(SUPERSEDED_SESSIONS)
    );

    const card = sessionsCard();
    expect(within(card).getByTestId(DELTA_CHIP)).toHaveTextContent(
      SETTLED_CHIP_TEXT
    );
    expect(within(card).queryByText(SUPERSEDED_CHIP_TEXT)).toBeNull();
  });
});

/**
 * ISS-7422 AC4 on the DESKTOP path (#5852 review, whitlockk).
 *
 * The block above pins the web page, which reads the summary through
 * `useAgentSessionUsage`. Desktop does not: `SessionsView` takes the summary out
 * of the COMBINED `useAgentSessionsPageData` read and feeds `usage` from it. The
 * two reads have different query keys and different payload shapes, so a web-only
 * case cannot speak for the desktop surface — and the mechanism AC4 relies on is
 * a property of the KEY, which is exactly what differs.
 *
 * `agentSessionKeys.pageData(scope, filters)` carries `filters`, so a superseded
 * range lands in its own entry here for the same reason it does on the web. This
 * case is what stops that being an accident: flattening the pageData key would
 * leave the web block green and hand the desktop reader the loser of the race.
 */
describe("a superseded range cannot overwrite the latest selection — desktop pageData path (ISS-7422)", () => {
  it("keeps the newest range's comparison when the older pageData read lands after it", async () => {
    const supersededRead = deferred<AgentSessionsPageData>();
    const pageData = vi
      .fn()
      .mockImplementation((filters: { startDate?: string }) =>
        filters.startDate === "7d-start"
          ? supersededRead.promise
          : Promise.resolve(pageDataFixture({ sessions: 63 }))
      );
    const client = buildQueryClient();
    const Wrapper = wrapper(createPageDataSource(pageData), true, client);

    const view = render(
      <>
        <DesktopHost dateRange="7d" />
        <SupersededPageDataProbe dateRange="7d" />
      </>,
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(pageData).toHaveBeenCalledTimes(1));

    // The probe holds the 7d read open past the switch, so ISS-7852's
    // cancellation does not pre-empt the late answer this case is about.
    view.rerender(
      <>
        <DesktopHost dateRange="30d" />
        <SupersededPageDataProbe dateRange="7d" />
      </>
    );
    await waitFor(() =>
      expect(within(sessionsCard()).getByTestId(DELTA_CHIP)).toHaveTextContent(
        SETTLED_CHIP_TEXT
      )
    );
    // The superseded movement is nowhere yet, so the wait below is a real wait
    // and not a condition that was already true when it was written.
    expect(cachedPageDataMovements(client)).not.toContain(SUPERSEDED_SESSIONS);

    supersededRead.resolve(pageDataFixture({ sessions: SUPERSEDED_SESSIONS }));
    // Wait for the DELIVERY into the cache, not for a call count: asserting the
    // render before the superseded answer has actually landed would race the
    // write this case exists to catch. Observed through the cache rather than a
    // key this test rebuilds, so a flattened key still satisfies THIS wait — and
    // then fails the render assertions below, which is the defect being policed.
    await waitFor(() =>
      expect(cachedPageDataMovements(client)).toContain(SUPERSEDED_SESSIONS)
    );

    const card = sessionsCard();
    expect(within(card).getByTestId(DELTA_CHIP)).toHaveTextContent(
      SETTLED_CHIP_TEXT
    );
    expect(within(card).queryByText(SUPERSEDED_CHIP_TEXT)).toBeNull();
  });
});

/**
 * The three states as the strip renders them, asserted against hand-built delta
 * objects so each one is pinned on its own rather than inferred from the others.
 */
describe("pending, settled-absent and settled-compared are three states", () => {
  const BOUNDED_LABEL = "vs. prior 90 days";

  function renderStrip(deltas: SessionSummaryDeltas) {
    render(
      <AppCoreStoryProviders
        enabledFlags={[SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY]}
      >
        <SessionsSummaryCards
          deltas={deltas}
          isLoading={false}
          usage={usageFixture()}
        />
      </AppCoreStoryProviders>
    );
    return sessionsCard();
  }

  it("shimmers with an announced loading name while the comparison is pending", () => {
    const card = renderStrip({ label: BOUNDED_LABEL, pending: true });

    // Asserted on the announced NAME, not on visibility: the shimmer itself is
    // `aria-hidden`, and `toBeVisible` would accept a clipped node anyway.
    expect(
      within(card).getByText(SUMMARY_COMPARISON_PENDING_LABEL)
    ).toBeInTheDocument();
    expect(within(card).getByRole("status")).toBeInTheDocument();
    // Neither of the two SETTLED states may appear here.
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).toBeNull();
    expect(within(card).queryByTestId(DELTA_CHIP)).toBeNull();
  });

  it("states 'No prior period' only once the read has settled without one", () => {
    const card = renderStrip({ label: BOUNDED_LABEL });

    expect(within(card).getByText(NO_PRIOR_PERIOD)).toBeInTheDocument();
    expect(
      within(card).queryByText(SUMMARY_COMPARISON_PENDING_LABEL)
    ).toBeNull();
    expect(within(card).queryByTestId(DELTA_CHIP)).toBeNull();
  });

  it("grades the movement once the comparison has landed", () => {
    const card = renderStrip({
      label: BOUNDED_LABEL,
      sessions: { delta: 63, deltaPolarity: MetricPolarity.HigherIsBetter },
    });

    expect(within(card).getByTestId(DELTA_CHIP)).toHaveTextContent(
      SETTLED_CHIP_TEXT
    );
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).toBeNull();
    expect(
      within(card).queryByText(SUMMARY_COMPARISON_PENDING_LABEL)
    ).toBeNull();
  });

  // "All time" has no window before it — a fact about the RANGE, not about any
  // read — so it must keep the settled sentence even while a read is in flight.
  // This is the one case where pending must NOT win.
  it("keeps the settled sentence on an unbounded range mid-read", () => {
    const card = renderStrip(
      buildSessionSummaryDeltas({
        current: undefined,
        dateRange: "all",
        pending: true,
        suppressed: true,
      })
    );

    expect(within(card).getByText(NO_PRIOR_PERIOD)).toBeInTheDocument();
    expect(
      within(card).queryByText(SUMMARY_COMPARISON_PENDING_LABEL)
    ).toBeNull();
  });
});

/**
 * The DELIVERY pair, whose two cards must not half-adopt the pending state.
 *
 * `PRs Shipped` is compared, so its comparison can be in flight. `LOC / $` never
 * is — its prior-window spend is read after the delivery pass, so a prior ratio
 * would divide prior lines by CURRENT dollars — and a card that can never be
 * compared must never shimmer as though one might arrive.
 */
describe("the delivery pair's pending state (ISS-7422)", () => {
  const PENDING_DELIVERY: SessionSummaryDeltas = {
    deliveryCompared: true,
    label: "vs. prior 90 days",
    pending: true,
  };

  function renderDeliveryStrip() {
    render(
      <AppCoreStoryProviders
        enabledFlags={[SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY]}
      >
        <SessionsSummaryCards
          deltas={PENDING_DELIVERY}
          isLoading={false}
          usage={usageFixture()}
        />
      </AppCoreStoryProviders>
    );
  }

  it("shimmers PRs Shipped while its comparison is in flight", () => {
    renderDeliveryStrip();

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(
      within(card).getByText(SUMMARY_COMPARISON_PENDING_LABEL)
    ).toBeInTheDocument();
    // Not the settled "no comparison for this range" verdict.
    expect(within(card).queryByTestId(DELTA_PLACEHOLDER)).toBeNull();
    // Positive sibling: the card is on its available branch rendering the real
    // count, which is the only branch that fills this slot at all.
    expect(within(card).getByText("7")).toBeInTheDocument();
  });

  it("never shimmers LOC / $, whose comparison is never computed", () => {
    renderDeliveryStrip();

    const card = cardFor(LOC_PER_DOLLAR_LABEL);
    // Waiting cannot produce this card's comparison, so the honest state stays
    // the never-computed reason — in the same render where its rowmate shimmers.
    expect(
      within(card).queryByText(SUMMARY_COMPARISON_PENDING_LABEL)
    ).toBeNull();
    expect(within(card).getByTestId(DELTA_PLACEHOLDER)).toBeInTheDocument();
    expect(
      within(card).getByText(`. ${KPI_NOT_COMPUTED_REASON}`)
    ).toBeInTheDocument();
  });
});

/**
 * The loading SHELL shares the shimmer's geometry with the settled strip but not
 * its announcement, and it ships UNGATED — so this ticket must leave it
 * unchanged. Its row carries `aria-busy`, which already tells assistive tech the
 * region is updating; a per-card live region there would be five voices for one
 * fact, and an ungated a11y change on the flag's closed path.
 */
describe("the loading shell's reserved slot is unchanged", () => {
  it("reserves with a bare shimmer and announces nothing per card", () => {
    const { container } = render(
      <SessionsSummaryCardsLoading
        cardClassName=""
        loadingDetail="Loading…"
        locPerDollarLabel={LOC_PER_DOLLAR_LABEL}
        reservesDeltaSlot
      />
    );

    // Positive: the slot IS still reserved on all five cards.
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length
    ).toBeGreaterThanOrEqual(5);
    // Negative: none of them carries the settled strip's announcement, and the
    // shell still states no verdict.
    expect(screen.queryByText(SUMMARY_COMPARISON_PENDING_LABEL)).toBeNull();
    expect(screen.queryByText(NO_PRIOR_PERIOD)).toBeNull();
  });
});
