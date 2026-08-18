/**
 * ISS-5534 — the desktop reader's PACK (plugin) identity helpers.
 *
 * Extracted out of the grandfathered `shared-agent-components-api.ts` rather
 * than added to it (AGENTS.md "File Size and Organization"): the functions below
 * are one cohesive concern — which packs a plugin identity rolls its child usage
 * up over, the usage total summed across them, and how that same identity
 * reaches the wire — and they are the desktop mirror of
 * `apps/api/app/agent-components/plugin-child-usage.ts`, so keeping them in one
 * small module makes the cross-surface parity reviewable in one place. Moving
 * `resolvePluginUsage` here alongside them also brings its host file down rather
 * than growing an already-grandfathered file.
 */

import { maxIso } from "../database/db-helpers.js";

/**
 * A component's rolled-up usage totals, as the desktop reader projects them.
 * Structurally identical to `shared-agent-components-api.ts`'s own
 * `UsageTotals`; declared here so this module owns the plugin lookup without a
 * circular import back into the file it was extracted from.
 */
export type PackUsageTotals = {
  invocations: number;
  sessions: number;
  lastInvokedAt: string | null;
};

/**
 * The set of pack ids a plugin identity rolls its child usage up over: every
 * pack id folded into the identity plus the plugin's own `component_key` (a
 * plugin's own pack_id equals its component_key). Usually a single id.
 */
export function pluginPackCandidates(merged: {
  packIds: Set<string>;
  representative: { component_key: string | null };
}): Set<string> {
  const candidates = new Set<string>(merged.packIds);
  const key = merged.representative.component_key;
  if (key) {
    candidates.add(key);
  }
  return candidates;
}

/**
 * The additive `packIds` half of one emitted list row — the parent-pack identity
 * a consumer needs to tell a plugin's rolled-up total apart from the specific
 * child rows it was rolled up FROM (wongk review on #4902).
 *
 * A plugin emits the SAME candidate set {@link pluginPackCandidates} gave
 * `resolvePluginUsage`, so the emitted identity and the emitted number can never
 * disagree about what the total covers; every other kind emits the packs the row
 * itself belongs to. Sorted for a stable wire shape, and OMITTED rather than
 * emitted as `[]`/`null` when there is nothing to say, per the repo's skew rule
 * for optional cross-boundary fields.
 *
 * See `AgentComponent.packIds` for how a reader must interpret absence: on a
 * plugin row it means the producer predates the field, on any other kind it
 * means the component belongs to no pack.
 */
export function emitPackIdentity(
  merged: {
    packIds: Set<string>;
    representative: { component_key: string | null };
  },
  isPlugin: boolean
): { packIds?: string[] } {
  const ids = isPlugin ? pluginPackCandidates(merged) : merged.packIds;
  const sorted = [...ids].sort();
  return sorted.length > 0 ? { packIds: sorted } : {};
}

/**
 * A plugin's usage totals: the child rollup summed over every candidate pack id.
 *
 * Returns `undefined` — not a zeroed total — when NO candidate pack matched, so
 * the caller can tell "this plugin has no child usage recorded" apart from "its
 * children ran zero times". Kept in the same module as {@link emitPackIdentity}
 * because the two must range over the identical candidate set: the emitted
 * `packIds` are the contract that says what this number covers.
 */
export function resolvePluginUsage(
  merged: {
    packIds: Set<string>;
    representative: { component_key: string | null };
  },
  pluginUsage: Map<string, PackUsageTotals>
): PackUsageTotals | undefined {
  let invocations = 0;
  let sessions = 0;
  let lastInvokedAt: string | null = null;
  let matched = false;
  for (const packId of pluginPackCandidates(merged)) {
    const usage = pluginUsage.get(packId);
    if (usage) {
      matched = true;
      invocations += usage.invocations;
      sessions += usage.sessions;
      lastInvokedAt = maxIso(lastInvokedAt, usage.lastInvokedAt);
    }
  }
  return matched ? { invocations, sessions, lastInvokedAt } : undefined;
}
