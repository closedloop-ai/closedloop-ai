/**
 * @file subagent-dedup.ts
 * @description Correlating the two write lanes that each persist a row for one
 * real Claude delegation (ISS-4592).
 *
 * Historically both lanes wrote a row — a `-parser-sub-*` row from
 * `session.subagents` and a `-sub-<toolUseId>` fallback row from the delegating
 * tool use — and only the missing `subagent_type`/`task` on the parser row kept
 * them from being indistinguishable duplicates. Once the kickoff join populates
 * those fields the fallback row is a byte-identical twin, so the write path
 * retires it using the exact-spawn correlation built here.
 *
 * Extracted from `write-core.ts`, which is on the `biome.jsonc` shrink-only
 * grandfather list.
 */
import type {
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "../collectors/types.js";
import { strOf } from "./db-helpers.js";

/** The delegation tool names, oldest harnesses first. */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
]);

/**
 * The canonical claim key of a delegating tool use — the id a subagent's
 * `spawnedByToolUseId` is matched against, and the id the emitted invocation
 * row records as `provider_tool_use_id`. ONE derivation, shared by the tier-0
 * exact check (`matchSpawnedSubagent`), the whole-session pre-pass
 * (`pairDelegationsWithSubagents`), and write-core's twin retirement — so the
 * three cannot disagree if a parser starts populating `providerToolUseId`
 * distinct from the transcript `id` (no parser does today; the agreement held
 * only by that accident before this helper).
 */
export function delegationClaimKey(toolUse: NormalizedToolUse): string | null {
  return toolUse.providerToolUseId ?? toolUse.id ?? null;
}

export type SubagentDedupIndex = {
  /**
   * Delegation CLAIM KEY → the parser-lane row that delegation spawned.
   *
   * The key is `delegationClaimKey` of the claimed tool use whenever that tool
   * use is reachable, NOT the raw `spawnedByToolUseId` the subagent recorded —
   * so a claim stored as the transcript id and a claim stored as the provider
   * id land on ONE key. Consumers therefore look up with `delegationClaimKey`
   * of the tool use in hand and cannot miss on id form (ISS-5099 review). Only
   * an unresolvable claim (version-skewed, cross-session, or naming a
   * collided alias) keeps its raw id.
   */
  parserAgentIdBySpawnToolUseId: ReadonlyMap<string, string>;
  /**
   * Delegation claim key (as above) → the RAW parser subagent id that claims it.
   * The minted agent id above round-trips through `sanitizeSubagentIdSegment`,
   * which can collapse two distinct raw ids to one segment — so a consumer
   * that needs the subagent RECORD back must key by the raw id, never invert
   * the minted one (see `pairDelegationsWithSubagents`).
   */
  parserSubagentIdBySpawnToolUseId: ReadonlyMap<string, string>;
  /** Subagent id → the tool use that spawned it, when it is reachable. */
  spawnToolUseBySubagentId: ReadonlyMap<string, NormalizedToolUse>;
  /**
   * Every subagent whose (canonicalized) claim is shared with another subagent.
   *
   * These children are UNRESOLVED, not merely un-retired: the evidence names a
   * delegation but cannot say which child ran it. Consumers that fall back to
   * fuzzy matching must exclude them, or a same-type guess re-creates the exact
   * ambiguity this index rejects — and resolves it by candidate array order,
   * i.e. sidecar load order (ISS-5105 review).
   */
  ambiguousClaimSubagentIds: ReadonlySet<string>;
};

/**
 * Index every delegating tool use in the session, main transcript AND sidecars.
 *
 * A NESTED delegation — one subagent spawning another — lives in its parent
 * subagent's transcript, so its tool use lands on `subagent.toolUses` and never
 * on `session.toolUses`. The parser's own `buildDelegationToolUseIndex` walks
 * both for that reason; walking only the session's would leave those spawn tool
 * uses unreachable, which in turn leaves `subagentRowSpan` unable to repair the
 * child's degenerate span and persists it as a 0-second delegation. In the
 * golden corpus that is 16 of 68 subagents, all in dossier f216298d.
 *
 * The two-key registration is COLLISION-AWARE (ISS-5105 review). One id can be
 * tool A's `providerToolUseId` and tool B's transcript `id` — corrupt input, but
 * reachable, since both fields cross the same parser/sidecar trust boundary.
 * Last-write-wins resolved a claim on that id to whichever tool was indexed
 * last, so re-reading the same evidence in a different order moved the
 * attribution. A key claimed by two DIFFERENT tool uses is dropped and stays
 * dropped, leaving the claim unresolvable — the same refuse-to-guess outcome a
 * version-skewed or cross-session claim already gets, and the one
 * `tallySpawnClaims` gives a non-unique claim.
 */
function indexDelegationToolUses(
  session: NormalizedSession,
  parserSubagents: readonly NormalizedSubagent[]
): Map<string, NormalizedToolUse> {
  const byId = new Map<string, NormalizedToolUse>();
  const collided = new Set<string>();
  const register = (key: string, toolUse: NormalizedToolUse): void => {
    if (collided.has(key)) {
      return;
    }
    const existing = byId.get(key);
    if (existing && !isSameDelegation(existing, toolUse)) {
      byId.delete(key);
      collided.add(key);
      return;
    }
    byId.set(key, toolUse);
  };
  const addAll = (toolUses: readonly NormalizedToolUse[] | undefined): void => {
    for (const tu of toolUses ?? []) {
      if (!DELEGATION_TOOL_NAMES.has(tu.name)) {
        continue;
      }
      // Register under BOTH the transcript id and the provider id so a claim
      // recorded against either resolves — the canonical claim key is
      // `delegationClaimKey` (provider-first), but stored claims may carry the
      // transcript id.
      if (tu.id) {
        register(tu.id, tu);
      }
      if (tu.providerToolUseId) {
        register(tu.providerToolUseId, tu);
      }
    }
  };
  addAll(session.toolUses);
  for (const subagent of parserSubagents) {
    addAll(subagent.toolUses);
  }
  return byId;
}

/**
 * Build the correlation the write path uses to retire the duplicate
 * `-sub-<toolUseId>` row and to recover the delegation's real wall clock.
 */
export function buildSubagentDedupIndex(
  session: NormalizedSession,
  parserSubagents: readonly NormalizedSubagent[],
  subagentIdByNormalizedId: ReadonlyMap<string, string>
): SubagentDedupIndex {
  const delegationToolUseById = indexDelegationToolUses(
    session,
    parserSubagents
  );
  // `spawnedByToolUseId` crosses a trust boundary (a sidecar `.meta.json`, a
  // tool_result payload), so two children CAN claim the same delegation. That
  // is corrupt input, and last-write-wins would resolve it differently here
  // than `matchSpawnedSubagent`'s first-match `find` — assigning the spawn
  // event to one child and the invocation to another while still suppressing
  // the fallback row. A non-unique claim is therefore treated as UNRESOLVED:
  // neither child retires the twin, and both fall back to the pre-ISS-4592
  // behavior, which is the safe direction for data we cannot trust.
  //
  // The claim is CANONICALIZED to `delegationClaimKey` before any of that is
  // decided. `spawnedByToolUseId` may hold either id form, so keying the guard
  // by the raw value would let two children claiming ONE tool use through
  // different id forms register as two distinct single-claimant keys — the
  // exact ambiguity this guard exists to reject (ISS-5099 review).
  const { claimKeyBySubagentId, claimantsByClaimKey } = tallySpawnClaims(
    parserSubagents,
    delegationToolUseById
  );
  const ambiguousClaimSubagentIds =
    collectAmbiguousClaimants(claimantsByClaimKey);
  const parserAgentIdBySpawnToolUseId = new Map<string, string>();
  const parserSubagentIdBySpawnToolUseId = new Map<string, string>();
  const spawnToolUseBySubagentId = new Map<string, NormalizedToolUse>();
  for (const subagent of parserSubagents) {
    const agentId = subagentIdByNormalizedId.get(subagent.id);
    const claimKey = claimKeyBySubagentId.get(subagent.id);
    if (!(agentId && claimKey)) {
      continue;
    }
    if (claimantsByClaimKey.get(claimKey)?.length !== 1) {
      continue;
    }
    parserAgentIdBySpawnToolUseId.set(claimKey, agentId);
    parserSubagentIdBySpawnToolUseId.set(claimKey, subagent.id);
    const spawnToolUse = delegationToolUseById.get(claimKey);
    if (spawnToolUse) {
      spawnToolUseBySubagentId.set(subagent.id, spawnToolUse);
    }
  }
  return {
    parserAgentIdBySpawnToolUseId,
    parserSubagentIdBySpawnToolUseId,
    spawnToolUseBySubagentId,
    ambiguousClaimSubagentIds,
  };
}

/**
 * Read each subagent's stored spawn claim and tally the claimants per
 * delegation, keyed by `delegationClaimKey` of the tool use the claim resolves
 * to. Only an unresolvable claim (version-skewed, cross-session, or naming a
 * collided alias) keeps its raw spelling.
 */
function tallySpawnClaims(
  parserSubagents: readonly NormalizedSubagent[],
  delegationToolUseById: ReadonlyMap<string, NormalizedToolUse>
): {
  claimKeyBySubagentId: ReadonlyMap<string, string>;
  claimantsByClaimKey: ReadonlyMap<string, string[]>;
} {
  const claimKeyBySubagentId = new Map<string, string>();
  const claimantsByClaimKey = new Map<string, string[]>();
  for (const subagent of parserSubagents) {
    const spawnedByToolUseId = strOf(subagent.metadata?.spawnedByToolUseId);
    if (!spawnedByToolUseId) {
      continue;
    }
    const spawnToolUse = delegationToolUseById.get(spawnedByToolUseId);
    const claimKey = spawnToolUse
      ? (delegationClaimKey(spawnToolUse) ?? spawnedByToolUseId)
      : spawnedByToolUseId;
    claimKeyBySubagentId.set(subagent.id, claimKey);
    const claimants = claimantsByClaimKey.get(claimKey);
    if (claimants) {
      claimants.push(subagent.id);
    } else {
      claimantsByClaimKey.set(claimKey, [subagent.id]);
    }
  }
  return { claimKeyBySubagentId, claimantsByClaimKey };
}

/**
 * Do two index registrations describe ONE delegation?
 *
 * Identity is not enough: a nested delegation's tool use can reach the index
 * from `session.toolUses` AND from the parent subagent's `toolUses` as separate
 * objects, and that duplicate is the same delegation, not a collision. Both id
 * fields must agree — matching on `id` alone would fold a genuinely different
 * tool use that merely shares an alias.
 */
function isSameDelegation(a: NormalizedToolUse, b: NormalizedToolUse): boolean {
  return (
    a === b || (a.id === b.id && a.providerToolUseId === b.providerToolUseId)
  );
}

/** Every subagent that shares its delegation claim with a sibling. */
function collectAmbiguousClaimants(
  claimantsByClaimKey: ReadonlyMap<string, string[]>
): ReadonlySet<string> {
  const ambiguous = new Set<string>();
  for (const claimants of claimantsByClaimKey.values()) {
    if (claimants.length > 1) {
      for (const subagentId of claimants) {
        ambiguous.add(subagentId);
      }
    }
  }
  return ambiguous;
}
