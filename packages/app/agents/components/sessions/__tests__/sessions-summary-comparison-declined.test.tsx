import {
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionUsageComparisonDeltas } from "@repo/api/src/types/agent-session-usage-comparison";
import { SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/sessions-summary-honest-loading-flag";
import {
  buildSessionSummaryDeltas,
  type SessionSummaryDeltas,
} from "@repo/app/agents/lib/session-summary-deltas";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { SESSIONS_METRIC_CARD_LABEL } from "../sessions-summary-card-labels";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/**
 * ISS-7525 — a settled comparison the producer DECLINED must not be printed as
 * a prior period that never existed.
 *
 * Three settled states, and the defect was the second rendering as the third:
 *
 *  1. PRESENT — the producer measured a prior window and emitted a percent, so
 *     the card grades a movement.
 *  2. DECLINED — it measured a prior window and emitted NO percent for this
 *     card: the base was too near zero to divide by, or the magnitude ran past
 *     the display ceiling `pctDelta` refuses to clamp. A prior period exists
 *     and was read.
 *  3. ABSENT — there is no prior window in hand at all: an "All time" range, or
 *     a response that carried no comparison.
 *
 * Each case below pins one of the three AND denies the other two. A fixture
 * covering only two would BE the collapse under repair, so the states are
 * driven from three genuinely different payloads rather than from three
 * hand-built delta objects: the wire shape is where the difference originates,
 * and `buildSessionSummaryDeltas` is the production function that has to carry
 * it through.
 *
 * Everything renders through the real strip under the real flag provider, so a
 * gate mounted where it cannot see the provider resolves OFF and the flag-ON
 * cases below fail rather than passing for the wrong reason.
 */

/**
 * The shipped words, written out here rather than imported from the module that
 * produces them. A test that reads its expectation from the thing it polices
 * cannot notice that thing changing.
 */
const NO_PRIOR_PERIOD = "No prior period";
const DECLINED = "No comparison";
/** ISS-7422's announced name for the pending slot, restated for the same reason. */
const PENDING_NAME = "Comparison loading";

/** `MetricCard`'s chip marker — the presence test for a graded movement. */
const DELTA_CHIP = "metric-delta-chip";

/** Any bounded range: one exists before it, which is the whole precondition. */
const BOUNDED_RANGE: DateRange = "30d";

/** A movement no other fixture produces, so a chip cannot be mistaken for one. */
const PRESENT_DELTAS: AgentSessionUsageComparisonDeltas = { sessions: 63 };
const PRESENT_CHIP_TEXT = "+63%";

/**
 * A usage payload, built through the shared fixture rather than a hand-typed
 * literal (`packages/app/agents/AGENTS.md`: "Props for isolated stories and
 * tests come from `session-list-fixtures.ts` … so a shape change lands in one
 * place"). Only the fields this suite actually reasons about are overridden.
 *
 * `deltas` distinguishes the two absences the ticket is about: `undefined`
 * means the response carried NO comparison, while `{}` means a comparison rode
 * the response — window bounds and all — and named no metric. Collapsing those
 * two into one parameter is exactly the collapse under test, so the check is
 * `=== undefined` and not a truthiness test: `{}` is falsy-adjacent enough that
 * a bare `deltas ? … : undefined` would silently erase the declined case.
 */
function usageFixture(
  deltas?: AgentSessionUsageComparisonDeltas
): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      apiEstimatedCost: 42,
      comparison:
        deltas === undefined
          ? undefined
          : {
              priorStartDate: "2026-07-01T00:00:00.000Z",
              priorEndDate: "2026-07-30T23:59:59.999Z",
              deltas,
            },
      totalEstimatedCost: 42,
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalSessions: 12,
    }
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

/**
 * The web Sessions page's settled wiring: the payload, the production delta
 * build, and the strip — mounted under the provider that actually answers the
 * flag read inside `AlwaysAvailableCards`.
 */
function renderStrip({
  usage,
  honestLoadingEnabled,
  dateRange = BOUNDED_RANGE,
}: {
  usage: AgentSessionUsageSummary | undefined;
  honestLoadingEnabled: boolean;
  dateRange?: DateRange;
}): HTMLElement {
  const deltas = buildSessionSummaryDeltas({
    current: usage,
    dateRange,
    pending: false,
    suppressed: false,
  });
  render(
    <AppCoreStoryProviders
      enabledFlags={
        honestLoadingEnabled ? [SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY] : []
      }
    >
      <SessionsSummaryCards deltas={deltas} isLoading={false} usage={usage} />
    </AppCoreStoryProviders>
  );
  // Anchored on a card that is definitely rendered before anything is asserted
  // absent: a `queryByText(...)` on a strip that never mounted would pass for
  // the wrong reason.
  return cardFor(SESSIONS_METRIC_CARD_LABEL);
}

/**
 * Render a delta object the strip is handed DIRECTLY, bypassing
 * `buildSessionSummaryDeltas`.
 *
 * Needed for the precedence case only. The builder cannot emit `pending` and
 * `priorPeriodMeasured` together — `pending` rides its suppressed early return
 * and the other is set past it — but the exported TYPE permits both, so the
 * resolver's documented ordering is a contract of the resolver rather than an
 * accident of one producer, and it has to be reachable to be pinned.
 */
function renderDeltas(
  deltas: SessionSummaryDeltas,
  honestLoadingEnabled: boolean
): HTMLElement {
  render(
    <AppCoreStoryProviders
      enabledFlags={
        honestLoadingEnabled ? [SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY] : []
      }
    >
      <SessionsSummaryCards
        deltas={deltas}
        isLoading={false}
        usage={usageFixture(PRESENT_DELTAS)}
      />
    </AppCoreStoryProviders>
  );
  return cardFor(SESSIONS_METRIC_CARD_LABEL);
}

describe("the settled delta slot, gate ON (ISS-7525)", () => {
  it("grades the movement when the producer emitted one", () => {
    const card = renderStrip({
      honestLoadingEnabled: true,
      usage: usageFixture(PRESENT_DELTAS),
    });

    expect(within(card).getByTestId(DELTA_CHIP)).toHaveTextContent(
      PRESENT_CHIP_TEXT
    );
    expect(within(card).queryByText(DECLINED)).toBeNull();
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).toBeNull();
  });

  /**
   * The ticket. Pre-fix, this card printed "No prior period" over a prior
   * period the response is carrying the dates of — so this case cannot pass
   * against pre-fix code, and collapsing DECLINED back into ABSENT (in the
   * builder or in the resolver) turns it red again.
   */
  it("says the comparison was declined, not that no prior period existed", () => {
    const card = renderStrip({
      honestLoadingEnabled: true,
      usage: usageFixture({}),
    });

    expect(within(card).getByText(DECLINED)).toBeInTheDocument();
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).toBeNull();
    expect(within(card).queryByTestId(DELTA_CHIP)).toBeNull();
  });

  it("still says 'No prior period' when the response carried no comparison", () => {
    const card = renderStrip({
      honestLoadingEnabled: true,
      usage: usageFixture(),
    });

    expect(within(card).getByText(NO_PRIOR_PERIOD)).toBeInTheDocument();
    expect(within(card).queryByText(DECLINED)).toBeNull();
    expect(within(card).queryByTestId(DELTA_CHIP)).toBeNull();
  });

  /**
   * "All time" has no window before it. That is a fact about the RANGE, so it
   * outranks a comparison the producer somehow sent — the payload here carries
   * one, entries and all, and the card must still deny a prior period rather
   * than report a decline.
   */
  it("keeps 'No prior period' on an unbounded range whatever the payload holds", () => {
    const card = renderStrip({
      dateRange: "all",
      honestLoadingEnabled: true,
      usage: usageFixture(PRESENT_DELTAS),
    });

    expect(within(card).getByText(NO_PRIOR_PERIOD)).toBeInTheDocument();
    expect(within(card).queryByText(DECLINED)).toBeNull();
    expect(within(card).queryByTestId(DELTA_CHIP)).toBeNull();
  });
});

/**
 * The ordering `honestSummaryDeltaPlaceholder` documents, made enforceable.
 *
 * A comment defending a branch order that nothing exercises is a comment a
 * refactor inverts silently — swapping the two `if`s passed every other test in
 * this suite before this block existed.
 */
describe("pending outranks a measured prior period (ISS-7525)", () => {
  it("shimmers rather than reporting a decline while the read is in flight", () => {
    const card = renderDeltas(
      {
        deliveryCompared: false,
        label: "vs. prior 30 days",
        pending: true,
        priorPeriodMeasured: true,
      },
      true
    );

    // The shimmer is aria-hidden, so the STATE is asserted on its announced
    // name — the same thing a screen reader would receive.
    expect(within(card).getByText(PENDING_NAME)).toBeInTheDocument();
    expect(within(card).queryByText(DECLINED)).toBeNull();
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).toBeNull();
  });

  it("reports the decline once that same object is no longer pending", () => {
    const card = renderDeltas(
      {
        deliveryCompared: false,
        label: "vs. prior 30 days",
        priorPeriodMeasured: true,
      },
      true
    );

    expect(within(card).getByText(DECLINED)).toBeInTheDocument();
    expect(within(card).queryByText(PENDING_NAME)).toBeNull();
  });
});

/**
 * The shipped default. Every case here passes against pre-fix code, which is
 * the point: they guard the closed default, not the repair.
 */
describe("the settled delta slot, gate OFF (ISS-7525)", () => {
  it("renders the pre-ISS-7525 wording for a declined comparison", () => {
    const card = renderStrip({
      honestLoadingEnabled: false,
      usage: usageFixture({}),
    });

    expect(within(card).getByText(NO_PRIOR_PERIOD)).toBeInTheDocument();
    expect(within(card).queryByText(DECLINED)).toBeNull();
  });

  it("still grades a movement the producer emitted", () => {
    const card = renderStrip({
      honestLoadingEnabled: false,
      usage: usageFixture(PRESENT_DELTAS),
    });

    expect(within(card).getByTestId(DELTA_CHIP)).toHaveTextContent(
      PRESENT_CHIP_TEXT
    );
    expect(within(card).queryByText(DECLINED)).toBeNull();
  });
});
