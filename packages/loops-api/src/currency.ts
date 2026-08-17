/**
 * @file currency.ts
 * @description Canonical, cross-runtime USD currency formatter shared by the
 * Agent Sessions surfaces (FEA-3441). This is the SINGLE source of the
 * `value > 0 ? Intl.NumberFormat(USD).format(value) : null` display formatter,
 * previously copy-pasted in:
 *   • `apps/api` — `agent-sessions/service/coercion.ts` (cloud projections).
 *   • `apps/desktop` — `main/session/shared-agent-sessions-api.ts` (local).
 * Both packages already depend on `@closedloop-ai/loops-api`, so hosting the formatter
 * here keeps ONE definition instead of a per-surface mirror kept in sync by
 * hand. Desktop main cannot runtime-import `@repo/api` (pglite boot path,
 * #1618/#1620), which is why the shared home is this runtime-neutral package.
 */

/**
 * Format a non-negative USD amount for display, returning `null` for
 * zero/negative values so callers render "no cost" rather than "$0.00".
 */
export function formatCurrency(value: number): string | null {
  return value > 0
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value)
    : null;
}
