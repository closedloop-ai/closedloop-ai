import type {
  PlaceProjectArtifactsRequest,
  ProjectArtifactPlacementConflictDetail,
  ProjectArtifactPlacementRequest,
  ProjectArtifactPlacementResponse,
} from "@repo/api/src/types/project-artifact-placement";
import {
  PROJECT_ARTIFACT_PLACEMENT_MAX_EXPANDED_ARTIFACTS,
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { lockProjectRank } from "@/app/documents/document-sort-order";
import {
  captureMovedProjectChanges,
  recordPlacementActivity,
} from "@/app/documents/project-artifact-placement-activity";
import { commitProjectArtifactPlacement } from "@/app/documents/project-artifact-placement-commit";
import {
  collectSubtrees,
  compareSnapshotRows,
  fitsDepthLimit,
  hashPlacementRequest,
  mapRequestedSourcesToRoots,
  neighborhoodKey,
  normalizeSourceRoots,
  parseNeighborhoodKey,
  placementWouldCreateCycle,
  resolveDestinationParentId,
  resolveHierarchyInsertionIndex,
  sortedUnique,
  staleVersionDetail,
} from "@/app/documents/project-artifact-placement-helpers";
import {
  PLACEMENT_CYCLE_MESSAGE,
  PLACEMENT_MAX_DEPTH_MESSAGE,
} from "@/app/documents/project-artifact-placement-messages";
import { isUnchangedHierarchyPlacement } from "@/app/documents/project-artifact-placement-noop";
import {
  expandedArtifactLimitFailure,
  placementFailure,
  replayCommittedEvent,
} from "@/app/documents/project-artifact-placement-outcomes";
import {
  applyPlacementPlan,
  type PlacementParentProjection,
  type PlacementPlan,
} from "@/app/documents/project-artifact-placement-persistence";
import {
  lockPlacementReceipt,
  readPlacementReceipt,
} from "@/app/documents/project-artifact-placement-receipt";
import {
  emitPlacementRootFieldEffects,
  type PlacementRootFieldCommit,
  placementRootFieldsAfter,
  readPlacementRootFields,
  validatePlacementRootFields,
} from "@/app/documents/project-artifact-placement-root-fields";
import type { PlacementActor } from "@/app/documents/project-artifact-placement-service-support";
import {
  authorizePlacementDomain,
  emptyReceiptSnapshot,
  type PlacementReceiptSnapshot,
  type PlacementRootFieldSnapshot,
  type PlacementState,
  parentIdsSnapshot,
  readAllKindsPlacementState,
  readPlacementState,
  receiptCreatedParentIds,
  receiptExistingParentIds,
  siblingsFor,
  snapshotRows,
} from "@/app/documents/project-artifact-placement-service-support";
import {
  getProjectPlacementState,
  getProjectPlacementStateInCurrentTransaction,
} from "@/app/documents/project-artifact-placement-state";
import { getPrismaRawQuerySqlState } from "@/lib/db-utils";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

export type PlacementError = {
  status: StatusCode;
  message: string;
  detail: ProjectArtifactPlacementConflictDetail;
};

/** Stable data exposed to a caller-specific hierarchy validator inside the placement transaction. */
export type ProjectArtifactPlacementValidationContext = {
  readonly tx: TransactionClient;
  readonly routeProjectId: string;
  readonly organizationId: string;
  readonly input: PlaceProjectArtifactsRequest;
  readonly sourceArtifactIds: readonly string[];
  readonly movedArtifactIds: readonly string[];
  readonly destinationParentId: string | null;
  readonly affectedProjectIds: readonly string[];
};

/**
 * Optional caller-owned policy for a Place request. It runs after the core
 * hierarchy and stale-view checks but before the idempotency claim or any
 * placement write, using the same transaction supplied to the core.
 */
export type ProjectArtifactPlacementValidator = (
  context: ProjectArtifactPlacementValidationContext
) => PlacementError | null | Promise<PlacementError | null>;

/** Input for the transaction-composable placement core. */
export type ApplyProjectArtifactPlacementInTransactionParams = {
  routeProjectId: string;
  organizationId: string;
  input: ProjectArtifactPlacementRequest;
  actor: PlacementActor;
  requestHash?: string;
  validatePlacement?: ProjectArtifactPlacementValidator;
  onRootFieldsCommitted?: (commit: PlacementRootFieldCommit) => void;
  /** Include every artifact kind in hierarchy placement. */
  includeAllTypes?: boolean;
  /**
   * Fence on the flag-off hierarchy revision, which also hashes row fields.
   * Defaults to `includeAllTypes`; the flag-on route passes false so its fence
   * matches the version the tree, board and placement state reads report.
   */
  fieldRevisions?: boolean;
  rootInsertion?: "start" | "end";
  rootParentArtifactId?: string | null;
};

type UndoReceipt = {
  affectedProjectIds: string[];
  afterState: PlacementReceiptSnapshot;
  beforeState: PlacementReceiptSnapshot;
  sourceArtifactIds: string[];
};

/** Apply one atomic stable-id placement or restore a prior placement receipt. */
async function placeProjectArtifacts(
  routeProjectId: string,
  organizationId: string,
  input: ProjectArtifactPlacementRequest,
  actor: PlacementActor,
  options: PlaceProjectArtifactsOptions = {}
): Promise<Result<ProjectArtifactPlacementResponse, PlacementError>> {
  const requestHash =
    options.requestHash ?? hashPlacementRequest(routeProjectId, input);
  let rootFieldCommit: PlacementRootFieldCommit | undefined;
  let result: Result<ProjectArtifactPlacementResponse, PlacementError>;
  try {
    const { recordPlaced, ...placementOptions } = options;
    result = await withDb.tx(
      async (tx) => {
        const placed = await applyProjectArtifactPlacementInTransaction(tx, {
          routeProjectId,
          organizationId,
          input,
          actor,
          requestHash,
          ...placementOptions,
          onRootFieldsCommitted: (commit) => {
            rootFieldCommit = commit;
          },
        });
        if (placed.ok && !placed.value.replayed) {
          await recordPlaced?.(tx, placed.value);
        }
        return placed;
      },
      options.includeAllTypes
        ? {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 30_000,
          }
        : undefined
    );
  } catch (error) {
    if (
      options.includeAllTypes &&
      ((error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034") ||
        getPrismaRawQuerySqlState(error) === "40001")
    ) {
      return placementFailure(
        Status.Conflict,
        "The project changed during this move. Refresh and retry.",
        ProjectArtifactPlacementErrorReason.StaleVersion
      );
    }
    throw error;
  }
  if (result.ok && rootFieldCommit && !result.value.replayed) {
    try {
      await emitPlacementRootFieldEffects(rootFieldCommit);
    } catch (error) {
      log.error("Failed to emit placement root field side effects", {
        organizationId,
        transactionId: result.value.transactionId,
        error: parseError(error),
      });
    }
  }
  return result;
}

/**
 * Apply placement inside a caller-owned transaction. The function acquires
 * deterministic project rank locks, validates the actor and stale-view fence,
 * and writes the receipt, hierarchy, ranks, and activity atomically.
 */
export async function applyProjectArtifactPlacementInTransaction(
  tx: TransactionClient,
  params: ApplyProjectArtifactPlacementInTransactionParams
): Promise<Result<ProjectArtifactPlacementResponse, PlacementError>> {
  const { routeProjectId, organizationId, input, actor } = params;
  const requestHash =
    params.requestHash ?? hashPlacementRequest(routeProjectId, input);
  await lockPlacementReceipt(tx, organizationId, input.idempotencyKey);
  const undo =
    input.kind === ProjectArtifactPlacementKind.Undo
      ? await readUndoReceipt(tx, routeProjectId, organizationId, input)
      : null;
  if (undo && !undo.ok) {
    return undo;
  }
  const affectedProjectIds =
    input.kind === ProjectArtifactPlacementKind.Place
      ? sortedUnique([routeProjectId, input.destinationProjectId])
      : (undo?.value.affectedProjectIds ?? []);
  for (const projectId of affectedProjectIds) {
    await lockProjectRank(tx, projectId);
  }
  const authorization = await authorizePlacementDomain(
    tx,
    organizationId,
    affectedProjectIds,
    actor,
    true
  );
  if (!authorization.authorized) {
    return placementFailure(
      Status.NotFound,
      "Project not found",
      ProjectArtifactPlacementErrorReason.PermissionDenied
    );
  }
  const committed = await readPlacementReceipt(tx, organizationId, {
    idempotencyKey: input.idempotencyKey,
  });
  if (committed) {
    return replayCommittedEvent(committed, routeProjectId, requestHash);
  }
  const current = await readPlacementState(
    tx,
    organizationId,
    affectedProjectIds,
    params.includeAllTypes,
    placementFieldRevisions(params)
  );
  const stale = staleVersionDetail(
    affectedProjectIds,
    input.expectedProjectVersions,
    current.projectVersions
  );
  if (stale) {
    return Result.err({
      status: Status.Conflict,
      message: "Project hierarchy changed since it was read",
      detail: stale,
    });
  }
  const planResult =
    input.kind === ProjectArtifactPlacementKind.Place
      ? buildPlacementPlan(current, input, routeProjectId, params)
      : buildUndoPlan(
          undo?.value.beforeState ?? emptyReceiptSnapshot(),
          undo?.value.afterState ?? emptyReceiptSnapshot(),
          undo?.value.sourceArtifactIds ?? [],
          affectedProjectIds,
          current
        );
  if (!planResult.ok) {
    return planResult;
  }
  const plan = planResult.value;
  const validationError = await runCallerPlacementValidator(tx, params, plan);
  if (validationError) {
    return Result.err(validationError);
  }
  const rootFields = await preparePlacementRootFields(
    tx,
    organizationId,
    input,
    actor,
    plan.sourceArtifactIds,
    undo?.value ?? null,
    params.includeAllTypes
  );
  if (!rootFields.ok) {
    return rootFields;
  }
  if (
    mayShortCircuitUnchangedPlacement(params.includeAllTypes, input) &&
    isUnchangedHierarchyPlacement(plan, current, rootFields.value)
  ) {
    return Result.ok({
      placed: true,
      transactionId: input.idempotencyKey,
      affectedArtifactIds: [],
      affectedProjectIds: plan.affectedProjectIds,
      descendantCount: 0,
      projectVersions: current.projectVersions,
      placement: plan.placement,
      sourceRootMappings: plan.sourceRootMappings,
      replayed: false,
      undoAvailable: false,
    });
  }
  return Result.ok(
    await commitProjectArtifactPlacement(tx, {
      organizationId,
      routeProjectId,
      input,
      actor,
      requestHash,
      plan,
      rootFields: rootFields.value,
      onRootFieldsCommitted: params.onRootFieldsCommitted,
      includeAllTypes: params.includeAllTypes,
      fieldRevisions: placementFieldRevisions(params),
    })
  );
}

/** Restore a verified receipt snapshot inside a caller-owned transaction. */
export async function recoverProjectArtifactPlacementSnapshotInTransaction(
  tx: TransactionClient,
  params: {
    organizationId: string;
    actor: PlacementActor;
    transactionId: string;
    affectedProjectIds: string[];
    sourceArtifactIds: string[];
    snapshot: PlacementReceiptSnapshot;
    current: PlacementState;
  }
): Promise<Result<Record<string, string>, PlacementError>> {
  const planResult = buildUndoPlan(
    params.snapshot,
    params.snapshot,
    params.sourceArtifactIds,
    params.affectedProjectIds,
    params.current
  );
  if (!planResult.ok) {
    return planResult;
  }
  const plan = planResult.value;
  await applyPlacementPlan(tx, params.organizationId, plan);
  // Placement receipts are all-kind (ISS-12929), so recovery reads every kind.
  const after = await readAllKindsPlacementState(
    tx,
    params.organizationId,
    params.affectedProjectIds
  );
  const recoveryTransactionId = crypto.randomUUID();
  await recordPlacementActivity(
    tx,
    params.organizationId,
    params.actor,
    recoveryTransactionId,
    params.transactionId,
    plan,
    ProjectArtifactPlacementSource.Api
  );
  await captureMovedProjectChanges(
    tx,
    params.organizationId,
    params.actor,
    recoveryTransactionId,
    plan
  );
  return Result.ok(after.projectVersions);
}

async function readUndoReceipt(
  tx: TransactionClient,
  routeProjectId: string,
  organizationId: string,
  input: Extract<
    ProjectArtifactPlacementRequest,
    { kind: typeof ProjectArtifactPlacementKind.Undo }
  >
): Promise<Result<UndoReceipt, PlacementError>> {
  const event = await readPlacementReceipt(tx, organizationId, {
    transactionId: input.undoOfTransactionId,
  });
  if (!event || event.routeProjectId !== routeProjectId) {
    return placementFailure(
      Status.NotFound,
      "Placement receipt not found",
      ProjectArtifactPlacementErrorReason.ArtifactNotFound
    );
  }
  const beforeState = event.beforeState;
  const afterState = event.afterState;
  if (
    beforeState.rankRows.length >
    PROJECT_ARTIFACT_PLACEMENT_MAX_EXPANDED_ARTIFACTS
  ) {
    return expandedArtifactLimitFailure();
  }
  return Result.ok({
    affectedProjectIds: sortedUnique(event.affectedProjectIds),
    afterState,
    beforeState,
    sourceArtifactIds: event.sourceArtifactIds,
  });
}

function buildPlacementPlan(
  state: PlacementState,
  input: PlaceProjectArtifactsRequest,
  routeProjectId: string,
  options: Pick<
    ApplyProjectArtifactPlacementInTransactionParams,
    "rootInsertion" | "rootParentArtifactId" | "includeAllTypes"
  >
): Result<PlacementPlan, PlacementError> {
  const requestedSources = input.sourceArtifactIds.map((sourceId) =>
    state.artifactsById.get(sourceId)
  );
  if (requestedSources.some((source) => !source)) {
    return placementFailure(
      Status.NotFound,
      "Artifact not found",
      ProjectArtifactPlacementErrorReason.ArtifactNotFound
    );
  }
  if (requestedSources.some((source) => source?.projectId !== routeProjectId)) {
    return placementFailure(
      Status.BadRequest,
      "Every source artifact must belong to the route project",
      ProjectArtifactPlacementErrorReason.InvalidRequest
    );
  }
  const sourceArtifactIds = normalizeSourceRoots(
    input.sourceArtifactIds,
    state.canonicalParents
  );
  if (sourceArtifactIds.length === 0) {
    return placementFailure(
      Status.BadRequest,
      "No independent source artifacts",
      ProjectArtifactPlacementErrorReason.InvalidRequest
    );
  }
  const sourceRootMappings = mapRequestedSourcesToRoots(
    input.sourceArtifactIds,
    sourceArtifactIds,
    state.canonicalParents
  );
  const movedArtifactIds = collectSubtrees(
    sourceArtifactIds,
    state.childrenByParent
  );
  if (
    movedArtifactIds.length > PROJECT_ARTIFACT_PLACEMENT_MAX_EXPANDED_ARTIFACTS
  ) {
    return expandedArtifactLimitFailure();
  }
  const movedIdSet = new Set(movedArtifactIds);
  const destinationResult = validatePlacementDestination(
    state,
    input,
    movedIdSet,
    options.rootParentArtifactId
  );
  if (!destinationResult.ok) {
    return destinationResult;
  }
  const destinationParentId = destinationResult.value;
  if (
    placementWouldCreateCycle(
      movedIdSet,
      destinationParentId,
      state.allParentIds
    )
  ) {
    return placementFailure(
      Status.BadRequest,
      PLACEMENT_CYCLE_MESSAGE,
      ProjectArtifactPlacementErrorReason.Cycle
    );
  }
  if (!fitsDepthLimit(sourceArtifactIds, destinationParentId, state)) {
    return placementFailure(
      Status.BadRequest,
      PLACEMENT_MAX_DEPTH_MESSAGE,
      ProjectArtifactPlacementErrorReason.MaxDepth
    );
  }

  const affectedNeighborhoods = new Set<string>();
  for (const sourceId of sourceArtifactIds) {
    const source = state.artifactsById.get(sourceId);
    if (!source?.projectId) {
      return placementFailure(
        Status.NotFound,
        "Source artifact not found",
        ProjectArtifactPlacementErrorReason.ArtifactNotFound
      );
    }
    affectedNeighborhoods.add(
      neighborhoodKey(
        source.projectId,
        state.canonicalParents.get(sourceId)?.parentId ?? null
      )
    );
  }
  affectedNeighborhoods.add(
    neighborhoodKey(input.destinationProjectId, destinationParentId)
  );

  const rankOrders = new Map<string, string[]>();
  for (const key of affectedNeighborhoods) {
    const [projectId, parentId] = parseNeighborhoodKey(key);
    rankOrders.set(
      key,
      siblingsFor(state, projectId, parentId).filter(
        (artifactId) => !sourceArtifactIds.includes(artifactId)
      )
    );
  }
  const destinationKey = neighborhoodKey(
    input.destinationProjectId,
    destinationParentId
  );
  const destinationOrder = rankOrders.get(destinationKey) ?? [];
  const insertionIndex = resolveHierarchyInsertionIndex(
    destinationOrder,
    input,
    options.rootInsertion
  );
  if (insertionIndex === null) {
    return placementFailure(
      Status.NotFound,
      "Target is not in the destination neighborhood",
      ProjectArtifactPlacementErrorReason.TargetNotFound
    );
  }
  destinationOrder.splice(insertionIndex, 0, ...sourceArtifactIds);
  rankOrders.set(destinationKey, destinationOrder);

  const snapshotIds = new Set(movedArtifactIds);
  for (const order of rankOrders.values()) {
    for (const artifactId of order) {
      snapshotIds.add(artifactId);
    }
  }
  const beforeState = snapshotRows(snapshotIds, state);
  if (beforeState.length > PROJECT_ARTIFACT_PLACEMENT_MAX_EXPANDED_ARTIFACTS) {
    return expandedArtifactLimitFailure();
  }
  const movedRootParents = sourceArtifactIds.map((artifactId) => ({
    artifactId,
    sourceIds: state.canonicalParents.get(artifactId)?.parentId
      ? [state.canonicalParents.get(artifactId)?.parentId as string]
      : [],
  }));
  const affectedArtifactIds = sortedUnique([
    ...movedArtifactIds,
    ...Array.from(rankOrders.values()).flat(),
  ]);
  const projectedIds = options.includeAllTypes
    ? movedArtifactIds
    : sourceArtifactIds;
  const desiredParentIds = new Map(
    projectedIds.map((artifactId) => [
      artifactId,
      sourceArtifactIds.includes(artifactId)
        ? destinationParentId
        : (state.canonicalParents.get(artifactId)?.parentId ?? null),
    ])
  );
  const desiredProjectIds = new Map(
    projectedIds.map((artifactId) => [artifactId, input.destinationProjectId])
  );
  return Result.ok({
    mode: "place",
    affectedArtifactIds,
    affectedProjectIds: sortedUnique(
      beforeState.map((row) => row.projectId).concat(input.destinationProjectId)
    ),
    beforeState,
    receiptBeforeState: { version: 2, rankRows: beforeState, movedRootParents },
    destinationParentId,
    createdParentIds: new Map(
      sourceArtifactIds.map((artifactId) => [
        artifactId,
        destinationParentId &&
        !state.incomingProduces.get(artifactId)?.includes(destinationParentId)
          ? destinationParentId
          : null,
      ])
    ),
    resultParentIds: new Map(
      sourceArtifactIds.map((artifactId) => [artifactId, destinationParentId])
    ),
    currentParentIds: new Map(
      sourceArtifactIds.map((artifactId) => [
        artifactId,
        state.canonicalParents.get(artifactId)?.parentId ?? null,
      ])
    ),
    movedArtifactIds,
    sourceArtifactIds,
    sourceRootMappings,
    parentProjections: buildParentProjections(
      state,
      projectedIds,
      desiredParentIds,
      desiredProjectIds
    ),
    placement: {
      sourceArtifactIds,
      destinationProjectId: input.destinationProjectId,
      position: input.position,
      ...(input.targetArtifactId
        ? { targetArtifactId: input.targetArtifactId }
        : {}),
    },
    rankOrders,
  });
}

function validatePlacementDestination(
  state: PlacementState,
  input: PlaceProjectArtifactsRequest,
  movedIdSet: ReadonlySet<string>,
  rootParentArtifactId: string | null | undefined
): Result<string | null, PlacementError> {
  const target = input.targetArtifactId
    ? state.artifactsById.get(input.targetArtifactId)
    : undefined;
  if (input.targetArtifactId && !target) {
    return placementFailure(
      Status.NotFound,
      "Target artifact not found",
      ProjectArtifactPlacementErrorReason.TargetNotFound
    );
  }
  if (target && target.projectId !== input.destinationProjectId) {
    return placementFailure(
      Status.BadRequest,
      "Target artifact is not in the destination project",
      ProjectArtifactPlacementErrorReason.InvalidRequest
    );
  }
  if (input.targetArtifactId && movedIdSet.has(input.targetArtifactId)) {
    return placementFailure(
      Status.BadRequest,
      "Target cannot be inside the moved subtree",
      ProjectArtifactPlacementErrorReason.Cycle
    );
  }
  if (
    input.position === ProjectArtifactPlacementPosition.Root &&
    rootParentArtifactId
  ) {
    const parent = state.artifactsById.get(rootParentArtifactId);
    if (!parent || parent.projectId !== input.destinationProjectId) {
      return placementFailure(
        Status.NotFound,
        "Destination parent not found",
        ProjectArtifactPlacementErrorReason.TargetNotFound
      );
    }
    if (movedIdSet.has(rootParentArtifactId)) {
      return placementFailure(
        Status.BadRequest,
        PLACEMENT_CYCLE_MESSAGE,
        ProjectArtifactPlacementErrorReason.Cycle
      );
    }
    return Result.ok(rootParentArtifactId);
  }
  return Result.ok(resolveDestinationParentId(input, state.canonicalParents));
}

function buildUndoPlan(
  storedBeforeState: PlacementReceiptSnapshot,
  currentManagedState: PlacementReceiptSnapshot,
  originalSourceArtifactIds: string[],
  originalAffectedProjectIds: string[],
  current: PlacementState
): Result<PlacementPlan, PlacementError> {
  const sourceArtifactIds = sortedUnique(originalSourceArtifactIds);
  const restoreArtifactIds = storedBeforeState.rankRows.map(
    (row) => row.artifactId
  );
  if (
    restoreArtifactIds.length >
    PROJECT_ARTIFACT_PLACEMENT_MAX_EXPANDED_ARTIFACTS
  ) {
    return expandedArtifactLimitFailure();
  }
  if (
    restoreArtifactIds.some(
      (artifactId) => !current.artifactsById.has(artifactId)
    )
  ) {
    return placementFailure(
      Status.NotFound,
      "An artifact from the placement receipt no longer exists",
      ProjectArtifactPlacementErrorReason.ArtifactNotFound
    );
  }
  const beforeState = snapshotRows(new Set(restoreArtifactIds), current);
  const rankOrders = new Map<string, string[]>();
  for (const row of storedBeforeState.rankRows) {
    const key = neighborhoodKey(row.projectId, row.parentId);
    const ids = rankOrders.get(key) ?? [];
    ids.push(row.artifactId);
    rankOrders.set(key, ids);
  }
  for (const [key, ids] of rankOrders) {
    const byId = new Map(
      storedBeforeState.rankRows.map((row) => [row.artifactId, row])
    );
    ids.sort((left, right) =>
      compareSnapshotRows(byId.get(left), byId.get(right))
    );
    rankOrders.set(key, ids);
  }
  const first = storedBeforeState.rankRows.find((row) =>
    sourceArtifactIds.includes(row.artifactId)
  );
  if (!first) {
    return placementFailure(
      Status.BadRequest,
      "Placement receipt has no state",
      ProjectArtifactPlacementErrorReason.InvalidRequest
    );
  }
  const desiredParentIds = new Map(
    sourceArtifactIds.map((artifactId) => [
      artifactId,
      storedBeforeState.movedRootParents.find(
        (parent) => parent.artifactId === artifactId
      )?.sourceIds[0] ?? null,
    ])
  );
  const desiredProjectIds = new Map(
    sourceArtifactIds.flatMap((artifactId) => {
      const projectId = storedBeforeState.rankRows.find(
        (row) => row.artifactId === artifactId
      )?.projectId;
      return projectId ? [[artifactId, projectId] as const] : [];
    })
  );
  return Result.ok({
    mode: "restore",
    affectedArtifactIds: sortedUnique(restoreArtifactIds),
    affectedProjectIds: sortedUnique([
      ...originalAffectedProjectIds,
      ...storedBeforeState.rankRows.map((row) => row.projectId),
    ]),
    beforeState,
    receiptBeforeState: {
      version: 2,
      rankRows: beforeState,
      movedRootParents: parentIdsSnapshot(
        receiptExistingParentIds(
          currentManagedState,
          sourceArtifactIds,
          current
        ),
        sourceArtifactIds
      ),
    },
    destinationParentId: first.parentId,
    createdParentIds: receiptCreatedParentIds(
      storedBeforeState,
      sourceArtifactIds,
      current
    ),
    resultParentIds: desiredParentIds,
    currentParentIds: receiptExistingParentIds(
      currentManagedState,
      sourceArtifactIds,
      current
    ),
    movedArtifactIds: sortedUnique(sourceArtifactIds),
    sourceArtifactIds: sortedUnique(sourceArtifactIds),
    sourceRootMappings: sourceArtifactIds.map((sourceArtifactId) => ({
      sourceArtifactId,
      rootArtifactId: sourceArtifactId,
    })),
    parentProjections: buildParentProjections(
      current,
      sourceArtifactIds,
      desiredParentIds,
      desiredProjectIds
    ),
    placement: {
      sourceArtifactIds,
      destinationProjectId: first.projectId,
      position: ProjectArtifactPlacementPosition.Root,
    },
    rankOrders,
    restoreState: storedBeforeState,
  });
}

async function runCallerPlacementValidator(
  tx: TransactionClient,
  params: ApplyProjectArtifactPlacementInTransactionParams,
  plan: PlacementPlan
): Promise<PlacementError | null> {
  if (
    params.input.kind !== ProjectArtifactPlacementKind.Place ||
    !params.validatePlacement
  ) {
    return null;
  }
  return await params.validatePlacement({
    tx,
    routeProjectId: params.routeProjectId,
    organizationId: params.organizationId,
    input: params.input,
    sourceArtifactIds: plan.sourceArtifactIds,
    movedArtifactIds: plan.movedArtifactIds,
    destinationParentId: plan.destinationParentId,
    affectedProjectIds: plan.affectedProjectIds,
  });
}

type PlacementRootFieldChange = {
  before: PlacementRootFieldSnapshot[];
  after: PlacementRootFieldSnapshot[];
};

async function preparePlacementRootFields(
  tx: TransactionClient,
  organizationId: string,
  input: ProjectArtifactPlacementRequest,
  actor: PlacementActor,
  sourceArtifactIds: string[],
  undo: UndoReceipt | null,
  includeAllTypes = false
): Promise<Result<PlacementRootFieldChange | null, PlacementError>> {
  if (input.kind === ProjectArtifactPlacementKind.Place && !input.rootUpdates) {
    return Result.ok(null);
  }
  if (
    input.kind === ProjectArtifactPlacementKind.Undo &&
    !undo?.beforeState.rootFields
  ) {
    return Result.ok(null);
  }
  const before = await readPlacementRootFields(
    tx,
    organizationId,
    sourceArtifactIds,
    includeAllTypes
  );
  const after =
    input.kind === ProjectArtifactPlacementKind.Place
      ? placementRootFieldsAfter(before, input.rootUpdates ?? {})
      : (undo?.beforeState.rootFields ?? []);
  if (
    input.kind === ProjectArtifactPlacementKind.Undo &&
    JSON.stringify(before) !== JSON.stringify(undo?.afterState.rootFields)
  ) {
    return placementFailure(
      Status.Conflict,
      "The affected artifact fields changed after this placement",
      ProjectArtifactPlacementErrorReason.StaleVersion
    );
  }
  const validationError = await validatePlacementRootFields(
    tx,
    organizationId,
    sourceArtifactIds,
    before,
    after,
    actor.tagPermissions,
    includeAllTypes
  );
  return validationError
    ? Result.err(validationError)
    : Result.ok({ before, after });
}

export const projectArtifactPlacementService = {
  getProjectPlacementState,
  getProjectPlacementStateInCurrentTransaction,
  placeProjectArtifacts,
};

export type { PlacementPlan } from "@/app/documents/project-artifact-placement-persistence";
export type { PlacementActor } from "@/app/documents/project-artifact-placement-service-support";

function buildParentProjections(
  state: PlacementState,
  artifactIds: string[],
  desiredParentIds: ReadonlyMap<string, string | null>,
  desiredProjectIds: ReadonlyMap<string, string>
): PlacementPlan["parentProjections"] {
  const projections = new Map<string, PlacementParentProjection[]>();
  for (const artifactId of artifactIds) {
    const desiredParentId = desiredParentIds.get(artifactId) ?? null;
    const desiredProjectId = desiredProjectIds.get(artifactId);
    const currentParentId =
      state.canonicalParents.get(artifactId)?.parentId ?? null;
    const currentProjectId = state.artifactsById.get(artifactId)?.projectId;
    if (
      currentParentId === desiredParentId &&
      currentProjectId === desiredProjectId
    ) {
      projections.set(artifactId, []);
      continue;
    }
    const finalParentIds = new Set(
      state.incomingProduces.get(artifactId) ?? []
    );
    if (currentParentId !== desiredParentId && currentParentId) {
      finalParentIds.delete(currentParentId);
    }
    if (desiredParentId) {
      finalParentIds.add(desiredParentId);
    }
    const sameProject = [...finalParentIds].filter(
      (parentId) =>
        desiredProjectId &&
        (desiredProjectIds.get(parentId) ??
          state.parentProjectIds.get(parentId)) === desiredProjectId
    );
    projections.set(
      artifactId,
      sameProject.map((parentId) => ({
        parentId,
        canonical: parentId === desiredParentId,
        suppressed: desiredParentId === null,
      }))
    );
  }
  return projections;
}

/**
 * `recordPlaced` runs on the placement's transaction after a placement that
 * was not a replay, so a receipt that cannot be stored rolls the placement
 * back (ISS-12552).
 */
type PlaceProjectArtifactsOptions = Pick<
  ApplyProjectArtifactPlacementInTransactionParams,
  "includeAllTypes" | "rootInsertion" | "rootParentArtifactId" | "requestHash"
> & {
  recordPlaced?: RecordWriteInTransaction<ProjectArtifactPlacementResponse>;
};

/** The flag-off revision fence applies unless the caller opts out of it. */
function placementFieldRevisions(
  params: Pick<
    ApplyProjectArtifactPlacementInTransactionParams,
    "fieldRevisions" | "includeAllTypes"
  >
): boolean | undefined {
  return params.fieldRevisions ?? params.includeAllTypes;
}

/**
 * The unchanged-placement short-circuit belongs to the flag-off hierarchy
 * adapter. A board lane move writes its field after placement, so it always
 * keeps a receipt and its Undo even when the rank does not move.
 */
function mayShortCircuitUnchangedPlacement(
  includeAllTypes: boolean | undefined,
  input: ProjectArtifactPlacementRequest
) {
  return Boolean(
    includeAllTypes &&
      input.kind === ProjectArtifactPlacementKind.Place &&
      !input.lanePatch
  );
}
