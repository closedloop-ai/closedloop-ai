/**
 * ISS-10667 — the label sets are DERIVED from the canonical records.
 *
 * Ported from the withdrawn alias branch, which is the only place this
 * technique existed. An identity assertion cannot prove derivation: a module
 * that re-types `"Total tokens"` and one that imports it hold the same string,
 * so `toBe(TOTAL_TOKENS_LABEL)` passes either way. Here each copy module is
 * replaced with a sentinel phrase no surface could have hardcoded, and the
 * derived sets are then asked what they contain.
 *
 * Scoped to the data layer because that is where this change put the swap — the
 * components read whole maps through hooks and never hold a phrase themselves.
 */
import { describe, expect, it, vi } from "vitest";

const COST_SENTINEL = "iss10667-cost-canonical";
const COST_ALIAS_SENTINEL = "iss10667-cost-alias";
const TOKENS_SENTINEL = "iss10667-tokens-canonical";
const MERGED_SENTINEL = "iss10667-merged-ratio";

vi.mock("@repo/api/src/types/total-estimated-cost-copy", () => ({
  TOTAL_ESTIMATED_COST_COPY: {
    label: COST_SENTINEL,
    shortLabel: COST_ALIAS_SENTINEL,
    info: { what: "", how: "" },
  },
  TOTAL_ESTIMATED_COST_LABEL: COST_SENTINEL,
  TOTAL_ESTIMATED_COST_ALIAS_LABEL: COST_ALIAS_SENTINEL,
}));

vi.mock("@repo/api/src/types/total-tokens-copy", () => ({
  TOTAL_TOKENS_LABEL: TOKENS_SENTINEL,
  TOTAL_TOKENS_ALIAS_LABEL: "iss10667-tokens-alias",
}));

vi.mock("@repo/api/src/utils/loc-per-dollar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/api/src/utils/loc-per-dollar")>();
  return {
    ...actual,
    MERGED_LOC_PER_DOLLAR_LABEL: MERGED_SENTINEL,
  };
});

describe("ISS-10667 the gated label sets read the canonical records", () => {
  it("derives every Sessions card row from a record, not a literal", async () => {
    const visibility = await import(
      "../../../agents/components/sessions/sessions-summary-card-visibility"
    );
    const gated = visibility.ONE_LABEL_PER_METRIC_SESSIONS_SUMMARY_CARD_LABELS;
    expect(gated[visibility.SessionsSummaryCardId.Cost]).toBe(COST_SENTINEL);
    expect(gated[visibility.SessionsSummaryCardId.Tokens]).toBe(
      TOKENS_SENTINEL
    );
    expect(gated[visibility.SessionsSummaryCardId.LocPerDollar]).toBe(
      MERGED_SENTINEL
    );
  });

  it("derives the gated ratio fold's known arm from the record", async () => {
    const basis = await import(
      "@repo/api/src/types/merged-loc-per-dollar-basis"
    );
    expect(
      basis.resolveCanonicalMergedLocPerDollarLabel(
        basis.MergedLocPerDollarBasis.MergedLinesOverTotalCost
      )
    ).toBe(MERGED_SENTINEL);
  });

  it("derives the Sessions column header from the record", async () => {
    const columns = await import(
      "../../../agents/lib/sessions-total-estimated-cost-columns"
    );
    const { SESSIONS_COST_COLUMN_ID } = await import(
      "../../../agents/lib/sessions-table-columns"
    );
    expect(
      columns.TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_LABELS[
        SESSIONS_COST_COLUMN_ID
      ]
    ).toBe(COST_SENTINEL);
  });
});
