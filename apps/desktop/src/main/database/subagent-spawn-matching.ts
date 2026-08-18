/**
 * @file subagent-spawn-matching.ts
 * @description Pairing a delegating tool use with the subagent record it
 * spawned, for runtime-component invocation materialization (FEA-3294).
 *
 * Extracted from `component-invocations.ts` (ISS-4592) — that file is on the
 * `biome.jsonc` shrink-only grandfather list, so the tier-0 addition below had
 * to come with a matching reduction rather than pile onto it.
 *
 * The tiers are ordered strongest-evidence-first, and every tier skips
 * candidates already claimed by an earlier tool use (`represented`) so one
 * subagent can never back two invocations.
 */
import { UNATTRIBUTED_SUBAGENT_ID } from "@repo/lib/harness/claude/parse-claude-subagents";
import { asRecord, stringValue } from "@repo/lib/harness/parser-utils";
import type {
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import {
  buildSubagentDedupIndex,
  DELEGATION_TOOL_NAMES,
  delegationClaimKey,
} from "./subagent-dedup.js";

/**
 * Resolve the subagent a delegating tool use spawned, or null when no
 * candidate is credible. Tiers, in order:
 *
 * 0. **Exact spawn join** — the Claude parser records the delegating tool_use
 *    id on the subagent (`metadata.spawnedByToolUseId`, ISS-4592). Checked
 *    first so same-type sibling subagents can never mispair by order.
 * 1. **Exact identity** — the subagent's own id or native id IS the tool use id.
 * 2. **Timestamp + type** — spawned at the moment of the call.
 * 3. **Type alone** — last resort; ambiguous when a turn spawns several of one
 *    type, which is exactly what tier 0 exists to prevent.
 *
 * Candidates without the tier-0 key (other harnesses, parses predating
 * ISS-4592) fall through to the original tiers unchanged.
 *
 * Note that populating `type` (ISS-4592) makes parser-lane subagents eligible
 * for tiers 2 and 3 at all — before, their null type made them unselectable.
 * Excluding a candidate that declares a DIFFERENT spawn id from the fuzzy tiers
 * was considered and rejected: when that id is simply unresolvable here (a
 * version-skewed or cross-session reference) the exclusion yields NO pairing
 * rather than a same-type one, which is the worse failure. That behavior is
 * pinned by `component-invocations-spawn-join.test.ts`.
 *
 * `ambiguousClaimants` is the narrow exception to that rejection (ISS-5105
 * review): a candidate whose claim names a delegation NON-uniquely is not
 * merely unresolvable, it is contradicted by a sibling. Letting any tier pick one
 * by array order is a guess, and array order is sidecar load order, so
 * re-reading the same evidence in a different order moves the attribution. They
 * are barred from EVERY tier and from EVERY tool use, not just the one they
 * contest, because a same-type sibling delegation would otherwise inherit the
 * identical order-dependent choice.
 *
 * Tier 0 is inside that bar, not above it: its own claimant count is by RAW
 * provider id, so a mixed-alias contest — one child claiming a tool use's
 * transcript id, its rival that tool use's provider id — looked like a single
 * unopposed claimant there while `buildSubagentDedupIndex`, which canonicalizes
 * both through `delegationClaimKey`, had already declared the pair unresolved
 * and kept the fallback `agents` row. Tier 0 therefore counts over the same
 * filtered set the fuzzy tiers use.
 */
export function matchSpawnedSubagent(
  toolUse: NormalizedToolUse,
  subagents: readonly NormalizedSubagent[],
  represented: ReadonlySet<string>,
  ambiguousClaimants: ReadonlySet<string> = new Set<string>()
): NormalizedSubagent | null {
  const providerId = delegationClaimKey(toolUse);
  const input = asRecord(toolUse.input);
  const type =
    stringValue(input?.subagent_type) ?? stringValue(input?.agent_type);
  // A non-unique claim is corrupt input from a trust boundary. Taking the first
  // match would diverge from `buildSubagentDedupIndex`, which treats the same
  // ambiguity as unresolved — pairing the invocation to one child while the
  // spawn event went to another. Both paths fall through instead.
  // Barred from EVERY tier, tier 0 included. Tier 0 counts claimants by RAW
  // provider id while `ambiguousClaimants` is canonicalized through
  // `delegationClaimKey`, so a mixed-alias pair — one child claiming the
  // transcript id of a tool use, its rival claiming that same tool use's
  // provider id — reads as a single raw claimant here even though the dedup
  // index has already declared both unresolved and kept the fallback `agents`
  // row. Counting over `eligible` is what keeps the two lanes agreeing
  // (ISS-5105 review).
  const eligible =
    ambiguousClaimants.size === 0
      ? subagents
      : subagents.filter((candidate) => !ambiguousClaimants.has(candidate.id));
  const spawnClaimants =
    providerId == null
      ? []
      : eligible.filter(
          (candidate) =>
            asRecord(candidate.metadata)?.spawnedByToolUseId === providerId
        );
  if (spawnClaimants.length === 1 && !represented.has(spawnClaimants[0].id)) {
    return spawnClaimants[0];
  }
  const exact = eligible.find(
    (candidate) =>
      !represented.has(candidate.id) &&
      providerId != null &&
      (candidate.id === providerId || candidate.nativeSubagentId === providerId)
  );
  if (exact) {
    return exact;
  }
  return (
    eligible.find(
      (candidate) =>
        !represented.has(candidate.id) &&
        candidate.startedAt === toolUse.timestamp &&
        (type == null || candidate.type === type)
    ) ??
    eligible.find(
      (candidate) =>
        !represented.has(candidate.id) &&
        type != null &&
        candidate.type === type
    ) ??
    null
  );
}

/** One delegating tool use and the parser subagent it spawned, if any. */
export type PairedDelegation = {
  index: number;
  toolUse: NormalizedToolUse;
  parserSubagent: NormalizedSubagent | null;
};

/**
 * Pair every `Agent`/`Task` delegation in a session with the parser subagent it
 * spawned (ISS-5099).
 *
 * `matchSpawnedSubagent` above resolves ONE tool use at a time, so its tier-0
 * exact join only protects the tool use being resolved: walking delegations in
 * order, an earlier one still reaches tiers 2-3 and can claim a subagent that
 * exactly claims a LATER one. The later tool use then finds nothing and the
 * caller synthesizes `-sub-<toolUseId>` — precisely the `agents` row the write
 * lane retires for an exactly-claimed delegation (ISS-4592), i.e. a dangling
 * `agent_component_invocations.agent_id` (FK 787; nulled since ISS-5098).
 *
 * So settle every exact claim across the whole session FIRST, from
 * `buildSubagentDedupIndex` — the same correlation the `agents` write lane
 * uses — and only let the fuzzy tiers compete for what is left. This reads the
 * write lane's twin-retirement decision rather than re-deriving it, so the two
 * lanes cannot disagree.
 *
 * The same index also reports which children made a NON-unique claim, and those
 * are withheld from the fuzzy tiers (ISS-5105 review). Without that, a
 * delegation the `agents` lane declared unresolved — keeping its
 * `-sub-<toolUseId>` fallback row, which is where the spawn event lands — still
 * had its invocation handed to whichever contesting child sorted first, so the
 * two consumers of ONE delegation disagreed and sidecar load order decided who
 * won.
 */
export function pairDelegationsWithSubagents(
  session: NormalizedSession,
  parserAgentIdById: ReadonlyMap<string, string>
): { pairs: PairedDelegation[]; representedSubagentIds: Set<string> } {
  // The unattributed row is a PROVENANCE anchor, not a delegation — nothing
  // spawned it and nobody chose it. It is excluded HERE, before any matching,
  // rather than only at the candidate-emitting step: the last fallback tier pairs
  // on `startedAt === toolUse.timestamp`, and the sentinel carries the timestamp
  // of the sidechain record that minted it, so a delegation in the same instant
  // claimed it and became a spawned invocation for an agent the session never
  // made. Filtering downstream cannot undo a claim already made here — and it
  // also fed `representedSubagentIds`, hiding a REAL subagent behind the anchor.
  const subagents = (session.subagents ?? []).filter(
    (subagent) => subagent.id !== UNATTRIBUTED_SUBAGENT_ID
  );
  // Same name set `buildSubagentDedupIndex` indexes below, so a harness adding
  // a third delegation tool name cannot be indexed there and skipped here.
  const delegations = [...(session.toolUses ?? []).entries()].filter(
    ([, toolUse]) => DELEGATION_TOOL_NAMES.has(toolUse.name)
  );
  const { parserSubagentIdBySpawnToolUseId, ambiguousClaimSubagentIds } =
    buildSubagentDedupIndex(session, subagents, parserAgentIdById);
  // Keyed by the RAW subagent id, never the minted `-parser-sub-*` agent id:
  // that id round-trips through `sanitizeSubagentIdSegment`, so two distinct
  // subagent ids can collapse to one sanitized segment — a last-write-wins map
  // over the minted id would then hand an exact claim to the WRONG record.
  // Raw ids are unique within a session by construction.
  const subagentById = new Map<string, NormalizedSubagent>(
    subagents.map((subagent) => [subagent.id, subagent])
  );
  const representedSubagentIds = new Set<string>();
  const exactClaimByIndex = new Map<number, NormalizedSubagent>();
  for (const [index, toolUse] of delegations) {
    // Same key as the tier-0 check and the emitted row's
    // `provider_tool_use_id` (`delegationClaimKey`), so the pre-pass cannot
    // diverge from them when a parser populates `providerToolUseId`.
    const claimKey = delegationClaimKey(toolUse);
    const claimedSubagentId = claimKey
      ? parserSubagentIdBySpawnToolUseId.get(claimKey)
      : undefined;
    const claimant = claimedSubagentId
      ? subagentById.get(claimedSubagentId)
      : undefined;
    if (claimant && !representedSubagentIds.has(claimant.id)) {
      exactClaimByIndex.set(index, claimant);
      representedSubagentIds.add(claimant.id);
    }
  }
  const pairs: PairedDelegation[] = [];
  for (const [index, toolUse] of delegations) {
    const parserSubagent =
      exactClaimByIndex.get(index) ??
      matchSpawnedSubagent(
        toolUse,
        subagents,
        representedSubagentIds,
        ambiguousClaimSubagentIds
      );
    if (parserSubagent) {
      representedSubagentIds.add(parserSubagent.id);
    }
    pairs.push({ index, toolUse, parserSubagent });
  }
  return { pairs, representedSubagentIds };
}
