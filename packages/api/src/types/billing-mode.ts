/**
 * Shared billing-mode classification for session cost display.
 *
 * This is the cloud-side COPY of the mode sets, not their origin: the canonical
 * definitions are `SUBSCRIPTION_MODES` / `METERED_MODES` in
 * `apps/desktop/src/shared/billing-mode.ts` (the desktop producer stamps the
 * modes this file classifies), and `subscription-billing-mode-parity.test.ts`
 * binds the two so they cannot drift. A copy exists at all only because the
 * desktop module must never enter the cloud's runtime import graph.
 */

/**
 * ISS-5445: `opencode` is deliberately NOT in this set.
 *
 * OpenCode is bring-your-own-key, so the harness alone cannot tell you how a
 * session was paid for — it can run a free model or a fully-paid one. Operator
 * ruling (2026-08-07): "opencode doesn't guarantee a free model — the cost
 * should be associated with the model; not the harness." Classification
 * therefore happens at detection time from the session's MODEL
 * (`detectOpencodeBillingMode` in `apps/desktop/src/shared/billing-mode.ts`): a
 * priced model is stamped `api`, and anything without pricing evidence stays
 * `unknown`. The bare `opencode` value survives only on stored legacy rows,
 * where it honestly means "billing method never determined" ⇒ unknown ledger.
 *
 * Mirrors `SUBSCRIPTION_MODES` in `apps/desktop/src/shared/billing-mode.ts`,
 * which is the canonical set. Both halves must move together or the desktop and
 * cloud ledgers disagree about the same session;
 * `subscription-billing-mode-parity.test.ts` binds them.
 */
export const SUBSCRIPTION_BILLING_MODES: ReadonlySet<string> = new Set([
  "subscription_unknown",
  "pro",
  "max_5x",
  "max_20x",
  "codex_subscription",
  "cursor_pro",
  "copilot_seat",
]);

export function isSubscriptionBillingMode(value: unknown): boolean {
  return typeof value === "string" && SUBSCRIPTION_BILLING_MODES.has(value);
}

/**
 * ISS-4773 — the METERED half of the classification: modes that represent real,
 * per-token API spend the account was actually charged for.
 *
 * The cloud producer used to need only the subscription half, because everything
 * else was folded into one "not covered by a subscription" bucket. That bucket
 * is what made the Sessions Cost card misleading: it summed confirmed API spend
 * together with every session whose billing mode was never determined, then
 * rendered the total as definite cost. Splitting it needs BOTH halves pinned —
 * a mode is metered, subscription, or genuinely unknown, and only the first is
 * money the reader can be told they spent.
 *
 * Mirrors `METERED_MODES` in `apps/desktop/src/shared/billing-mode.ts`, which is
 * the canonical set; `subscription-billing-mode-parity.test.ts` binds the two.
 */
export const METERED_BILLING_MODES: ReadonlySet<string> = new Set([
  "api",
  "cursor_api",
]);

/**
 * True when the value is a mode representing confirmed per-token API spend.
 *
 * Deliberately NOT the negation of {@link isSubscriptionBillingMode}: a legacy
 * null, the literal `"unknown"`, or any unrecognized future value is neither
 * subscription-covered NOR confirmed spend, and must be reported as unclassified
 * rather than assumed to be either one.
 */
export function isMeteredBillingMode(value: unknown): boolean {
  return typeof value === "string" && METERED_BILLING_MODES.has(value);
}
