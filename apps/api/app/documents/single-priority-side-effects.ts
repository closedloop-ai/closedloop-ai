import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { AuditAction } from "@repo/api/src/types/audit";
import type { Priority } from "@repo/api/src/types/common";
import {
  ArtifactPriorityCommitResult,
  type ArtifactPriorityEditSurface,
} from "@repo/api/src/types/priority-contract";
import { Status, type StatusCode } from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { ArtifactType, type TransactionClient } from "@repo/database";
import { dispatchSingleArtifactMutationAudits } from "@/app/audit/single-artifact-mutation-audit";
import { searchIndexService } from "@/app/search/search-index-service";
import {
  type ActivityActor,
  captureBatchPriorityChange,
} from "@/lib/artifact-activity-capture";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";
import { captureArtifactPriorityChangeAnalytics } from "@/lib/artifact-priority-analytics";
import { ArtifactActivityCaptureStage } from "@/lib/observability/artifact-activity-capture-telemetry";
import type { UpdateArtifactPrioritySuccess } from "./artifact-bulk-priority-service";

/** The two artifact kinds with a single-artifact priority route of their own. */
export type SinglePriorityArtifactType =
  | typeof ArtifactType.SESSION
  | typeof ArtifactType.BRANCH;

export type SinglePrioritySideEffectInput = {
  user: { id: string; organizationId: string };
  authMethod: ActivityActor["authMethod"];
  artifactId: string;
  artifactType: SinglePriorityArtifactType;
  /** `null` when the write cleared the priority. */
  priority: Priority | null;
  /**
   * Where the edit was made from, when the body named a surface this route
   * accepts. Absent for an older client and for an API-key caller, which is
   * unattributed by contract (ISS-9443).
   */
  surface?: ArtifactPriorityEditSurface;
  written: UpdateArtifactPrioritySuccess;
};

/**
 * The activity receipt for a single session or branch priority write, recorded
 * INSIDE that write's transaction (ISS-10993). Keyed off the `changed` /
 * `beforePriority` pair read under the writer's own lock, so a no-op re-apply
 * records nothing.
 *
 * It goes through the BULK capture: one artifact is a one-row batch, and a
 * single-artifact function of its own would be a second shape for the same
 * receipt.
 */
export async function captureSinglePriorityActivity(
  tx: TransactionClient,
  input: SinglePrioritySideEffectInput
): Promise<void> {
  if (!input.written.changed) {
    return;
  }
  await captureBatchPriorityChange({
    tx,
    organizationId: input.user.organizationId,
    actor: { userId: input.user.id, authMethod: input.authMethod },
    provenance: singlePriorityAnalyticsContext(input).provenance,
    changes: [
      {
        artifactId: input.artifactId,
        before: input.written.beforePriority,
        after: input.priority,
      },
    ],
    stage: ArtifactActivityCaptureStage.SingleUpdate,
  });
}

/**
 * Everything a single session or branch priority write emits AFTER it commits
 * (ISS-10332 / PLN-2086 Milestone 2): the search-projection refresh, so
 * `:priority` answers with the value the grid just wrote; the ISS-10681 audit
 * event; and the ISS-9443 analytics event, one per commit, attributed
 * only when the body named a surface and the caller is not an API key.
 *
 * The activity receipt is NOT emitted here — it commits with the write, in
 * {@link captureSinglePriorityActivity}.
 */
export function emitSinglePrioritySideEffects(
  input: SinglePrioritySideEffectInput
): void {
  singlePriorityAnalyticsContext(input).capture({
    field: ArtifactFieldEditField.Priority,
    result: input.written.changed
      ? ArtifactFieldEditOutcome.Committed
      : ArtifactFieldEditOutcome.NoChange,
    before: input.written.beforePriority,
    after: input.priority,
    artifactCount: 1,
  });
  if (!input.written.changed) {
    return;
  }
  dispatchSingleArtifactMutationAudits({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    changes: [
      {
        action: AuditAction.DocumentPriorityChanged,
        objectId: input.artifactId,
        before: input.written.beforePriority,
        after: input.priority,
      },
    ],
  });
  // Guarded separately from the telemetry below: one shared `try` would let
  // either emission's failure silently cost the other. The activity receipt is
  // NOT here — it commits with the write, in
  // {@link captureSinglePriorityActivity}.
  try {
    searchIndexService.updatePriorityAfterCommit(
      {
        organizationId: input.user.organizationId,
        entityType: SEARCH_ENTITY_TYPE_BY_ARTIFACT_TYPE[input.artifactType],
        entityId: input.artifactId,
      },
      input.priority
    );
  } catch {
    // Swallowed by design: a projection refresh must never fail the write.
  }
  // ISS-9443: the shipped `artifact_priority_changed` event, restored after
  // #8967 removed it without a ruling (PRD-722 AC6).
  if (input.surface === undefined || input.authMethod === "api_key") {
    return;
  }
  try {
    captureArtifactPriorityChangeAnalytics({
      organizationId: input.user.organizationId,
      userId: input.user.id,
      surface: input.surface,
      result: ArtifactPriorityCommitResult.Committed,
      from: input.written.beforePriority,
      to: input.priority,
      artifactCount: 1,
    });
  } catch {
    // Swallowed by design: telemetry must never fail the write.
  }
}

/** Emit a bounded validation/conflict result for a refused priority write. */
export function emitSinglePriorityRefusalAnalytics(
  input: Omit<SinglePrioritySideEffectInput, "written">,
  status: StatusCode
): void {
  const result =
    status === Status.Conflict
      ? ArtifactFieldEditOutcome.Conflict
      : ArtifactFieldEditOutcome.ValidationFailed;
  if (status !== Status.Conflict && status !== Status.BadRequest) {
    return;
  }
  singlePriorityAnalyticsContext(input).capture({
    field: ArtifactFieldEditField.Priority,
    result,
    after: input.priority,
    artifactCount: 1,
  });
}

function singlePriorityAnalyticsContext(
  input: Omit<SinglePrioritySideEffectInput, "written">
) {
  return createArtifactFieldEditAnalyticsContext({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    authMethod: input.authMethod,
    surface: input.surface,
  });
}

/**
 * Which projection row a single priority write refreshes. Exhaustive over the
 * two routed kinds, so a third single-priority route fails `tsc` here until it
 * names its projection.
 */
const SEARCH_ENTITY_TYPE_BY_ARTIFACT_TYPE: Readonly<
  Record<SinglePriorityArtifactType, SearchEntityType>
> = {
  [ArtifactType.SESSION]: SearchEntityType.AgentSession,
  [ArtifactType.BRANCH]: SearchEntityType.Branch,
};
