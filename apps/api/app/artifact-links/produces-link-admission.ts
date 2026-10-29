import {
  type CreateArtifactLinkInput,
  LinkType,
} from "@repo/api/src/types/artifact";
import { ProjectArtifactPlacementErrorReason } from "@repo/api/src/types/project-artifact-placement";
import { Prisma, type TransactionClient } from "@repo/database";
import { readCanonicalHierarchyMetadata } from "@/app/artifacts/project-tree-service/canonical-parents";
import { fitsDepthLimit } from "@/app/documents/project-artifact-placement-helpers";
import { readAllKindsPlacementState } from "@/app/documents/project-artifact-placement-service-support";

/**
 * The namespace the `artifact_links_reject_produces_cycle` trigger locks
 * (migration 20261022022500). Taking it here first makes this check and the
 * trigger read one serialized organization graph, so a refusal is reported as a
 * value instead of surfacing as the trigger's exception.
 */
const PRODUCES_ADMISSION_LOCK_NAMESPACE = 9001;

export type ProducesLinkRefusal =
  | typeof ProjectArtifactPlacementErrorReason.Cycle
  | typeof ProjectArtifactPlacementErrorReason.MaxDepth;

/**
 * Refuses a PRODUCES edge whose source is already reachable from its target
 * (ISS-12929 726-F4, ISS-9514). UNION expands each artifact once however many
 * paths reach it, so shared children cost the graph's size, not its paths. Call it last before the insert: the trigger
 * takes this lock at insert time, after the project and sibling-rank locks, and
 * every writer has to take them in that same order.
 */
export async function refuseProducesLinkCycle(
  tx: TransactionClient,
  organizationId: string,
  sourceId: string,
  targetId: string
): Promise<ProducesLinkRefusal | null> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(${PRODUCES_ADMISSION_LOCK_NAMESPACE}::int4, hashtext(${organizationId}::text))`
  );
  const [row] = await tx.$queryRaw<Array<{ closesCycle: boolean }>>(
    Prisma.sql`
      WITH RECURSIVE descendants AS (
        SELECT ${targetId}::uuid AS artifact_id
        UNION
        SELECT link.target_id
        FROM descendants
        JOIN artifact_links link ON link.source_id = descendants.artifact_id
        WHERE link.organization_id = ${organizationId}::uuid
          AND link.link_type = ${LinkType.Produces}::"LinkType"
      )
      SELECT EXISTS (
        SELECT 1 FROM descendants WHERE artifact_id = ${sourceId}::uuid
      ) AS "closesCycle"
    `
  );
  return row?.closesCycle ? ProjectArtifactPlacementErrorReason.Cycle : null;
}

/**
 * Refuses a same-project PRODUCES edge that would push that project's tree past
 * four levels, with placement's own depth rule (ISS-12929 726-F4; ISS-6560 reqs
 * 2, 6 and 18). A cross-project edge is lineage, not a tree edge, and gets only
 * the cycle check. An edge that cannot become the target's canonical parent
 * leaves the tree as it is, so it is admitted.
 */
export async function refuseProducesLinkDepth(
  tx: TransactionClient,
  organizationId: string,
  input: CreateArtifactLinkInput,
  endpoints: readonly { id: string; projectId: string | null }[]
): Promise<ProducesLinkRefusal | null> {
  const sourceProjectId = endpoints.find(
    (endpoint) => endpoint.id === input.sourceId
  )?.projectId;
  const targetProjectId = endpoints.find(
    (endpoint) => endpoint.id === input.targetId
  )?.projectId;
  if (!sourceProjectId || sourceProjectId !== targetProjectId) {
    return null;
  }
  const hierarchy = readCanonicalHierarchyMetadata(input.metadata);
  if (hierarchy?.suppressed === true) {
    return null;
  }
  const state = await readAllKindsPlacementState(tx, organizationId, [
    sourceProjectId,
  ]);
  const becomesCanonicalParent =
    hierarchy?.canonical === true ||
    !state.canonicalParents.has(input.targetId);
  if (
    !becomesCanonicalParent ||
    fitsDepthLimit([input.targetId], input.sourceId, state)
  ) {
    return null;
  }
  return ProjectArtifactPlacementErrorReason.MaxDepth;
}
