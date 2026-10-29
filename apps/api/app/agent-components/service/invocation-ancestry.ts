import "server-only";

import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import type { AgentComponentInvocationAncestry } from "@repo/api/src/types/agent-component-invocation-ancestry";
import {
  INVOCATION_ANCESTRY_MAX_HOPS,
  walkInvocationAncestry,
} from "@repo/api/src/types/agent-component-invocation-ancestry";
import type { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

type AncestryDb = Parameters<Parameters<typeof withDb>[0]>[0];

/**
 * ISS-10714: the minimum a row needs for its call chain to be walked. The page
 * read selects far more; this keeps the resolver usable by any caller holding
 * these three values.
 */
export type InvocationAncestrySeed = {
  id: string;
  generationId: string;
  externalInvocationId: string;
  componentKind: string;
  parentExternalInvocationId: string | null;
};

const PARENT_LOOKUP_SELECT = {
  generationId: true,
  externalInvocationId: true,
  parentExternalInvocationId: true,
} as const;

type ParentEdge = {
  generationId: string;
  externalInvocationId: string;
  parentExternalInvocationId: string | null;
};

/**
 * Edges indexed by generation and then by invocation id.
 *
 * `external_invocation_id` is unique only WITHIN a generation
 * (`idx_aci_generation_external_invocation`), so a generation-agnostic index
 * would let one session's chain walk into another session's row of the same
 * name.
 */
type EdgeIndex = Map<string, Map<string, string | null>>;

const EMPTY_GENERATION_EDGES: ReadonlyMap<string, string | null> = new Map();

/**
 * Resolve the ordered ancestor chain and depth for a page of invocations.
 *
 * Ancestors are followed a HOP AT A TIME, one batched query per hop across every
 * generation on the page, so a two-deep tree costs two reads rather than one per
 * row. The walk stops at {@link INVOCATION_ANCESTRY_MAX_HOPS}; a row whose chain
 * does not terminate inside it, hits a cycle, or names a parent no row answers
 * for is simply absent from the returned map — a partial chain is a wrong depth,
 * not an incomplete one.
 */
export async function loadInvocationAncestries(
  db: AncestryDb,
  rows: readonly InvocationAncestrySeed[]
): Promise<Map<string, AgentComponentInvocationAncestry>> {
  const seeds = rows.filter(isAncestryBearingSeed);
  if (seeds.length === 0) {
    return new Map();
  }
  // FAIL-OPEN ENRICHMENT, the same boundary `loadSessionLocCost` draws: the read
  // row declares `ancestry` optional and absent means "we could not tell", so an
  // ancestry read that rejects must cost the page its ancestry and nothing else.
  // Letting it unwind would discard the rows, the status counts and the source
  // occurrences that already succeeded. `await` inside the `try`, not a bare
  // return, so the rejection unwinds HERE.
  try {
    return await resolveInvocationAncestries(db, seeds);
  } catch (error) {
    log.error("agent_component_invocation_ancestry_load_failed", {
      error: parseError(error),
      rowCount: seeds.length,
    });
    return new Map();
  }
}

async function resolveInvocationAncestries(
  db: AncestryDb,
  rows: readonly InvocationAncestrySeed[]
): Promise<Map<string, AgentComponentInvocationAncestry>> {
  const resolved = new Map<string, AgentComponentInvocationAncestry>();
  const edges: EdgeIndex = new Map();
  const attempted: EdgeIndex = new Map();
  for (const row of rows) {
    recordEdge(edges, row);
    recordEdge(attempted, row);
  }
  let frontier = pendingParents(rows, attempted);
  for (let hop = 0; hop < INVOCATION_ANCESTRY_MAX_HOPS; hop++) {
    if (frontier.length === 0) {
      break;
    }
    for (const wanted of frontier) {
      recordEdge(attempted, { ...wanted, parentExternalInvocationId: null });
    }
    const fetched = await db.agentComponentInvocation.findMany({
      where: {
        OR: frontier.map((wanted) => ({
          generationId: wanted.generationId,
          externalInvocationId: wanted.externalInvocationId,
        })),
      },
      select: PARENT_LOOKUP_SELECT,
    });
    for (const found of fetched) {
      recordEdge(edges, found);
    }
    frontier = pendingParents(fetched, attempted);
  }
  for (const row of rows) {
    const ancestry = walkInvocationAncestry(
      row.externalInvocationId,
      edges.get(row.generationId) ?? EMPTY_GENERATION_EDGES
    );
    if (ancestry) {
      resolved.set(row.id, ancestry);
    }
  }
  return resolved;
}

function recordEdge(index: EdgeIndex, edge: ParentEdge): void {
  const byInvocation = index.get(edge.generationId) ?? new Map();
  byInvocation.set(edge.externalInvocationId, edge.parentExternalInvocationId);
  index.set(edge.generationId, byInvocation);
}

/**
 * The parents named by `rows` that nothing has looked for yet. A parent already
 * attempted is skipped whether or not the lookup found it, so a dangling
 * pointer is asked about once and then stays unresolved.
 */
function pendingParents(
  rows: readonly ParentEdge[],
  attempted: EdgeIndex
): { generationId: string; externalInvocationId: string }[] {
  const wanted: EdgeIndex = new Map();
  const ordered: { generationId: string; externalInvocationId: string }[] = [];
  for (const row of rows) {
    const parent = row.parentExternalInvocationId;
    if (parent === null) {
      continue;
    }
    if (
      attempted.get(row.generationId)?.has(parent) === true ||
      wanted.get(row.generationId)?.has(parent) === true
    ) {
      continue;
    }
    recordEdge(wanted, {
      generationId: row.generationId,
      externalInvocationId: parent,
      parentExternalInvocationId: null,
    });
    ordered.push({
      generationId: row.generationId,
      externalInvocationId: parent,
    });
  }
  return ordered;
}

/**
 * ONLY a subagent invocation has a parent edge to walk.
 * `linkSubagentParentExternalInvocations` (the desktop write lane) is the sole
 * producer of `parent_external_invocation_id`, and it skips every kind but
 * `subagent`. So on a Skill, Command, Tool, Mcp or Orchestration row a NULL
 * parent column means "no linker ever ran for this kind", not "this is a root
 * call" — and a chain of `[]` with a depth of `0` states the second. On a
 * component-scoped read of a skill that is EVERY row, which is a page of
 * confident false roots (tamsinb review). Absent is the contract's
 * representation of "we could not tell"; these rows get it.
 */
function isAncestryBearingSeed(seed: InvocationAncestrySeed): boolean {
  return seed.componentKind === AgentComponentInvocationKind.Subagent;
}
