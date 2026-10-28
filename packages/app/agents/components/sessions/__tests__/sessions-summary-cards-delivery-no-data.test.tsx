/**
 * ISS-7845 — the Sessions strip renders ONE absent value one way, behind
 * `SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY` (default OFF).
 *
 * The defect these tests pin: `DeliveryMetricCard` handed `MetricCard` a literal
 * em dash as its VALUE, so the primitive's `noData` branch stayed false and the
 * dash painted in the normal value treatment — semibold, full foreground — while
 * the three cards beside it dashed through `noData` and painted muted at normal
 * weight. Two weights for one semantic state, inches apart in one row, reading
 * as a hierarchy signal that is not real.
 *
 * A sibling file rather than more cases inside `sessions-summary-cards.test.tsx`,
 * for the reason its honest-loading sibling gives: that suite is at the
 * 1,000-line ceiling and this is one self-contained concern.
 *
 * Asserted on the token classes the two treatments UNIQUELY emit, not on the
 * glyph — the glyph is identical under both flag states by construction, which
 * is the whole point, so a presence assertion could not tell them apart.
 *
 * TWO render states, not one. `DeliveryMetricCard` returns a dash from three
 * branches, and a case that only drove `isError` would stay green under a fix
 * applied to that branch alone. Covered here: the failed read (`muted`) and the
 * signed-in empty (NOT `muted`, so it is the branch where the emphasized dash
 * was most visible). The third — ISS-7705's `unavailableReason` — sits behind a
 * second flag and shares the `muted` shape of the failed read, so it is
 * deliberately not duplicated here.
 *
 * The signed-out gate was a third state here until ISS-7866, which took it off
 * this table rather than out of coverage: that branch no longer paints an
 * absent-value dash at all — it withdraws the value and carries the Connect
 * GitHub ask, pinned by `sessions-summary-cards-github-connect.test.tsx` — so
 * this file has no treatment left to measure there. The last case below pins
 * that absence, so a revert cannot quietly put an emphasized dash back.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/** The delivery pair — `PRs Shipped` and `LOC / $` — the two this ticket moves. */
const DELIVERY_CARD_COUNT = 2;

/**
 * A settled cloud read that carries the always-available numbers but NO delivery
 * metrics, which is the signed-in empty state (state 3): authenticated, the read
 * succeeded, and these two cloud-only figures are simply absent.
 */
function usageWithoutDeliveryMetrics(): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalSessions: 12,
      totalEstimatedCost: 42,
      apiEstimatedCost: 42,
      mergedPrCount: null,
      mergedLocPerDollar: null,
    }
  );
}

/**
 * Render the strip through the REAL `FeatureFlagAdapterProvider` seam both
 * shells use, not a stubbed boolean.
 */
function renderStrip(
  enabledFlags: string[],
  props: {
    usage?: AgentSessionUsageSummary;
    isError?: boolean;
    authenticated?: boolean;
  }
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <SessionsSummaryCards
        authenticated={props.authenticated ?? true}
        isError={props.isError ?? false}
        isLoading={false}
        usage={props.usage}
      />
    </FeatureFlagAdapterProvider>
  );
}

/** The value slots currently painting the honest-empty glyph. */
function dashedValueSlots(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="card-title"]')
  ).filter((slot) => slot.textContent?.trim() === KPI_NO_VALUE);
}

/** Slots painting the dash in the NORMAL value treatment — the defect's half. */
function emphasizedDashes(container: HTMLElement): HTMLElement[] {
  return dashedValueSlots(container).filter((slot) =>
    slot.className.includes("font-semibold")
  );
}

/** Slots painting the dash in the primitive's muted no-data treatment. */
function mutedDashes(container: HTMLElement): HTMLElement[] {
  return dashedValueSlots(container).filter(
    (slot) =>
      slot.className.includes("font-normal") &&
      slot.className.includes("text-muted-foreground")
  );
}

const RENDER_STATES = [
  // A terminal error: all five cards dash, so the two treatments sit side by
  // side. This is the `muted` delivery branch.
  { name: "a failed read", props: { isError: true, usage: undefined } },
  // Authenticated, the read succeeded, the delivery figures are simply absent.
  // Also NOT `muted`.
  {
    name: "a signed-in empty",
    props: { usage: usageWithoutDeliveryMetrics() },
  },
] as const;

describe("ISS-7845 uniform empty-value dash", () => {
  for (const state of RENDER_STATES) {
    it(`paints the delivery pair muted in ${state.name} (flag ON)`, () => {
      const { container } = renderStrip(
        [SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY],
        state.props
      );

      // Every dash on screen now goes through one treatment.
      expect(emphasizedDashes(container)).toHaveLength(0);
      // Positive sibling: the pair really is on screen dashing, so the zero
      // above is a treatment result and not an empty row matching nothing.
      expect(mutedDashes(container).length).toBeGreaterThanOrEqual(
        DELIVERY_CARD_COUNT
      );
    });

    it(`leaves the delivery pair emphasized in ${state.name} (flag off, closed by default)`, () => {
      // The shipped render, and the counterfactual anchor: this is what the ON
      // case must differ from. Without the gate the two would agree and neither
      // would be measuring the flag.
      const { container } = renderStrip([], state.props);

      expect(emphasizedDashes(container)).toHaveLength(DELIVERY_CARD_COUNT);
    });
  }

  it("does not change how many dashes the strip paints", () => {
    // The glyph count is UNCHANGED by this fix — five before, five after. If
    // this diverges, the change has altered WHICH cards dash rather than how
    // they are styled, which is a different and larger change than this ticket
    // describes (and is what the honest-loading suite's `toHaveLength(5)`
    // assertions would catch from the other direction).
    const off = renderStrip([], { isError: true, usage: undefined });
    const on = renderStrip([SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY], {
      isError: true,
      usage: undefined,
    });

    expect(dashedValueSlots(on.container)).toHaveLength(
      dashedValueSlots(off.container).length
    );
  });

  it("leaves the delivery pair out of the dash entirely in the signed-out gate", () => {
    // ISS-7866 removed that state from the table above, and this is the
    // assertion that keeps the removal honest rather than silent: signed out,
    // the pair paints no absent-value dash for either treatment to act on — it
    // withdraws the value and carries the Connect GitHub ask instead. Driven
    // under BOTH flag states because the gate outranks the flag: a revert that
    // put an emphasized dash back here would redden this whichever way the flag
    // is set.
    for (const flags of [
      [],
      [SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY],
    ]) {
      const { container } = renderStrip(flags, {
        authenticated: false,
        usage: undefined,
      });

      expect(withdrawnValueSlots(container)).toHaveLength(DELIVERY_CARD_COUNT);
      expect(emphasizedDashes(container)).toHaveLength(0);
    }
  });
});

/**
 * The value slots the ISS-7866 gate WITHDREW rather than dashed — the
 * primitive's own no-data label, which is what `value={null}` with no override
 * renders. Deliberately not `dashedValueSlots`: the point of the case above is
 * that these two slots hold no dash at all.
 */
function withdrawnValueSlots(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="card-title"]')
  ).filter((slot) => slot.textContent?.trim() === WITHDRAWN_VALUE_LABEL);
}

/** `MetricCard`'s default `valueUnavailableLabel`, which the gated card takes. */
const WITHDRAWN_VALUE_LABEL = "No data";
