import { Harness } from "@repo/api/src/types/agent-component";

/**
 * Harness attribution for the component rollup (FEA-3758).
 *
 * A component's harness must reflect the harness of the SESSION(s) it actually
 * ran in — never a value hardcoded/defaulted on the inventory row. The desktop
 * mints an event-driven inventory row for a used-only component
 * (`upsertEventDrivenComponents`) with NO harness column set, so
 * `AgentComponent.harness` is frequently NULL for exactly the subagent/skill
 * identities this rollup surfaces; trusting it and defaulting to `"claude"` is
 * what made `subagent::explorer` (used only in Codex sessions) show `claude`.
 *
 * Each `AgentComponentSessionUsage` row DOES carry the session's harness
 * (`COALESCE(NULLIF(s.harness,''),'claude')` at write time), so we fold the
 * distinct harnesses observed across a component's usage rows:
 *   - exactly one distinct harness  → that harness
 *   - more than one                 → `both` (used across harnesses)
 *   - none recorded on usage        → fall back to the inventory harness, then
 *                                     `claude` as a last resort
 *
 * This is per-session sourcing, so a component used only in Codex sessions
 * attributes `codex`, and one used in both attributes `both`.
 */

/**
 * Accumulates the distinct, non-empty harness values observed across a
 * component's usage rows. Mutable so callers can fold rows in as they iterate
 * the various usage lanes (FK-linked, orphan, per-branch) without materializing
 * an intermediate array.
 */
export type HarnessAccumulator = Set<string>;

/** A fresh, empty harness accumulator. */
export function createHarnessAccumulator(): HarnessAccumulator {
  return new Set<string>();
}

/**
 * Fold one usage row's `harness` into the accumulator. Null/blank harness
 * values (older desktop builds that left the column unset) are ignored so they
 * never dilute the derived value or spuriously trip the `both` case.
 */
export function foldUsageHarness(
  acc: HarnessAccumulator,
  harness: string | null | undefined
): void {
  const value = harness?.trim();
  if (value) {
    acc.add(value);
  }
}

/**
 * Resolve the component's harness from the folded usage harnesses.
 *
 * `usageHarnesses` is authoritative: one distinct value wins, more than one
 * collapses to `both`. Only when usage recorded no harness at all do we fall
 * back to `inventoryHarness` (the installed-component row), and finally to
 * `claude` when even that is unset — matching the pre-fix default so a
 * genuinely harness-less component is unchanged.
 */
export function resolveComponentHarness(
  usageHarnesses: HarnessAccumulator,
  inventoryHarness: string | null | undefined
): Harness {
  if (usageHarnesses.size > 1) {
    return Harness.Both;
  }
  for (const only of usageHarnesses) {
    // Exactly one entry (size === 1); the loop body runs once.
    return normalizeHarness(only);
  }
  const fallback = inventoryHarness?.trim();
  return fallback ? normalizeHarness(fallback) : Harness.Claude;
}

/**
 * Coerce an arbitrary stored harness string to the `Harness` union. Unknown
 * values (should not occur — the desktop only writes `claude`/`codex`) pass
 * through as-is so we never silently misreport; the type is widened at the call
 * site exactly as the pre-fix `as` casts did.
 */
function normalizeHarness(value: string): Harness {
  return value as Harness;
}
