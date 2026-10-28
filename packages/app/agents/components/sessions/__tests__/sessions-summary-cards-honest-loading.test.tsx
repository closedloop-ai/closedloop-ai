/**
 * ISS-5271 — the Sessions summary cards' honest never-loaded state, behind
 * `SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY` (default OFF).
 *
 * A sibling of `sessions-summary-cards.test.tsx` rather than more cases inside
 * it: that file is a whole-row suite already at the 1,000-line ceiling, and this
 * is a single, self-contained concern (which value a card reports when the usage
 * summary has never loaded).
 *
 * The defect these tests pin: when the usage query has not yet resolved
 * (`usage === undefined`) and there is no error, the Sessions and Total Tokens
 * cards fall back to `?? 0` and render a confident "0" beside a Cost card that
 * already honestly dashes — so the unflagged row reads `0 / 0 / —` and
 * contradicts itself. With the flag ON, those two cards skeleton their value
 * slot instead of fabricating a zero for a number that was never computed.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/**
 * The SHAPE comes from `createAgentSessionUsageSummaryFixture` per
 * `packages/app/agents/AGENTS.md` (whitlockk review), so a new
 * `AgentSessionUsageSummary` field lands in `session-list-fixtures.ts` alone.
 *
 * The wrapper survives only to name this suite's two shared non-default values,
 * which both call sites depend on: a non-zero `totalSessions` (so a settled read
 * has a distinguishable number) and a non-zero cost (so the Cost tile never
 * contributes a bare digit). The canonical fixture's all-zero TOKEN counters are
 * inherited deliberately — the asymmetry the settled-zero case documents below
 * rests on them.
 */
function usageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalSessions: 12,
      totalEstimatedCost: 42,
      apiEstimatedCost: 42,
      ...overrides,
    }
  );
}

/**
 * Render the summary cards with only `sessions-summary-honest-loading` enabled,
 * through the real `FeatureFlagAdapterProvider` seam both shells use — not a
 * stubbed boolean. Mirrors the per-key mechanism from the cost-honesty sibling
 * (`sessions-summary-cards-cost-honesty.test.tsx`).
 */
function renderWithHonestLoading(
  usage: AgentSessionUsageSummary | undefined,
  isError = false,
  extraProps: Partial<ComponentProps<typeof SessionsSummaryCards>> = {}
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY],
      })}
    >
      <SessionsSummaryCards
        isError={isError}
        isLoading={false}
        usage={usage}
        {...extraProps}
      />
    </FeatureFlagAdapterProvider>
  );
}

// FEA-4128: the three always-available cards — Sessions, Total Tokens, Cost —
// that can skeleton their value slot while a source hydrates.
const ALWAYS_AVAILABLE_CARD_COUNT = 3;

describe("ISS-5271 honest never-loaded state", () => {
  it("skeletons the always-available value slots and suppresses the fabricated '0' while usage has never loaded (flag ON)", () => {
    const { container } = renderWithHonestLoading(undefined);

    // No fabricated zero in any form — the value slot is skeletoned instead.
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByText("$0")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    // Card frames stay intact — labels are visible while the value hydrates.
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Total Tokens")).toBeInTheDocument();
    // One skeleton per always-available card (Sessions / Total Tokens / Cost).
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      ALWAYS_AVAILABLE_CARD_COUNT
    );
    // The row advertises its loading state to assistive technology.
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("clears skeletons and renders real values once usage settles (flag ON, last-good values unaffected)", () => {
    const { container } = renderWithHonestLoading(usageFixture());

    // The fixture has totalSessions: 12; a settled read shows the real value.
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("dashes all five cards on error without any skeleton — error outranks the never-loaded gate (flag ON)", () => {
    const { container } = renderWithHonestLoading(undefined, true);

    // A terminal error dashes rather than spins — the ISS-5271 arm checks
    // `!isError`, so cardsLoading stays false and the existing error contract
    // (five dashes, no skeleton) is unchanged.
    expect(screen.getAllByText("—")).toHaveLength(5);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("keeps rendering a TRUE settled zero as '0' (flag ON) — an honest empty is a measurement, not an unknown", () => {
    // The fixture is deliberately ASYMMETRIC: the default one zeroes all four
    // token counters, so Total Tokens would supply a "0" of its own and a
    // regression that dashed the SESSIONS card on a genuine zero would still
    // find one. Non-zero tokens make the single "0" in the tree unambiguously
    // the Sessions value, which is the card under test.
    const { container } = renderWithHonestLoading(
      usageFixture({ totalSessions: 0, totalInputTokens: 1000 })
    );

    // The counterfactual for every skeleton above: a cohort that genuinely
    // totals zero must still SAY zero. A fix that reaches this case has stopped
    // distinguishing "never asked" from "asked, and the answer is none".
    // `getByText` throws on a second match, so this also fails if some other
    // tile regresses into a zero.
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("skeletons rather than fabricating '0' when the local FALLBACK read errored while the cloud usage never loaded (flag ON)", () => {
    // ISS-7829. `isLocalError` is a fact about the local-fallback source, and it
    // outranks the loading arms so a failed fallback dashes instead of spinning
    // forever. But the cards only READ that source on the cloud-FAILURE path
    // (`isCloudReadFailed`), so with the cloud read merely unloaded — no error —
    // the local error suppressed every honest arm for a value it never supplied,
    // and the cards fell through to `?? 0`.
    //
    // Desktop Cloud mode SHIPS this combination (whitlockk review). When the list
    // wins the race and the usage half fails transiently, `metricReadErrored`
    // excludes it — pinned by "holds a transient USAGE error (not errored) while
    // recovery remains" in
    // apps/desktop/.../__tests__/sessions-transient-read-state.test.ts — so the
    // cards get `isError: false` with `usage` absent and `transientRecovering`
    // true, while the separate local fallback read errors on its own. See the
    // guard's docblock.
    const { container } = renderWithHonestLoading(undefined, false, {
      isLocalError: true,
      transientRecovering: true,
    });

    expect(screen.queryByText("0")).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      ALWAYS_AVAILABLE_CARD_COUNT
    );
  });

  it("skeletons the never-loaded cards when the local fallback errored and no transient recovery is in flight (flag ON)", () => {
    // The same hole reached through the ISS-5271 arm rather than the ISS-4483
    // one, so a fix that only re-orders the transient check does not pass.
    const { container } = renderWithHonestLoading(undefined, false, {
      isLocalError: true,
    });

    expect(screen.queryByText("0")).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      ALWAYS_AVAILABLE_CARD_COUNT
    );
  });

  it("still dashes without spinning when the local fallback errored AND the cloud read failed (flag ON)", () => {
    // The positive sibling of the two above, and the contract they must not
    // break: on the cloud-FAILURE path the cards genuinely are showing the local
    // fallback, so its terminal error is theirs to report — a dash, never a
    // skeleton that spins on a read that will not come.
    const { container } = renderWithHonestLoading(undefined, true, {
      isLocalError: true,
      transientRecovering: true,
    });

    expect(screen.getAllByText("—")).toHaveLength(5);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("renders the pre-existing fabricated '0' while flag is OFF — closed-by-default ships no perceivable change", () => {
    // No FeatureFlagAdapterProvider: `useFeatureFlagEnabledOptional` resolves to
    // false (OFF), so the ISS-5271 skeleton arm is inactive and the old `?? 0`
    // path runs — Sessions and Total Tokens both render "0" for an unloaded summary.
    render(<SessionsSummaryCards isLoading={false} usage={undefined} />);

    // Both Sessions ("0") and Total Tokens ("0") render the fabricated zero;
    // queryAllByText returns an array and never throws on multiple matches.
    expect(screen.queryAllByText("0")).not.toHaveLength(0);
  });

  it("keeps the local-fallback error outranking the transient arm while flag is OFF", () => {
    // ISS-7829's closed-by-default promise, made falsifiable. The guard reads
    // `!honestLoadingEnabled || isCloudReadFailed(...)`, and that first disjunct
    // is the ONLY thing holding flag-OFF behavior byte-for-byte. Dropping it —
    // the obvious "simplify this" cleanup — reroutes exactly this input into the
    // ISS-4483 transient arm and skeletons three cards with the flag off, which
    // no other case in the repo observes: the flag-OFF case above passes neither
    // prop, and the two flag-OFF `isLocalError` cases in the sibling suite set
    // `isError` (so the guard fires either way) or a defined `usage`.
    render(
      <SessionsSummaryCards
        isError={false}
        isLoading={false}
        isLocalError
        transientRecovering
        usage={undefined}
      />
    );

    expect(screen.queryAllByText("0")).not.toHaveLength(0);
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});
