/**
 * @file golden-layer2-agent-ids.ts
 * @description Re-derives the `agents` row ids a dossier should produce, from
 * the DOSSIER rather than from the store, for the layer-2 fidelity check.
 *
 * Extracted from `golden-layer2.ts` (ISS-4592), which is on the `biome.jsonc`
 * shrink-only grandfather list.
 *
 * The rule this encodes: one real delegation yields ONE row. A delegation the
 * parser lane already represents (the subagent record carries
 * `metadata.spawnedByToolUseId`) must NOT also get a `-sub-<toolUseId>` row.
 * Deriving it here independently of the store is what makes the check a rule
 * rather than a snapshot — it still fails if write-core stops honoring the
 * correlation.
 */
import type {
  NormalizedSession,
  NormalizedToolUse,
} from "../../src/main/collectors/types.js";
import { delegationClaimKey } from "../../src/main/database/subagent-dedup.js";

/** The delegation tool names, oldest harnesses first. */
const DELEGATION_TOOL_NAMES = new Set(["Agent", "Task"]);

const UNSAFE_ID_SEGMENT = /[^A-Za-z0-9_.:-]/g;

/**
 * Mirrors write-core's `sanitizeSubagentIdSegment` rather than importing it, on
 * purpose: this file re-derives what the store SHOULD contain, so it must not
 * inherit the rule from the code under test. If the production rule changes,
 * the agents fidelity fact fails and flags it.
 */
export function sanitizeSubagentIdSegment(id: string): string {
  return id.replace(UNSAFE_ID_SEGMENT, "_").slice(0, 160);
}

/**
 * The sorted, de-duplicated set of subagent `agents.id` values the dossier
 * implies: one `-parser-sub-*` row per named subagent, plus a
 * `-sub-<toolUseId>` row for every delegation the parser lane did NOT claim.
 */
export function expectedSubagentRowIds(
  input: NormalizedSession,
  sessionId: string
): string[] {
  const namedSubagents = (input.subagents ?? []).filter(
    (sub) => sanitizeSubagentIdSegment(sub.id).length > 0
  );
  const parserSubIds = namedSubagents.map(
    (sub) => `${sessionId}-parser-sub-${sanitizeSubagentIdSegment(sub.id)}`
  );
  const foldedIds = new Set(namedSubagents.map((sub) => sub.id));
  // A claim only retires the twin when EXACTLY ONE subagent makes it.
  // `spawnedByToolUseId` crosses a trust boundary (a sidecar `.meta.json`, a
  // tool_result payload), so two children can name the same delegation. The
  // write lane treats that as UNRESOLVED and keeps the `-sub-<toolUseId>`
  // fallback row; counting claims here rather than collecting them into a Set
  // is what re-derives that rule instead of under-expecting the row.
  //
  // The RULE stays re-derived — this module states what the store SHOULD hold,
  // so inheriting the twin-retirement decision from `buildSubagentDedupIndex`
  // would make the fidelity fact unable to fail. What is NOT re-derived is what
  // counts as ONE delegation: `delegationClaimKey` is imported (ISS-5105
  // review) because a claim stored as the transcript `id` and a claim stored as
  // the `providerToolUseId` name the SAME tool use, and tallying the raw
  // strings scores two mixed-alias claimants as two unique keys — under-
  // expecting the fallback row production keeps. Identity is a fact about the
  // data, not a rule about the store, so there is nothing to re-derive.
  const delegationByAnyId = indexDelegationsByAnyId([
    input.toolUses,
    ...namedSubagents.map((sub) => sub.toolUses),
  ]);
  const claimCounts = new Map<string, number>();
  for (const sub of namedSubagents) {
    const claim = sub.metadata?.spawnedByToolUseId;
    if (typeof claim === "string" && claim.length > 0) {
      const key = canonicalClaimKey(claim, delegationByAnyId);
      claimCounts.set(key, (claimCounts.get(key) ?? 0) + 1);
    }
  }
  const spawnClaimedToolUseIds = new Set(
    [...claimCounts].filter(([, n]) => n === 1).map(([id]) => id)
  );
  const claimed = (tu: NormalizedSession["toolUses"][number]): boolean => {
    const key = delegationClaimKey(tu);
    return (
      (tu.subagentId != null && foldedIds.has(tu.subagentId)) ||
      (key != null && spawnClaimedToolUseIds.has(key))
    );
  };
  const toolSubIds = (input.toolUses ?? [])
    .map((tu, idx) => ({ tu, idx }))
    .filter(({ tu }) => !claimed(tu) && DELEGATION_TOOL_NAMES.has(tu.name))
    .map(({ tu, idx }) => `${sessionId}-sub-${tu.id ?? idx}`);
  return [...new Set([...parserSubIds, ...toolSubIds])].sort();
}

/**
 * Every delegation reachable from the session, registered under BOTH id forms.
 *
 * Sidecar tool uses are included because a NESTED delegation lives in its
 * parent subagent's transcript and never lands on `session.toolUses` — a claim
 * against one would otherwise be unresolvable and keep its raw spelling.
 */
function indexDelegationsByAnyId(
  toolUseGroups: readonly (readonly NormalizedToolUse[] | undefined)[]
): ReadonlyMap<string, NormalizedToolUse> {
  const byId = new Map<string, NormalizedToolUse>();
  for (const group of toolUseGroups) {
    for (const tu of group ?? []) {
      if (!DELEGATION_TOOL_NAMES.has(tu.name)) {
        continue;
      }
      if (tu.id) {
        byId.set(tu.id, tu);
      }
      if (tu.providerToolUseId) {
        byId.set(tu.providerToolUseId, tu);
      }
    }
  }
  return byId;
}

/**
 * Collapse a stored claim onto the canonical key of the tool use it names, so
 * the two id forms of ONE delegation tally as one claim. An unresolvable claim
 * (version-skewed or cross-session) keeps its raw spelling — it names no tool
 * use here, so it can only ever collide with an identical raw claim.
 */
function canonicalClaimKey(
  rawClaim: string,
  delegationByAnyId: ReadonlyMap<string, NormalizedToolUse>
): string {
  const toolUse = delegationByAnyId.get(rawClaim);
  return toolUse ? (delegationClaimKey(toolUse) ?? rawClaim) : rawClaim;
}
