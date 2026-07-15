/**
 * @file subscription-billing-mode-parity.test.ts
 * @description FEA-3104 cross-surface parity guard.
 *
 * `apps/api/app/agent-sessions/service/synced-payload.ts` hard-codes
 * SUBSCRIPTION_BILLING_MODES,
 * a copy of the desktop's canonical SUBSCRIPTION_MODES
 * (`apps/desktop/src/shared/billing-mode.ts`). The API uses it to attribute
 * DESKTOP_SYNC session cost to the subscription (hypothetical) ledger rather than
 * the metered/API (real-spend) ledger. The two sets must stay byte-identical:
 * if a future desktop subscription tier is added to SUBSCRIPTION_MODES but not to
 * this copy, that tier's cost is silently misreported into the metered/API bucket
 * for DESKTOP_SYNC sessions — a cost-misreporting parity bug.
 *
 * This test mirrors the existing BILLING_MODES parity assertion in
 * `apps/desktop/test/billing-mode.test.ts` (the sibling BILLING_MODES ↔ ledger
 * pair): it imports BOTH sets and asserts they are exactly equal (as sorted
 * arrays), binding the copy to the canonical source so any divergence fails CI.
 *
 * Boot-path safety (FEA-3104 caveat, #1618/#1620): the desktop billing-mode
 * module is a pure leaf (its only import is `node:path`), and the import here
 * lives in a TEST — it never enters the desktop-main runtime graph, so it cannot
 * regress the pglite boot path. Nothing in this change makes desktop-main import
 * a runtime value from `@repo/api`.
 */
import { SUBSCRIPTION_MODES } from "../../../desktop/src/shared/billing-mode";
import { SUBSCRIPTION_BILLING_MODES } from "./service/synced-payload";

function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

describe("SUBSCRIPTION_BILLING_MODES ↔ desktop SUBSCRIPTION_MODES parity (FEA-3104)", () => {
  it("the API copy is exactly equal to the desktop canonical set", () => {
    expect(sorted(SUBSCRIPTION_BILLING_MODES)).toEqual(
      sorted(SUBSCRIPTION_MODES)
    );
  });

  it("both sets pin the same 7 subscription-covered modes", () => {
    // Pins the reviewed membership so a change on EITHER side is caught even if
    // both diverge in the same direction. Kept sorted to match the desktop
    // billing-mode.test.ts convention.
    const expected = [
      "codex_subscription",
      "copilot_seat",
      "cursor_pro",
      "max_20x",
      "max_5x",
      "pro",
      "subscription_unknown",
    ];
    expect(sorted(SUBSCRIPTION_BILLING_MODES)).toEqual(expected);
    expect(sorted(SUBSCRIPTION_MODES)).toEqual(expected);
  });
});
