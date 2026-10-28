import { Prisma, type TransactionClient, withDb } from "@repo/database";
import {
  authorizePlacementDomain,
  type PlacementActor,
  readPlacementState,
} from "@/app/documents/project-artifact-placement-service-support";

type ProjectPlacementState = {
  projectVersion: string;
  canPlaceArtifacts: boolean;
};

/** Read hierarchy state through placement authorization in a new stable snapshot. */
export function getProjectPlacementState(
  projectId: string,
  organizationId: string,
  actor: PlacementActor,
  includeAllTypes = false
): Promise<ProjectPlacementState | null> {
  return withDb.tx(
    (tx) =>
      readAuthorizedPlacementState(
        tx,
        projectId,
        organizationId,
        actor,
        includeAllTypes
      ),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}

/** Join the caller's already-open snapshot; never request nested isolation. */
export function getProjectPlacementStateInCurrentTransaction(
  projectId: string,
  organizationId: string,
  actor: PlacementActor,
  includeAllTypes = false
): Promise<ProjectPlacementState | null> {
  return withDb((tx) =>
    readAuthorizedPlacementState(
      tx,
      projectId,
      organizationId,
      actor,
      includeAllTypes
    )
  );
}

async function readAuthorizedPlacementState(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  actor: PlacementActor,
  includeAllTypes: boolean
): Promise<ProjectPlacementState | null> {
  const authorization = await authorizePlacementDomain(
    tx,
    organizationId,
    [projectId],
    actor,
    false
  );
  if (!authorization.authorized) {
    return null;
  }
  const state = await readPlacementState(
    tx,
    organizationId,
    [projectId],
    includeAllTypes
  );
  const projectVersion = state.projectVersions[projectId];
  return projectVersion
    ? { projectVersion, canPlaceArtifacts: authorization.canWrite }
    : null;
}

/**
 * The project's placement fence, for a read that renders a tree from a cohort
 * narrower than the project (a contributor filter drops Branch rows), so the
 * version it reports still matches what a placement POST checks.
 */
export async function readProjectPlacementVersion(
  projectId: string,
  organizationId: string
): Promise<string | undefined> {
  const state = await withDb((tx) =>
    readPlacementState(tx, organizationId, [projectId])
  );
  return state.projectVersions[projectId];
}
