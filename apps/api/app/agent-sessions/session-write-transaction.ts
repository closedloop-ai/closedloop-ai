import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { ArtifactFieldEditField } from "@repo/api/src/types/artifact-field-edit-receipt";
import {
  type Result,
  Status,
  type StatusCode,
} from "@repo/api/src/types/result";
import { type TransactionClient, withDb } from "@repo/database";
import { listSessionsByArtifactIds } from "./service/list-by-artifact-ids";

/**
 * A transaction-scoped refusal that must escape the callback to roll back.
 *
 * `withDb.tx` joins an ambient transaction instead of opening a savepoint, so
 * this wrapper must remain the outermost transaction boundary. A caller that
 * needs work on the same transaction must pass that work into the service
 * rather than catch a refusal inside its own transaction.
 */
export class SessionWriteRefusal extends Error {
  readonly status: StatusCode;
  readonly field: ArtifactFieldEditField | undefined;

  constructor(status: StatusCode, field?: ArtifactFieldEditField) {
    super(`session write refused with status ${status}`);
    this.name = "SessionWriteRefusal";
    this.status = status;
    this.field = field;
  }
}

type AssignmentTargetInput = {
  organizationId: string;
  projectId?: string | null;
  ownerUserId?: string | null;
};

type AssignmentTargets = {
  projectId: string | null;
  ownerUserId: string | null;
};

/** Resolve assignment targets only when they belong to the caller's org. */
export async function resolveSessionAssignmentTargets(
  tx: TransactionClient,
  input: AssignmentTargetInput
): Promise<AssignmentTargets> {
  const targets: AssignmentTargets = { projectId: null, ownerUserId: null };
  if (input.projectId) {
    const project = await tx.project.findFirst({
      where: { id: input.projectId, organizationId: input.organizationId },
      select: { id: true },
    });
    if (!project) {
      throw new SessionWriteRefusal(
        Status.BadRequest,
        ArtifactFieldEditField.ProjectId
      );
    }
    targets.projectId = project.id;
  }
  if (input.ownerUserId) {
    const owner = await tx.user.findFirst({
      where: { id: input.ownerUserId, organizationId: input.organizationId },
      select: { id: true },
    });
    if (!owner) {
      throw new SessionWriteRefusal(
        Status.BadRequest,
        ArtifactFieldEditField.AssigneeId
      );
    }
    targets.ownerUserId = owner.id;
  }
  return targets;
}

/** Run one session write and convert only deliberate refusals to Result errors. */
export async function runSessionWrite<T>(
  fn: (tx: TransactionClient) => Promise<T>,
  onRefusal?: (refusal: SessionWriteRefusal) => void
): Promise<Result<T>> {
  try {
    return { ok: true, value: await withDb.tx(fn) };
  } catch (error) {
    if (error instanceof SessionWriteRefusal) {
      onRefusal?.(error);
      return { ok: false, error: error.status };
    }
    throw error;
  }
}

/** Read the canonical list projection returned by session write routes. */
export async function readSessionWriteListItem(
  organizationId: string,
  artifactId: string
): Promise<AgentSessionListItem | undefined> {
  const [session] = await listSessionsByArtifactIds(
    organizationId,
    [artifactId],
    1
  );
  return session;
}
