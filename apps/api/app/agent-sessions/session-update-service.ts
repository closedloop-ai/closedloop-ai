import {
  type AgentSessionFieldMutationError,
  type AgentSessionStaleFields,
  staleSessionFieldsConflict,
} from "@repo/api/src/types/agent-session-field-mutation";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { ArtifactStatusProvenance } from "@repo/api/src/types/artifact-status-contract";
import { isStaleExpectation } from "@repo/api/src/types/optimistic-write-guard";
import {
  type Result,
  Status,
  type StatusCode,
} from "@repo/api/src/types/result";
import { Prisma, type TransactionClient } from "@repo/database";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";
import { captureSessionGroupingChanges } from "@/lib/artifact-field-edit-capture";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { isUuid } from "./service/coercion";
import {
  buildSessionConflictAnalyticsChanges,
  buildSessionGroupingAnalyticsChanges,
  emitSessionGroupingAnalytics,
  type SessionGroupingAnalyticsChange,
} from "./session-field-edit-analytics";
import type { SessionFieldsWrite } from "./session-operation-receipt";
import {
  emitSessionUpdateSideEffects,
  type SessionUpdateSideEffectFacts,
} from "./session-update-side-effects";
import type { UpdateSessionInput } from "./session-write-service";
import {
  readSessionWriteListItem,
  resolveSessionAssignmentTargets,
  runSessionWrite,
  SessionWriteRefusal,
} from "./session-write-transaction";
import type { AgentSessionUpdateResponse } from "./write-contract";

/**
 * Execute one grouping-field update through the public session-write facade.
 * `recordWrite` runs on the update's own transaction with the artifact columns
 * that moved, so a receipt that cannot be stored rolls the update back
 * (ISS-12552).
 */
async function updateSession(
  input: UpdateSessionInput,
  recordWrite?: RecordWriteInTransaction<SessionFieldsWrite>
): Promise<
  Result<
    AgentSessionUpdateResponse,
    StatusCode | AgentSessionFieldMutationError
  >
> {
  const provenance = createArtifactFieldEditAnalyticsContext({
    organizationId: input.organizationId,
    userId: input.actor.userId,
    surface: input.surface,
    authMethod: input.actor.authMethod,
  }).provenance;
  let refusedField: ArtifactFieldEditField | undefined;
  const result = await runSessionWrite(
    (tx) => updateSessionInTx(tx, input, provenance, recordWrite),
    (refusal) => {
      refusedField = refusal.field;
    }
  );
  if (!result.ok) {
    if (result.error === Status.BadRequest) {
      emitSessionGroupingAnalytics({
        organizationId: input.organizationId,
        userId: input.actor.userId,
        changes: buildSessionTargetValidationChanges(input, refusedField),
        forcedResult: ArtifactFieldEditOutcome.ValidationFailed,
        ...(provenance === undefined ? {} : { provenance }),
      });
    }
    return result;
  }
  if (!result.value.ok) {
    if (typeof result.value.error === "object") {
      emitSessionGroupingAnalytics({
        organizationId: input.organizationId,
        userId: input.actor.userId,
        changes: buildSessionConflictAnalyticsChanges(
          result.value.error,
          input
        ),
        forcedResult: ArtifactFieldEditOutcome.Conflict,
        ...(provenance === undefined ? {} : { provenance }),
      });
    }
    return result.value;
  }
  const written = result.value.value;
  emitSessionGroupingAnalytics({
    organizationId: input.organizationId,
    userId: input.actor.userId,
    changes: written.changes,
    ...(provenance === undefined ? {} : { provenance }),
  });
  emitSessionUpdateSideEffects(
    {
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      userId: input.actor.userId,
    },
    written
  );

  const session = await readSessionWriteListItem(
    input.organizationId,
    input.sessionId
  );
  if (!session) {
    return { ok: false, error: Status.NotFound };
  }
  return { ok: true, value: { session } };
}

/** Named owner for the session grouping mutation contract. */
export const sessionUpdateService = { updateSession };

async function updateSessionInTx(
  tx: TransactionClient,
  requested: UpdateSessionInput,
  provenance: ArtifactStatusProvenance | undefined,
  recordWrite: RecordWriteInTransaction<SessionFieldsWrite> | undefined
): Promise<
  Result<SessionUpdateWritten, StatusCode | AgentSessionFieldMutationError>
> {
  if (!isUuid(requested.sessionId)) {
    throw new SessionWriteRefusal(Status.NotFound);
  }

  const targets = await resolveSessionAssignmentTargets(tx, requested);
  const guarded = await applyGuards(tx, requested);
  if (!guarded.ok) {
    return guarded;
  }
  const { input, before } = guarded.value;
  const analyticsAfter = {
    status: requested.status,
    projectId:
      requested.projectId === undefined ? undefined : targets.projectId,
    ownerUserId:
      requested.ownerUserId === undefined ? undefined : targets.ownerUserId,
  };
  const artifactPatch = {
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.projectId === undefined ? {} : { projectId: targets.projectId }),
    ...(input.ownerUserId === undefined
      ? {}
      : { assigneeId: targets.ownerUserId }),
  };

  if (Object.keys(artifactPatch).length > 0) {
    const updated = await tx.artifact.updateMany({
      where: {
        id: input.sessionId,
        organizationId: input.organizationId,
        type: ArtifactType.Session,
      },
      data: artifactPatch,
    });
    // `updateMany` reports `{count: 0}` when the row is absent or belongs to
    // another org, where `update` would throw. The count turns either case into
    // the route's 404 instead of a silent successful no-op.
    if (updated.count !== 1) {
      throw new SessionWriteRefusal(Status.NotFound);
    }
  } else {
    const found = await tx.artifact.findFirst({
      where: {
        id: input.sessionId,
        organizationId: input.organizationId,
        type: ArtifactType.Session,
      },
      select: { id: true },
    });
    if (!found) {
      throw new SessionWriteRefusal(Status.NotFound);
    }
  }

  await captureSessionGroupingChanges({
    tx,
    organizationId: input.organizationId,
    artifactId: input.sessionId,
    actor: input.actor,
    before,
    after: {
      status: input.status,
      projectId: input.projectId === undefined ? undefined : targets.projectId,
      ownerUserId:
        input.ownerUserId === undefined ? undefined : targets.ownerUserId,
    },
    provenance,
  });
  // `input` already dropped every field the row held, so the patch's keys are
  // exactly the columns this write moved.
  await recordWrite?.(tx, { changedFields: Object.keys(artifactPatch) });

  return {
    ok: true,
    value: {
      ...(input.ownerUserId === undefined
        ? {}
        : { ownerUserId: targets.ownerUserId }),
      ...(input.projectId === undefined || before.projectId === undefined
        ? {}
        : {
            projectChange: {
              artifactId: input.sessionId,
              before: before.projectId,
              after: targets.projectId,
            },
          }),
      ...(input.ownerUserId === undefined || before.ownerUserId === undefined
        ? {}
        : {
            ownerChange: {
              artifactId: input.sessionId,
              before: before.ownerUserId,
              after: targets.ownerUserId,
            },
          }),
      changes: buildSessionGroupingAnalyticsChanges(before, analyticsAfter),
    },
  };
}

function buildSessionTargetValidationChanges(
  input: UpdateSessionInput,
  refusedField: ArtifactFieldEditField | undefined
): SessionGroupingAnalyticsChange[] {
  return [
    ...(input.projectId === undefined ||
    refusedField !== ArtifactFieldEditField.ProjectId
      ? []
      : [
          {
            field: ArtifactFieldEditField.ProjectId,
            after: input.projectId,
          },
        ]),
    ...(input.ownerUserId === undefined ||
    refusedField !== ArtifactFieldEditField.AssigneeId
      ? []
      : [
          {
            field: ArtifactFieldEditField.AssigneeId,
            after: input.ownerUserId,
          },
        ]),
  ];
}

async function applyGuards(
  tx: TransactionClient,
  input: UpdateSessionInput
): Promise<
  Result<
    {
      input: UpdateSessionInput;
      before: {
        status?: string;
        projectId?: string | null;
        ownerUserId?: string | null;
      };
    },
    StatusCode | AgentSessionFieldMutationError
  >
> {
  const touchesArtifact =
    input.status !== undefined ||
    input.projectId !== undefined ||
    input.ownerUserId !== undefined ||
    input.expectedStatus !== undefined ||
    input.expectedProjectId !== undefined ||
    input.expectedOwnerUserId !== undefined;
  const artifact = touchesArtifact
    ? await lockSessionArtifactRow(tx, input)
    : undefined;
  if (artifact === null) {
    return { ok: false, error: Status.NotFound };
  }
  const conflict = staleSessionFieldsConflict(
    artifact
      ? {
          ...staleArtifactGuards(input, artifact),
          ...staleOwnerGuard(input, artifact.assigneeId),
        }
      : {}
  );
  if (conflict) {
    return { ok: false, error: conflict };
  }
  const locked = {
    status: artifact?.status,
    projectId: artifact?.projectId,
    ownerUserId: artifact?.assigneeId,
  };
  return {
    ok: true,
    value: { input: withoutUnchangedFields(input, locked), before: locked },
  };
}

function withoutUnchangedFields(
  input: UpdateSessionInput,
  locked: {
    status: string | undefined;
    projectId: string | null | undefined;
    ownerUserId: string | null | undefined;
  }
): UpdateSessionInput {
  const { status, projectId, ownerUserId, ...rest } = input;
  return {
    ...rest,
    ...(status === undefined || status === locked.status ? {} : { status }),
    ...(projectId === undefined || projectId === locked.projectId
      ? {}
      : { projectId }),
    ...(ownerUserId === undefined || ownerUserId === locked.ownerUserId
      ? {}
      : { ownerUserId }),
  };
}

type LockedSessionArtifactRow = {
  status: string;
  projectId: string | null;
  assigneeId: string | null;
};

async function lockSessionArtifactRow(
  tx: TransactionClient,
  input: UpdateSessionInput
): Promise<LockedSessionArtifactRow | null> {
  // A Session artifact without its session_detail row cannot be returned by
  // the route's canonical list projection. Lock the joined pair first so an
  // ISS-12251 detail-less row cannot commit a grouping write and then 404.
  const [row] = await tx.$queryRaw<LockedSessionArtifactRow[]>(Prisma.sql`
    SELECT "status", "project_id" AS "projectId", "assignee_id" AS "assigneeId"
    FROM "artifacts"
    WHERE "id" = ${input.sessionId}::uuid
      AND "organization_id" = ${input.organizationId}::uuid
      AND "type" = ${ArtifactType.Session}::"ArtifactType"
      AND EXISTS (
        SELECT 1 FROM "session_detail"
        WHERE "session_detail"."artifact_id" = "artifacts"."id"
      )
    FOR NO KEY UPDATE
  `);
  return row ?? null;
}

function staleArtifactGuards(
  input: UpdateSessionInput,
  row: LockedSessionArtifactRow
): AgentSessionStaleFields {
  const stale: AgentSessionStaleFields = {};
  const { expectedStatus, expectedProjectId } = input;
  if (
    expectedStatus !== undefined &&
    isStaleExpectation<string>(row.status, input.status, expectedStatus)
  ) {
    stale.status = {
      documentId: input.sessionId,
      currentStatus: row.status,
      expectedStatus,
    };
  }
  if (
    expectedProjectId !== undefined &&
    isStaleExpectation(row.projectId, input.projectId, expectedProjectId)
  ) {
    stale.projectId = {
      documentId: input.sessionId,
      currentProjectId: row.projectId,
      expectedProjectId,
    };
  }
  return stale;
}

function staleOwnerGuard(
  input: UpdateSessionInput,
  currentOwnerUserId: string | null
): AgentSessionStaleFields {
  const { expectedOwnerUserId } = input;
  if (
    expectedOwnerUserId === undefined ||
    !isStaleExpectation(
      currentOwnerUserId,
      input.ownerUserId,
      expectedOwnerUserId
    )
  ) {
    return {};
  }
  return {
    ownerUserId: {
      documentId: input.sessionId,
      currentOwnerUserId,
      expectedOwnerUserId,
    },
  };
}

type SessionUpdateWritten = SessionUpdateSideEffectFacts & {
  changes: SessionGroupingAnalyticsChange[];
};
