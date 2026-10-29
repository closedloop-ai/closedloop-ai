/**
 * @file sync-source-session-patches.ts
 * @description The "emit only when meaningful" field patches the synced-session
 * payload spreads into each session object.
 *
 * Each one answers the same question — should this key be on the wire at all? —
 * and each answers it for a different reason. Collected here rather than inline
 * because `sync-source.ts` is shrink-only grandfathered (`biome.jsonc`), and
 * because the reason a key is OMITTED is the interesting part of each: written
 * inline, that reasoning is four lines of comment wrapped around one ternary,
 * repeated per field.
 */
import type { SqliteSessionRow } from "./db-row-types.js";
import { publishableStoredCostUsd } from "./stored-cost-usd.js";

/**
 * ISS-5801: the substantive-work signal for invocation-only sessions.
 *
 * Emitted only when positive (the additive-section pattern), so a session with
 * no invocations serializes byte-identically to before.
 */
export function componentInvocationCountPatch(
  invocationCount: number
): { componentInvocationCount: number } | Record<string, never> {
  return invocationCount > 0
    ? { componentInvocationCount: invocationCount }
    : {};
}

/**
 * ISS-7229: Claude's OWN reported cost for the session, rolled up from the OTel
 * `claude_code_cost_event` rows onto `sessions.authoritative_cost_usd`.
 *
 * OMITTED, NEVER SENT AS NULL, when this install captured nothing — and that is
 * a correctness requirement rather than the general cross-repo style rule. The
 * cloud column holds figures this payload did not write: the ISS-12435 backfill
 * of the retired loop-event figures. OTel capture is gated on the
 * `claudeCodeOtelCapture` Labs setting and reaches a minority of sessions, so a
 * session can already hold a real Claude-reported figure this desktop knows
 * nothing about. Sending `null` for "I captured nothing" would erase it.
 * Absence means "no opinion, keep what you have", and the wire schema refuses a
 * `null` outright so the mistake fails loudly rather than clearing a column.
 *
 * A reported `0` IS sent: Claude charging nothing is a measurement, and the
 * cloud stores it as one.
 *
 * A REFUSED figure is LOGGED, an absent one is not, and the split is the whole
 * point of taking a `log` handle here. An empty column is the ordinary case —
 * OTel capture reaches a minority of sessions — so logging that would drown the
 * signal in the majority. A column that holds SOMETHING this device will not
 * publish is different: the session is acked, the cursor advances and the outbox
 * clears, so the figure stays local permanently with nothing to say so. That is
 * the silent undercount AGENTS.md's "Handling Bad or Nonsensical Data" requires
 * be routed to the monitored path, and it is the same treatment the activity
 * tiling overflow beside this one gets in `sync-source.ts`.
 */
export function authoritativeCostPatch(
  row: Pick<SqliteSessionRow, "id" | "authoritative_cost_usd">,
  log?: (message: string) => void
): { authoritativeCostUsd: number } | Record<string, never> {
  // `publishableStoredCostUsd`, never a bare `Number(stored)` (marisolashgrove on
  // #6406). The column arrives from the raw path as a Prisma `Decimal`, and
  // `Number()` on an unexpected shape yields `NaN` — or, for a blank string, a
  // confident `0` that the cloud would store as a real measurement of "Claude
  // charged nothing". It also refuses a figure too wide for the cloud column,
  // which keeps an unpublishable cost out of the payload rather than leaving the
  // receiver to drop it.
  const stored = row.authoritative_cost_usd;
  const costUsd = publishableStoredCostUsd(stored);
  if (costUsd === null) {
    if (stored !== null && stored !== undefined) {
      log?.(
        `sync-source: session ${row.id} holds an authoritative cost this build will not publish (${String(stored)}); OMITTING the field from this payload — the session still syncs, but that figure stays local and no later sync re-offers it`
      );
    }
    return {};
  }
  return { authoritativeCostUsd: costUsd };
}
