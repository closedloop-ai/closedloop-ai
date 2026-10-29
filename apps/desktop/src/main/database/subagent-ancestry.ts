/**
 * @file subagent-ancestry.ts
 * @description ISS-10714: rebuilding the real spawn tree from evidence the
 * parsers already record, rather than hanging every subagent off the main
 * agent.
 *
 * The join needs no new capture. A subagent records the delegation that spawned
 * it (`metadata.spawnedByToolUseId`, written by
 * `packages/lib/harness/claude/parse-claude-delegations.ts`); that delegation is
 * an `Agent`/`Task` tool use somewhere in the session; and WHERE that tool use
 * sits names its caller — on `session.toolUses` it belongs to the main agent
 * (or to `toolUse.subagentId` when the parser attributed it), and on
 * `subagent.toolUses` it belongs to that subagent. Follow the edge repeatedly
 * and the chain and its depth fall out.
 *
 * The claim side of that join is NOT re-derived here: `buildSubagentDedupIndex`
 * already canonicalizes `spawnedByToolUseId` through `delegationClaimKey`,
 * already refuses a claim two children share, and already hands back the tool
 * use object itself. This module adds only the missing half — which agent OWNS
 * that tool use — so the two lanes cannot disagree about which delegation
 * spawned which child.
 *
 * DEPTH IS NOT A COUNT OF ROWS. Main is depth 0 (a root invocation), its direct
 * children are depth 1. A subagent whose parent could not be reconstructed has
 * NO depth: it is absent, never 0 and never 1, because "we could not tell" and
 * "spawned by the main agent" are different facts. Callers that must still
 * write a non-null `parent_agent_id` fall back to the main agent for the FK's
 * sake and read {@link SubagentAncestry.parentSource} to know they did.
 */
import type {
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "../collectors/types.js";
import {
  buildSubagentDedupIndex,
  DELEGATION_TOOL_NAMES,
  type SubagentDedupIndex,
} from "./subagent-dedup.js";

/** Where a resolved parent came from, or why no parent could be resolved. */
export const SubagentParentSource = {
  /** The spawning `Agent`/`Task` tool use was found and its owner identified. */
  SpawnToolUse: "spawn_tool_use",
  /** Fallback: the parser's own `parentId` (the record's `parentUuid`). */
  ParentUuid: "parent_uuid",
  /** No spawn evidence at all — the caller's main-agent default stands. */
  NoEvidence: "no_evidence",
  /** Evidence exists but names a delegation this session cannot resolve. */
  UnresolvableSpawnClaim: "unresolvable_spawn_claim",
  /** Two children claim the same delegation; neither may claim the parent. */
  AmbiguousSpawnClaim: "ambiguous_spawn_claim",
  /** The evidence makes the subagent its own parent. */
  SelfParent: "self_parent",
  /** The resolved edges form a cycle, so no chain terminates. */
  CyclicAncestry: "cyclic_ancestry",
} as const;
export type SubagentParentSource =
  (typeof SubagentParentSource)[keyof typeof SubagentParentSource];

/** One subagent's reconstructed place in the spawn tree. */
export type SubagentAncestry = {
  /**
   * The RAW parser subagent id of the resolved parent, `null` when the parent
   * is the main agent, and `undefined` when no parent could be reconstructed.
   * The three are deliberately distinct: only `null` asserts the main agent.
   */
  parentSubagentId: string | null | undefined;
  parentSource: SubagentParentSource;
  /**
   * Main is 0, a direct child of main is 1. Absent when the chain could not be
   * reconstructed — never defaulted to 0 or 1.
   */
  depth: number | undefined;
  /**
   * Ordered ancestor chain, nearest parent first, ending at the main agent
   * (represented by `null`). Empty when the chain could not be reconstructed.
   */
  chain: readonly (string | null)[];
};

/** How much of the session's spawn evidence actually resolved. */
export type SubagentAncestryCounts = {
  subagents: number;
  resolvedToSubagent: number;
  resolvedToMain: number;
  /**
   * A SUBSET of the two counters above, not a partition member: a subagent
   * whose own parent is evidence but whose distance from the root is not,
   * because an ancestor further up is unreconstructable.
   */
  resolvedParentUnknownDepth: number;
  noEvidence: number;
  unresolvableSpawnClaim: number;
  ambiguousSpawnClaim: number;
  selfParent: number;
  cyclicAncestry: number;
};

export type SubagentAncestryIndex = {
  bySubagentId: ReadonlyMap<string, SubagentAncestry>;
  counts: SubagentAncestryCounts;
  /** Deepest reconstructed depth in the session; 0 when nothing resolved. */
  maxDepth: number;
};

/**
 * Which agent issued each delegating tool use, by tool-use object identity.
 *
 * Identity rather than id is deliberate: the ids are canonicalized by
 * `delegationClaimKey` in `subagent-dedup.ts`, which also drops keys two tool
 * uses collide on. Keying this index by id would re-open that collision under a
 * second, differently-behaved derivation; keying it by the object the dedup
 * index already resolved keeps one answer.
 *
 * `null` means the main agent.
 */
function buildDelegationOwnerIndex(
  session: NormalizedSession,
  parserSubagents: readonly NormalizedSubagent[]
): Map<NormalizedToolUse, string | null> {
  const owners = new Map<NormalizedToolUse, string | null>();
  for (const toolUse of session.toolUses ?? []) {
    if (DELEGATION_TOOL_NAMES.has(toolUse.name)) {
      owners.set(toolUse, toolUse.subagentId ?? null);
    }
  }
  for (const subagent of parserSubagents) {
    for (const toolUse of subagent.toolUses ?? []) {
      if (DELEGATION_TOOL_NAMES.has(toolUse.name)) {
        owners.set(toolUse, subagent.id);
      }
    }
  }
  return owners;
}

type ResolvedEdge = {
  parentSubagentId: string | null | undefined;
  parentSource: SubagentParentSource;
};

function edgeFromSpawnToolUse(
  subagent: NormalizedSubagent,
  spawnToolUse: NormalizedToolUse,
  owners: ReadonlyMap<NormalizedToolUse, string | null>,
  knownSubagentIds: ReadonlySet<string>
): ResolvedEdge | null {
  if (!owners.has(spawnToolUse)) {
    return null;
  }
  const owner = owners.get(spawnToolUse) ?? null;
  if (owner === null) {
    return {
      parentSubagentId: null,
      parentSource: SubagentParentSource.SpawnToolUse,
    };
  }
  if (owner === subagent.id) {
    return {
      parentSubagentId: undefined,
      parentSource: SubagentParentSource.SelfParent,
    };
  }
  if (!knownSubagentIds.has(owner)) {
    return null;
  }
  return {
    parentSubagentId: owner,
    parentSource: SubagentParentSource.SpawnToolUse,
  };
}

function edgeFromParentUuid(
  subagent: NormalizedSubagent,
  knownSubagentIds: ReadonlySet<string>
): ResolvedEdge | null {
  const parentId = subagent.parentId;
  if (!(parentId && knownSubagentIds.has(parentId))) {
    return null;
  }
  if (parentId === subagent.id) {
    return {
      parentSubagentId: undefined,
      parentSource: SubagentParentSource.SelfParent,
    };
  }
  return {
    parentSubagentId: parentId,
    parentSource: SubagentParentSource.ParentUuid,
  };
}

function resolveEdge(
  subagent: NormalizedSubagent,
  dedup: SubagentDedupIndex,
  owners: ReadonlyMap<NormalizedToolUse, string | null>,
  knownSubagentIds: ReadonlySet<string>
): ResolvedEdge {
  if (dedup.ambiguousClaimSubagentIds.has(subagent.id)) {
    return {
      parentSubagentId: undefined,
      parentSource: SubagentParentSource.AmbiguousSpawnClaim,
    };
  }
  const spawnToolUse = dedup.spawnToolUseBySubagentId.get(subagent.id);
  if (spawnToolUse) {
    const resolved = edgeFromSpawnToolUse(
      subagent,
      spawnToolUse,
      owners,
      knownSubagentIds
    );
    if (resolved) {
      return resolved;
    }
  }
  const viaParentUuid = edgeFromParentUuid(subagent, knownSubagentIds);
  if (viaParentUuid) {
    return viaParentUuid;
  }
  // The claim survives on the record even when nothing in this session answers
  // it (a version-skewed sidecar, a cross-session claim, a collided alias). It
  // is a different fact from a record that never named a delegation at all, and
  // both are counted separately.
  const claimed = spawnClaimPresent(subagent);
  return {
    parentSubagentId: undefined,
    parentSource: claimed
      ? SubagentParentSource.UnresolvableSpawnClaim
      : SubagentParentSource.NoEvidence,
  };
}

function spawnClaimPresent(subagent: NormalizedSubagent): boolean {
  const claim = subagent.metadata?.spawnedByToolUseId;
  return typeof claim === "string" && claim.length > 0;
}

/**
 * Walk one subagent's edges toward the main agent.
 *
 * THE THREE OUTCOMES ARE DIFFERENT FACTS and the caller treats them
 * differently. `root` terminated at the main agent, so the depth is a
 * measurement. `unknownAncestor` means some ancestor's own parent could not be
 * reconstructed: this subagent's PARENT is still known — that edge is evidence —
 * but its distance from the root is not, so a depth would be a guess. `cycle`
 * means the edges loop, which makes the parent itself nonsense rather than
 * merely unplaced; transcript-derived ancestry crosses a trust boundary and is
 * not guaranteed acyclic, so a revisit ends the walk instead of hanging it.
 */
type WalkOutcome =
  | { status: "root"; depth: number; chain: (string | null)[] }
  | { status: "unknownAncestor" }
  | { status: "cycle" };

function walkChain(
  subagentId: string,
  edges: ReadonlyMap<string, ResolvedEdge>
): WalkOutcome {
  const chain: (string | null)[] = [];
  const seen = new Set<string>([subagentId]);
  let current = subagentId;
  for (;;) {
    const edge = edges.get(current);
    if (!edge || edge.parentSubagentId === undefined) {
      return { status: "unknownAncestor" };
    }
    if (edge.parentSubagentId === null) {
      chain.push(null);
      return { status: "root", depth: chain.length, chain };
    }
    if (seen.has(edge.parentSubagentId)) {
      return { status: "cycle" };
    }
    seen.add(edge.parentSubagentId);
    chain.push(edge.parentSubagentId);
    current = edge.parentSubagentId;
  }
}

function emptyCounts(subagents: number): SubagentAncestryCounts {
  return {
    subagents,
    resolvedToSubagent: 0,
    resolvedToMain: 0,
    resolvedParentUnknownDepth: 0,
    noEvidence: 0,
    unresolvableSpawnClaim: 0,
    ambiguousSpawnClaim: 0,
    selfParent: 0,
    cyclicAncestry: 0,
  };
}

/**
 * Which counter an UNRESOLVED subagent lands in, by the reason it was
 * unresolved. Exhaustive rather than partial: a new {@link SubagentParentSource}
 * member must name its counter (or `null` for the sources that resolve a
 * parent) or this fails typecheck, instead of silently going uncounted.
 */
const UNRESOLVED_COUNT_KEY: Record<
  SubagentParentSource,
  keyof SubagentAncestryCounts | null
> = {
  [SubagentParentSource.SpawnToolUse]: null,
  [SubagentParentSource.ParentUuid]: null,
  [SubagentParentSource.NoEvidence]: "noEvidence",
  [SubagentParentSource.UnresolvableSpawnClaim]: "unresolvableSpawnClaim",
  [SubagentParentSource.AmbiguousSpawnClaim]: "ambiguousSpawnClaim",
  [SubagentParentSource.SelfParent]: "selfParent",
  [SubagentParentSource.CyclicAncestry]: "cyclicAncestry",
};

/**
 * Reconstruct every subagent's parent, depth, and ancestor chain for one
 * session. Pure: it reads the normalized session and writes nothing.
 */
export function buildSubagentAncestryIndex(
  session: NormalizedSession,
  subagentIdByNormalizedId: ReadonlyMap<string, string>,
  dedupIndex?: SubagentDedupIndex
): SubagentAncestryIndex {
  const parserSubagents = session.subagents ?? [];
  const counts = emptyCounts(parserSubagents.length);
  const bySubagentId = new Map<string, SubagentAncestry>();
  if (parserSubagents.length === 0) {
    return { bySubagentId, counts, maxDepth: 0 };
  }
  const dedup =
    dedupIndex ??
    buildSubagentDedupIndex(session, parserSubagents, subagentIdByNormalizedId);
  const owners = buildDelegationOwnerIndex(session, parserSubagents);
  const knownSubagentIds = new Set(parserSubagents.map((s) => s.id));
  const edges = new Map<string, ResolvedEdge>();
  for (const subagent of parserSubagents) {
    edges.set(
      subagent.id,
      resolveEdge(subagent, dedup, owners, knownSubagentIds)
    );
  }
  let maxDepth = 0;
  for (const subagent of parserSubagents) {
    const ancestry = ancestryFromEdges(subagent.id, edges);
    bySubagentId.set(subagent.id, ancestry);
    tallyAncestry(ancestry, counts);
    maxDepth = Math.max(maxDepth, ancestry.depth ?? 0);
  }
  return { bySubagentId, counts, maxDepth };
}

/**
 * One subagent's published ancestry, from the resolved edge set.
 *
 * A subagent with no usable edge of its own carries that edge's reason and no
 * depth. Otherwise the walk decides how much of the ancestry survives: only a
 * `cycle` withdraws the parent (a looping edge is nonsense, not merely
 * unplaced), while an `unknownAncestor` keeps the parent — it IS evidence — and
 * withholds the depth alone.
 */
function ancestryFromEdges(
  subagentId: string,
  edges: ReadonlyMap<string, ResolvedEdge>
): SubagentAncestry {
  const edge = edges.get(subagentId);
  if (!edge || edge.parentSubagentId === undefined) {
    return {
      parentSubagentId: undefined,
      parentSource: edge?.parentSource ?? SubagentParentSource.NoEvidence,
      depth: undefined,
      chain: [],
    };
  }
  const walked = walkChain(subagentId, edges);
  if (walked.status === "cycle") {
    return {
      parentSubagentId: undefined,
      parentSource: SubagentParentSource.CyclicAncestry,
      depth: undefined,
      chain: [],
    };
  }
  // The parent edge stands either way; only the distance to the root depends on
  // the rest of the chain resolving. A truncated chain would read as a
  // shallower call site, so it is withheld rather than shortened.
  return {
    parentSubagentId: edge.parentSubagentId,
    parentSource: edge.parentSource,
    depth: walked.status === "root" ? walked.depth : undefined,
    chain: walked.status === "root" ? walked.chain : [],
  };
}

/**
 * Count one ancestry, in the branch its outcome actually took — a resolution
 * counter incremented before the walk succeeded would report evidence the
 * session does not have.
 */
function tallyAncestry(
  ancestry: SubagentAncestry,
  counts: SubagentAncestryCounts
): void {
  if (ancestry.parentSubagentId !== undefined) {
    if (ancestry.parentSubagentId === null) {
      counts.resolvedToMain++;
    } else {
      counts.resolvedToSubagent++;
    }
    if (ancestry.depth === undefined) {
      counts.resolvedParentUnknownDepth++;
    }
    return;
  }
  const countKey = UNRESOLVED_COUNT_KEY[ancestry.parentSource];
  if (countKey) {
    counts[countKey]++;
  }
}
