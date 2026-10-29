import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import { Priority as WirePriority } from "@repo/api/src/types/common";
import {
  DocumentType,
  statusOptionsForSubtype,
} from "@repo/api/src/types/document";
import type { DocumentStatusTransition } from "@repo/api/src/types/document-status-mutation";
import {
  PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID,
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID,
} from "@repo/api/src/types/project-artifact-board-move";
import { projectArtifactTypeSupportsGroupField } from "@repo/api/src/types/project-artifact-group-authority";
import {
  evaluateProjectArtifactLanePolicy,
  type ProjectArtifactLanePolicy,
  ProjectArtifactLanePolicyReason,
} from "@repo/api/src/types/project-artifact-lane-policy";
import {
  type PlaceProjectArtifactsRequest,
  type ProjectArtifactPlacementConflictDetail,
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementKind,
  type ProjectArtifactPlacementRequest,
} from "@repo/api/src/types/project-artifact-placement";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  ArtifactSubtype,
  ArtifactType,
  Priority,
  type TransactionClient,
} from "@repo/database";
import { z } from "zod";
import type { PlacementState } from "@/app/documents/project-artifact-placement-service-support";
import {
  type ActivityActor,
  type CapturedArtifactFields,
  captureArtifactUpdate,
} from "@/lib/artifact-activity-capture";

type LaneWriteError = {
  detail: ProjectArtifactPlacementConflictDetail;
  message: string;
  status: StatusCode;
};

type LaneArtifactRow = {
  assigneeId: string | null;
  approverId: string | null;
  dueDate: Date | null;
  id: string;
  priority: string | null;
  projectId: string | null;
  status: string;
  subtype: ArtifactSubtype | null;
  title: string;
  type: ArtifactType;
};

type LaneWriteData = {
  assigneeId?: string | null;
  priority?: Priority | null;
  status?: string;
};

export type PreparedPlacementLaneWrite =
  | { kind: "none" }
  | {
      actor: ActivityActor;
      beforeRows: LaneArtifactRow[];
      kind: "patch";
      patch: PlaceProjectArtifactsRequest["lanePatch"] & {};
    }
  | {
      actor: ActivityActor;
      beforeRows: LaneArtifactRow[];
      kind: "restore";
      restoreById: ReadonlyMap<string, LaneWriteData>;
      undoOfTransactionId: string;
    };

/** Prepare the board-only lane write against the placement owner's locked state. */
export async function prepareProjectArtifactPlacementLaneWrite(input: {
  actor: ActivityActor;
  destinationProjectId: string;
  organizationId: string;
  placement: ProjectArtifactPlacementRequest;
  policy: ProjectArtifactLanePolicy | null;
  sourceArtifactIds: readonly string[];
  state: PlacementState;
  tx: TransactionClient;
}): Promise<Result<PreparedPlacementLaneWrite, LaneWriteError>> {
  if (input.placement.kind === ProjectArtifactPlacementKind.Undo) {
    return prepareLaneRestore({
      ...input,
      placement: input.placement,
    });
  }
  const patch = input.placement.lanePatch;
  if (!patch) {
    return Result.ok({ kind: "none" });
  }
  const beforeRows = await readLaneArtifacts(
    input.tx,
    input.organizationId,
    input.sourceArtifactIds
  );
  if (beforeRows.length !== input.sourceArtifactIds.length) {
    return laneWriteFailure(
      Status.NotFound,
      "Artifact not found",
      ProjectArtifactPlacementErrorReason.ArtifactNotFound
    );
  }
  const validation = await validateLanePatch({ ...input, beforeRows, patch });
  if (!validation.ok) {
    return validation;
  }
  return Result.ok({
    actor: input.actor,
    beforeRows,
    kind: "patch",
    patch,
  });
}

/** Apply only status/priority/assignee after the canonical placement write. */
export async function applyPreparedProjectArtifactPlacementLaneWrite(input: {
  organizationId: string;
  prepared: PreparedPlacementLaneWrite;
  transactionId: string;
  tx: TransactionClient;
}): Promise<void> {
  if (input.prepared.kind === "none") {
    return;
  }
  for (const before of input.prepared.beforeRows) {
    const data =
      input.prepared.kind === "patch"
        ? patchData(input.prepared.patch, before.id)
        : input.prepared.restoreById.get(before.id);
    if (!data) {
      continue;
    }
    await input.tx.artifact.update({
      data,
      select: { id: true },
      where: { id: before.id, organizationId: input.organizationId },
    });
    const after = { ...before, ...data };
    await captureArtifactUpdate({
      actor: input.prepared.actor,
      after: capturedLaneFields(after, before.projectId),
      artifactId: before.id,
      before: capturedLaneFields(before, before.projectId),
      organizationId: input.organizationId,
      transactionId: input.transactionId,
      ...(input.prepared.kind === "restore"
        ? { undoOfTransactionId: input.prepared.undoOfTransactionId }
        : {}),
      tx: input.tx,
    });
  }
}

/**
 * The status transitions a prepared lane write commits, for the post-commit
 * status side effects every other status write emits. A row already at the
 * target status did not transition and is left out.
 */
export function preparedLaneStatusTransitions(
  prepared: PreparedPlacementLaneWrite
): DocumentStatusTransition[] {
  if (prepared.kind === "none") {
    return [];
  }
  return prepared.beforeRows.flatMap((before) => {
    const data =
      prepared.kind === "patch"
        ? patchData(prepared.patch, before.id)
        : prepared.restoreById.get(before.id);
    return data?.status === undefined || data.status === before.status
      ? []
      : [{ after: data.status, before: before.status, documentId: before.id }];
  });
}

async function prepareLaneRestore(input: {
  actor: ActivityActor;
  destinationProjectId: string;
  organizationId: string;
  placement: Extract<
    ProjectArtifactPlacementRequest,
    { kind: typeof ProjectArtifactPlacementKind.Undo }
  >;
  policy: ProjectArtifactLanePolicy | null;
  sourceArtifactIds: readonly string[];
  state: PlacementState;
  tx: TransactionClient;
}): Promise<Result<PreparedPlacementLaneWrite, LaneWriteError>> {
  const events =
    (await input.tx.artifactActivityEvent.findMany({
      where: {
        organizationId: input.organizationId,
        transactionId: input.placement.undoOfTransactionId,
      },
      select: { action: true, after: true, artifactId: true, before: true },
    })) ?? [];
  const restore = laneRestoreFromEvents(events);
  if (!restore.ok) {
    return restore;
  }
  if (restore.value.size === 0) {
    return Result.ok({ kind: "none" });
  }
  const artifactIds = [...restore.value.keys()];
  const beforeRows = await readLaneArtifacts(
    input.tx,
    input.organizationId,
    artifactIds
  );
  if (
    beforeRows.length !== artifactIds.length ||
    !laneRestoreMatchesCurrent(beforeRows, restore.value)
  ) {
    return laneWriteFailure(
      Status.Conflict,
      "Project hierarchy changed since it was read",
      ProjectArtifactPlacementErrorReason.StaleVersion
    );
  }
  const policyResult = await validateLaneRestorePolicy(
    input,
    beforeRows,
    restore.value
  );
  if (!policyResult.ok) {
    return policyResult;
  }
  return Result.ok({
    actor: input.actor,
    beforeRows,
    kind: "restore",
    restoreById: new Map(
      [...restore.value].map(([id, value]) => [id, restoreData(value.before)])
    ),
    undoOfTransactionId: input.placement.undoOfTransactionId,
  });
}

async function validateLaneRestorePolicy(
  input: {
    destinationProjectId: string;
    organizationId: string;
    policy: ProjectArtifactLanePolicy | null;
    state: PlacementState;
    tx: TransactionClient;
  },
  rows: readonly LaneArtifactRow[],
  restore: ReadonlyMap<
    string,
    { before: Partial<LaneArtifactRow>; after: Partial<LaneArtifactRow> }
  >
): Promise<Result<null, LaneWriteError>> {
  const policy = input.policy;
  if (!policy) {
    return Result.ok(null);
  }
  const field = policy.field;
  const moves = rows.flatMap((row) => {
    const restored = restore.get(row.id)?.before;
    const value = restored?.[field];
    if (value === undefined) {
      return [];
    }
    return [
      {
        destinationLaneId: laneValueFromUnknown(value, field),
        rootId: row.id,
        sourceLaneId: laneValue(row, field),
      },
    ];
  });
  if (moves.length === 0) {
    return Result.ok(null);
  }
  const laneRows = await input.tx.artifact.findMany({
    where: {
      organizationId: input.organizationId,
      projectId: input.destinationProjectId,
    },
    select: { assigneeId: true, id: true, priority: true, status: true },
  });
  const laneRootIds: Record<string, string[]> = Object.create(null);
  for (const row of laneRows) {
    if (input.state.canonicalParents.has(row.id)) {
      continue;
    }
    const laneId = laneValue(row, field);
    const roots = laneRootIds[laneId] ?? [];
    roots.push(row.id);
    laneRootIds[laneId] = roots;
  }
  const result = evaluateProjectArtifactLanePolicy({
    laneRootIds,
    moves,
    policy,
  });
  return result.allowed
    ? Result.ok(null)
    : lanePolicyFailure<null>(result.reason);
}

function laneValueFromUnknown(
  value: LaneArtifactRow[keyof Pick<
    LaneArtifactRow,
    "assigneeId" | "priority" | "status"
  >],
  field: ProjectArtifactPlacementGroupField
) {
  if (typeof value === "string") {
    return value;
  }
  return field === ProjectArtifactPlacementGroupField.AssigneeId
    ? PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID
    : PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID;
}

async function validateLanePatch(input: {
  beforeRows: LaneArtifactRow[];
  destinationProjectId: string;
  organizationId: string;
  patch: NonNullable<PlaceProjectArtifactsRequest["lanePatch"]>;
  policy: ProjectArtifactLanePolicy | null;
  sourceArtifactIds: readonly string[];
  state: PlacementState;
  tx: TransactionClient;
}): Promise<Result<null, LaneWriteError>> {
  if (!lanePatchValueIsValid(input.patch, input.beforeRows)) {
    return laneWriteFailure(
      Status.BadRequest,
      "Invalid artifact placement request",
      ProjectArtifactPlacementErrorReason.InvalidRequest
    );
  }
  if (input.patch.field === ProjectArtifactPlacementGroupField.AssigneeId) {
    const assigneeId = input.patch.value;
    if (
      assigneeId &&
      !(await input.tx.user.findFirst({
        where: { id: assigneeId, organizationId: input.organizationId },
        select: { id: true },
      }))
    ) {
      return laneWriteFailure(
        Status.NotFound,
        "Assignee not found",
        ProjectArtifactPlacementErrorReason.ArtifactNotFound
      );
    }
  }
  const laneRows = await input.tx.artifact.findMany({
    where: {
      organizationId: input.organizationId,
      projectId: input.destinationProjectId,
    },
    select: { assigneeId: true, id: true, priority: true, status: true },
  });
  const laneRootIds: Record<string, string[]> = Object.create(null);
  for (const row of laneRows) {
    if (input.state.canonicalParents.has(row.id)) {
      continue;
    }
    const laneId = laneValue(row, input.patch.field);
    const laneRoots = laneRootIds[laneId] ?? [];
    laneRoots.push(row.id);
    laneRootIds[laneId] = laneRoots;
  }
  const result = evaluateProjectArtifactLanePolicy({
    expectedPolicyRevision: input.patch.expectedPolicyRevision,
    laneRootIds,
    moves: input.beforeRows.map((row) => ({
      destinationLaneId: lanePatchDestination(input.patch, row.id),
      rootId: row.id,
      sourceLaneId: laneValue(row, input.patch.field),
    })),
    policy: input.policy,
  });
  return result.allowed
    ? Result.ok(null)
    : lanePolicyFailure<null>(result.reason);
}

function laneRestoreFromEvents(
  events: readonly {
    action: string;
    after: unknown;
    artifactId: string;
    before: unknown;
  }[]
): Result<
  Map<
    string,
    { before: Partial<LaneArtifactRow>; after: Partial<LaneArtifactRow> }
  >,
  LaneWriteError
> {
  const byId = new Map<
    string,
    { before: Partial<LaneArtifactRow>; after: Partial<LaneArtifactRow> }
  >();
  for (const event of events) {
    const field = laneActivityField(event);
    if (!field) {
      continue;
    }
    const beforeValue = laneActivityValue(event.before, field);
    const afterValue = laneActivityValue(event.after, field);
    if (!(beforeValue.ok && afterValue.ok)) {
      return laneWriteFailure(
        Status.Conflict,
        "Placement receipt is not available yet",
        ProjectArtifactPlacementErrorReason.StaleVersion
      );
    }
    const current = byId.get(event.artifactId) ?? { before: {}, after: {} };
    setLaneRestoreValue(current.before, field, beforeValue.value);
    setLaneRestoreValue(current.after, field, afterValue.value);
    byId.set(event.artifactId, current);
  }
  return Result.ok(byId);
}

function laneActivityField(event: {
  action: string;
  before: unknown;
}): "assigneeId" | "priority" | "status" | null {
  if (event.action === ArtifactActivityAction.StatusChange) {
    return "status";
  }
  const parsed = LANE_ACTIVITY_ENVELOPE.safeParse(event.before);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.field === ProjectArtifactPlacementGroupField.AssigneeId ||
    parsed.data.field === ProjectArtifactPlacementGroupField.Priority
    ? parsed.data.field
    : null;
}

function laneActivityValue(
  value: unknown,
  field: "assigneeId" | "priority" | "status"
) {
  if (field === "status") {
    const parsed = z.string().safeParse(value);
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err<never, null>(null);
  }
  const parsed = LANE_ACTIVITY_ENVELOPE.safeParse(value);
  return parsed.success && parsed.data.field === field
    ? Result.ok(parsed.data.value)
    : Result.err<never, null>(null);
}

function laneRestoreMatchesCurrent(
  rows: readonly LaneArtifactRow[],
  restore: ReadonlyMap<
    string,
    { before: Partial<LaneArtifactRow>; after: Partial<LaneArtifactRow> }
  >
) {
  return rows.every((row) => {
    const expected = restore.get(row.id)?.after;
    return (
      expected !== undefined &&
      Object.entries(expected).every(
        ([field, value]) => row[field as keyof LaneArtifactRow] === value
      )
    );
  });
}

function setLaneRestoreValue(
  target: Partial<LaneArtifactRow>,
  field: "assigneeId" | "priority" | "status",
  value: string | null
) {
  if (field === "status") {
    if (value !== null) {
      target.status = value;
    }
    return;
  }
  target[field] = value;
}

function restoreData(value: Partial<LaneArtifactRow>): LaneWriteData {
  return {
    ...(Object.hasOwn(value, "assigneeId")
      ? { assigneeId: value.assigneeId ?? null }
      : {}),
    ...(Object.hasOwn(value, "priority")
      ? { priority: priorityFromWire(value.priority ?? null) }
      : {}),
    ...(value.status === undefined ? {} : { status: value.status }),
  };
}

function patchData(
  patch: NonNullable<PlaceProjectArtifactsRequest["lanePatch"]>,
  rootId: string
): LaneWriteData {
  switch (patch.field) {
    case ProjectArtifactPlacementGroupField.Status:
      return { status: lanePatchDestination(patch, rootId) };
    case ProjectArtifactPlacementGroupField.Priority:
      return { priority: priorityFromWire(patch.value) };
    case ProjectArtifactPlacementGroupField.AssigneeId:
      return { assigneeId: patch.value };
    default: {
      const exhaustive: never = patch.field;
      return exhaustive;
    }
  }
}

function lanePatchValueIsValid(
  patch: NonNullable<PlaceProjectArtifactsRequest["lanePatch"]>,
  artifacts: readonly LaneArtifactRow[]
) {
  const valuesByRootId = patch.valuesByRootId;
  if (
    !artifacts.every((artifact) =>
      projectArtifactTypeSupportsGroupField(artifact.type, patch.field)
    ) ||
    (valuesByRootId &&
      (patch.field !== ProjectArtifactPlacementGroupField.Status ||
        Object.keys(valuesByRootId).length !== artifacts.length ||
        artifacts.some(
          (artifact) => !Object.hasOwn(valuesByRootId, artifact.id)
        )))
  ) {
    return false;
  }
  switch (patch.field) {
    case ProjectArtifactPlacementGroupField.Status:
      return Boolean(
        (patch.value || valuesByRootId) &&
          artifacts.every((artifact) => {
            const type = documentTypeForArtifact(artifact);
            const target = lanePatchDestination(patch, artifact.id);
            return type
              ? statusOptionsForSubtype(type).some(
                  (status) => status === target
                )
              : false;
          })
      );
    case ProjectArtifactPlacementGroupField.Priority:
      return patch.value === null || priorityFromWire(patch.value) !== null;
    case ProjectArtifactPlacementGroupField.AssigneeId:
      return true;
    default: {
      const exhaustive: never = patch.field;
      return exhaustive;
    }
  }
}

function documentTypeForArtifact(
  artifact: LaneArtifactRow
): DocumentType | null {
  if (!(artifact.type === ArtifactType.DOCUMENT && artifact.subtype)) {
    return null;
  }
  switch (artifact.subtype) {
    case ArtifactSubtype.PRD:
      return DocumentType.Prd;
    case ArtifactSubtype.IMPLEMENTATION_PLAN:
      return DocumentType.ImplementationPlan;
    case ArtifactSubtype.TEMPLATE:
      return DocumentType.Template;
    case ArtifactSubtype.FEATURE:
    case ArtifactSubtype.ISSUE:
      return DocumentType.Feature;
    case ArtifactSubtype.DOC:
      return DocumentType.Doc;
    default: {
      const exhaustive: never = artifact.subtype;
      return exhaustive;
    }
  }
}

function readLaneArtifacts(
  tx: TransactionClient,
  organizationId: string,
  artifactIds: readonly string[]
): Promise<LaneArtifactRow[]> {
  return tx.artifact
    .findMany({
      where: { id: { in: [...artifactIds] }, organizationId },
      select: CAPTURED_LANE_ARTIFACT_SELECT,
    })
    .then((rows) =>
      rows.map((row) => ({
        ...row,
        approverId: null,
        title: row.name,
      }))
    );
}

function capturedLaneFields(
  artifact: Pick<
    LaneArtifactRow,
    "assigneeId" | "approverId" | "dueDate" | "priority" | "status" | "title"
  >,
  projectId: string | null
): CapturedArtifactFields {
  return { ...artifact, projectId };
}

function laneValue(
  artifact: Pick<LaneArtifactRow, "assigneeId" | "priority" | "status">,
  field: ProjectArtifactPlacementGroupField
) {
  switch (field) {
    case ProjectArtifactPlacementGroupField.Status:
      return artifact.status;
    case ProjectArtifactPlacementGroupField.Priority:
      return artifact.priority ?? PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID;
    case ProjectArtifactPlacementGroupField.AssigneeId:
      return artifact.assigneeId ?? PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function lanePatchDestination(
  patch: NonNullable<PlaceProjectArtifactsRequest["lanePatch"]>,
  rootId: string
) {
  return (
    patch.valuesByRootId?.[rootId] ??
    patch.value ??
    (patch.field === ProjectArtifactPlacementGroupField.AssigneeId
      ? PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID
      : PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID)
  );
}

function priorityFromWire(value: string | null): Priority | null {
  if (value === null) {
    return null;
  }
  switch (value) {
    case WirePriority.Urgent:
      return Priority.URGENT;
    case WirePriority.High:
      return Priority.HIGH;
    case WirePriority.Medium:
      return Priority.MEDIUM;
    case WirePriority.Low:
      return Priority.LOW;
    default:
      return null;
  }
}

function lanePolicyFailure<T>(reason: ProjectArtifactLanePolicyReason) {
  const placementReason = {
    [ProjectArtifactLanePolicyReason.PolicyChanged]:
      ProjectArtifactPlacementErrorReason.PolicyChanged,
    [ProjectArtifactLanePolicyReason.UnsupportedTransition]:
      ProjectArtifactPlacementErrorReason.UnsupportedTransition,
    [ProjectArtifactLanePolicyReason.WipLimitReached]:
      ProjectArtifactPlacementErrorReason.WipLimitReached,
  }[reason];
  return laneWriteFailure<T>(
    Status.Conflict,
    lanePolicyMessage(reason),
    placementReason
  );
}

function lanePolicyMessage(reason: ProjectArtifactLanePolicyReason) {
  if (reason === ProjectArtifactLanePolicyReason.UnsupportedTransition) {
    return "Unsupported transition";
  }
  if (reason === ProjectArtifactLanePolicyReason.WipLimitReached) {
    return "WIP limit";
  }
  return "Project hierarchy changed since it was read";
}

function laneWriteFailure<T>(
  status: StatusCode,
  message: string,
  reason: ProjectArtifactPlacementErrorReason
): Result<T, LaneWriteError> {
  return Result.err({ detail: { reason }, message, status });
}

const LANE_ACTIVITY_ENVELOPE = z
  .object({
    field: z.string(),
    value: z.string().nullable(),
  })
  .strict();

const CAPTURED_LANE_ARTIFACT_SELECT = {
  assigneeId: true,
  dueDate: true,
  id: true,
  name: true,
  priority: true,
  projectId: true,
  status: true,
  subtype: true,
  type: true,
} as const;
