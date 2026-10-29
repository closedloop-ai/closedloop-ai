/**
 * @file local-invocation-ancestry.ts
 * @description ISS-10714: the DESKTOP-LOCAL half of the reconstructed call
 * chain the cloud read publishes as `AgentComponentInvocationReadRow.ancestry`.
 *
 * Without this the shared read row carried the chain on app.closedloop.ai and
 * not in LocalElectron, so the very records this ticket reconstructs rendered
 * without their depth on the surface that captured them (whitlockk review). One
 * derivation is the point: both readers walk the SAME
 * {@link walkInvocationAncestry}, so the two surfaces cannot disagree about how
 * deep a call sits.
 *
 * It costs ONE aggregate query per page rather than the cloud's per-hop batches.
 * The local store holds a session's whole invocation set in one table with no
 * org predicate to route through, so every edge the walk can need is fetched at
 * once and the hop loop runs in memory.
 */

import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import type { AgentComponentInvocationAncestry } from "@repo/api/src/types/agent-component-invocation-ancestry";
import { walkInvocationAncestry } from "@repo/api/src/types/agent-component-invocation-ancestry";
import type { DbHostPrisma } from "../database/prisma-client.js";

type AncestryPrisma = Pick<DbHostPrisma, "client">;

/** What a page row must carry for its chain to be resolvable. */
export type LocalInvocationAncestrySeed = {
  id: string;
  session_id: string;
  external_invocation_id: string;
  component_kind: string;
};

type LocalParentEdgeRow = {
  session_id: string;
  external_invocation_id: string;
  parent_external_invocation_id: string | null;
};

const EMPTY_SESSION_EDGES: ReadonlyMap<string, string | null> = new Map();

/**
 * Resolve each page row's ancestor chain, keyed by row id.
 *
 * A row whose chain cannot be reconstructed is ABSENT from the map, never a
 * zero depth — the read row's contract makes "we could not tell" and "this is a
 * root call" different facts, and a `0` states the second.
 */
export async function loadLocalInvocationAncestries(
  prisma: AncestryPrisma,
  rows: readonly LocalInvocationAncestrySeed[]
): Promise<Map<string, AgentComponentInvocationAncestry>> {
  const seeds = rows.filter(isLocalAncestryBearingSeed);
  if (seeds.length === 0) {
    return new Map();
  }
  // FAIL-OPEN ENRICHMENT, the same boundary the cloud resolver draws: `ancestry`
  // is optional on the read row, so a failed ancestry read costs the page its
  // chains and nothing else. Letting it unwind would discard the rows and the
  // status counts that already succeeded.
  try {
    return await resolveLocalInvocationAncestries(prisma, seeds);
  } catch {
    // Client-side of the desktop boundary logs nothing here; the absent chain is
    // the surfaced signal, and the renderer already renders absence.
    return new Map();
  }
}

async function resolveLocalInvocationAncestries(
  prisma: AncestryPrisma,
  seeds: readonly LocalInvocationAncestrySeed[]
): Promise<Map<string, AgentComponentInvocationAncestry>> {
  const sessionIds = Array.from(new Set(seeds.map((row) => row.session_id)));
  const edgeRows = await prisma.client.$queryRawUnsafe<LocalParentEdgeRow[]>(
    `SELECT session_id,
            external_invocation_id,
            json_extract(evidence_pointer, '$.parentExternalInvocationId')
              AS parent_external_invocation_id
       FROM agent_component_invocations
      WHERE component_kind = ?
        AND session_id IN (${sessionIds.map(() => "?").join(", ")})`,
    AgentComponentInvocationKind.Subagent,
    ...sessionIds
  );
  // `external_invocation_id` is unique only WITHIN a session, so a
  // session-agnostic index would walk one session's chain through another's row
  // of the same name — the same scoping the cloud resolver applies per
  // generation.
  const edgesBySession = new Map<string, Map<string, string | null>>();
  for (const edge of edgeRows) {
    const bySession =
      edgesBySession.get(edge.session_id) ?? new Map<string, string | null>();
    bySession.set(
      edge.external_invocation_id,
      edge.parent_external_invocation_id
    );
    edgesBySession.set(edge.session_id, bySession);
  }
  const resolved = new Map<string, AgentComponentInvocationAncestry>();
  for (const seed of seeds) {
    const ancestry = walkInvocationAncestry(
      seed.external_invocation_id,
      edgesBySession.get(seed.session_id) ?? EMPTY_SESSION_EDGES
    );
    if (ancestry) {
      resolved.set(seed.id, ancestry);
    }
  }
  return resolved;
}

/**
 * ONLY a subagent invocation has a parent edge to walk.
 * `linkSubagentParentExternalInvocations` is the sole producer of
 * `parentExternalInvocationId` and it skips every other kind, so on a Skill,
 * Command, Tool, Mcp or Orchestration row an absent pointer means "no linker
 * runs for this kind" and not "this is a root call". Publishing a depth of 0 for
 * them would be a page of confident false roots (tamsinb review).
 */
function isLocalAncestryBearingSeed(
  seed: LocalInvocationAncestrySeed
): boolean {
  return seed.component_kind === AgentComponentInvocationKind.Subagent;
}
