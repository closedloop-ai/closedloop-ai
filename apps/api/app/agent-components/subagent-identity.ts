/**
 * Subagent identity rollup — single source of truth (FEA-2923, FEA-3052).
 *
 * The Claude parser names every typeless subagent spawn with an instance-unique
 * label ("Claude subagent <hex>"), so pre-rollup installs synced one inventory
 * (and one usage) row per spawn. Every read surface collapses those instance
 * rows to a single `general-purpose` identity at read time — the Agents listing
 * (`service.ts`) and the token-trend drill-down (`analytics-service.ts`) — so
 * the rollup needs no desktop re-sync/migration. Keeping the rule here means the
 * listing and the drill-down derive it from the identical source and can never
 * drift apart (the drift they had was FEA-3052).
 *
 * Genuinely-typed subagents (`subagent_type` set) never match and are untouched.
 */

/** Instance-unique subagent label the Claude parser emits per typeless spawn. */
export const CLAUDE_SUBAGENT_INSTANCE_RE = /^claude subagent [0-9a-f]{4,}$/i;

/** The single identity every instance-unique subagent row rolls up into. */
export const ROLLED_UP_SUBAGENT_KEY = "general-purpose";

/**
 * Collapse an instance-unique subagent identity to the single `general-purpose`
 * identity. Non-subagent kinds and already-typed subagents pass through
 * unchanged.
 */
export function normalizeSubagentIdentity(
  kind: string,
  key: string | null,
  name: string | null
): { key: string | null; name: string | null } {
  if (kind !== "subagent") {
    return { key, name };
  }
  const probe = (key ?? name ?? "").trim();
  if (CLAUDE_SUBAGENT_INSTANCE_RE.test(probe)) {
    return { key: ROLLED_UP_SUBAGENT_KEY, name: ROLLED_UP_SUBAGENT_KEY };
  }
  return { key, name };
}

/**
 * True for the rolled-up general-purpose subagent identity — the only identity
 * for which instance-unique usage rows must be matched at read time. Any other
 * (kind, key) matches its own `componentKey` verbatim.
 */
export function isRolledUpSubagentIdentity(kind: string, key: string): boolean {
  return kind === "subagent" && key === ROLLED_UP_SUBAGENT_KEY;
}

/**
 * True when a usage row's `componentKey` belongs to the rolled-up
 * general-purpose subagent identity: either the literal `general-purpose` key or
 * an instance-unique `Claude subagent <hex>` label. Mirrors
 * {@link normalizeSubagentIdentity} exactly so a read surface that broadens its
 * DB query for this identity can filter the fetched rows down to the identical
 * set the listing rolls up (no over- or under-count).
 */
export function componentKeyRollsUpToGeneralPurpose(
  componentKey: string | null
): boolean {
  const probe = (componentKey ?? "").trim();
  return (
    probe === ROLLED_UP_SUBAGENT_KEY || CLAUDE_SUBAGENT_INSTANCE_RE.test(probe)
  );
}

/**
 * True when a usage row's `componentKey` is the literal `general-purpose` key —
 * the authoritative rolled-up row a re-synced desktop emits — as opposed to a
 * pre-rollup instance-unique `Claude subagent <hex>` alias. A session that
 * carries this row supersedes any stale alias rows for the same session (see the
 * token-trend de-dupe: `persistSessionComponentUsage` only prunes branch buckets
 * within the exact `componentKey`, so old alias rows survive a re-sync).
 */
export function isRolledUpSubagentKey(componentKey: string | null): boolean {
  return (componentKey ?? "").trim() === ROLLED_UP_SUBAGENT_KEY;
}
