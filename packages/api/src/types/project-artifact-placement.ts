import { z } from "zod";
import { ArtifactStatusEditSurface } from "./artifact-status-contract.ts";
import { Priority } from "./common.ts";
import {
  type ArtifactStatus,
  DocumentStatus,
  IssueStatus,
} from "./document.ts";
import { postgresStorableTextSchema } from "./postgres-text.ts";

export const ProjectArtifactPlacementKind = {
  Place: "place",
  Undo: "undo",
} as const;
export type ProjectArtifactPlacementKind =
  (typeof ProjectArtifactPlacementKind)[keyof typeof ProjectArtifactPlacementKind];

export const ProjectArtifactPlacementPosition = {
  Before: "before",
  After: "after",
  Inside: "inside",
  Root: "root",
} as const;
export type ProjectArtifactPlacementPosition =
  (typeof ProjectArtifactPlacementPosition)[keyof typeof ProjectArtifactPlacementPosition];

export const ProjectArtifactPlacementSource = {
  Pointer: "pointer",
  Keyboard: "keyboard",
  Undo: "undo",
  Api: "api",
} as const;
export type ProjectArtifactPlacementSource =
  (typeof ProjectArtifactPlacementSource)[keyof typeof ProjectArtifactPlacementSource];

export const ProjectArtifactPlacementErrorReason = {
  InvalidRequest: "invalid_request",
  ArtifactNotFound: "artifact_not_found",
  TargetNotFound: "target_not_found",
  PermissionDenied: "permission_denied",
  Cycle: "cycle",
  MaxDepth: "max_depth",
  StaleVersion: "stale_version",
  IdempotencyMismatch: "idempotency_mismatch",
  UnsupportedPeer: "unsupported_peer",
  ExpandedArtifactLimit: "expanded_artifact_limit",
  PolicyChanged: "policy_changed",
  UnsupportedTransition: "unsupported_transition",
  WipLimitReached: "wip_limit_reached",
} as const;
export type ProjectArtifactPlacementErrorReason =
  (typeof ProjectArtifactPlacementErrorReason)[keyof typeof ProjectArtifactPlacementErrorReason];

export const PROJECT_ARTIFACT_PLACEMENT_MAX_SOURCES = 1000;
export const PROJECT_ARTIFACT_PLACEMENT_MAX_EXPANDED_ARTIFACTS = 5000;

export const ProjectArtifactPlacementGroupField = {
  AssigneeId: "assigneeId",
  Priority: "priority",
  Status: "status",
} as const;
export type ProjectArtifactPlacementGroupField =
  (typeof ProjectArtifactPlacementGroupField)[keyof typeof ProjectArtifactPlacementGroupField];

export type ProjectArtifactPlacementLanePatch = {
  field: ProjectArtifactPlacementGroupField;
  value: string | null;
  expectedPolicyRevision?: string;
  /** Status targets keyed by every selected root when a shared lane spans raw statuses. */
  valuesByRootId?: Record<string, string>;
};

export type PlaceProjectArtifactsRequest = {
  kind: typeof ProjectArtifactPlacementKind.Place;
  sourceArtifactIds: string[];
  destinationProjectId: string;
  position: ProjectArtifactPlacementPosition;
  targetArtifactId?: string;
  rootUpdates?: ProjectArtifactPlacementRootUpdates;
  lanePatch?: ProjectArtifactPlacementLanePatch;
  surface?: typeof ArtifactStatusEditSurface.Board;
  expectedProjectVersions: Record<string, string>;
  idempotencyKey: string;
  source: Exclude<
    ProjectArtifactPlacementSource,
    typeof ProjectArtifactPlacementSource.Undo
  >;
};

export type ProjectArtifactPlacementIntent = Omit<
  PlaceProjectArtifactsRequest,
  "expectedProjectVersions" | "idempotencyKey" | "kind"
>;

export type ProjectArtifactPlacementRootUpdates = {
  status?: ArtifactStatus;
  assigneeId?: string | null;
  priority?: Priority | null;
  tagIds?: string[];
};

export type UndoProjectArtifactPlacementRequest = {
  kind: typeof ProjectArtifactPlacementKind.Undo;
  undoOfTransactionId: string;
  expectedProjectVersions: Record<string, string>;
  idempotencyKey: string;
  source: typeof ProjectArtifactPlacementSource.Undo;
};

export type ProjectArtifactPlacementRequest =
  | PlaceProjectArtifactsRequest
  | UndoProjectArtifactPlacementRequest;

export type CommittedProjectArtifactPlacement = {
  sourceArtifactIds: string[];
  destinationProjectId: string;
  position: ProjectArtifactPlacementPosition;
  targetArtifactId?: string;
};

export type ProjectArtifactPlacementSourceRoot = {
  sourceArtifactId: string;
  rootArtifactId: string;
};

export type ProjectArtifactPlacementResponse = {
  placed: true;
  /** Desktop accepted the change locally and still owes cloud reconciliation. */
  transactionId: string;
  affectedArtifactIds: string[];
  affectedProjectIds: string[];
  /** Number of descendants moved with the independent selected roots. */
  descendantCount?: number;
  projectVersions: Record<string, string>;
  placement: CommittedProjectArtifactPlacement;
  /** Authoritative pre-normalization source-to-root lineage for receipt validation. */
  sourceRootMappings?: ProjectArtifactPlacementSourceRoot[];
  replayed: boolean;
  undoAvailable: boolean;
};

export type ProjectArtifactPlacementStateResponse = {
  projectId: string;
  projectVersion: string;
  /** Authoritative write capability when the server can evaluate this caller. */
  canPlaceArtifacts?: boolean;
};

export const ProjectArtifactPlacementVerificationStatus = {
  Consistent: "consistent",
  Drifted: "drifted",
} as const;
export type ProjectArtifactPlacementVerificationStatus =
  (typeof ProjectArtifactPlacementVerificationStatus)[keyof typeof ProjectArtifactPlacementVerificationStatus];

export type ProjectArtifactPlacementVerificationResponse = {
  transactionId: string;
  status: ProjectArtifactPlacementVerificationStatus;
  affectedProjectIds: string[];
  projectVersions: Record<string, string>;
  driftedArtifactIds: string[];
  canRecover: boolean;
};

export type RecoverProjectArtifactPlacementRequest = {
  expectedProjectVersions: Record<string, string>;
};

export const recoverProjectArtifactPlacementValidator = z
  .object({ expectedProjectVersions: z.record(z.uuid(), z.string().min(1)) })
  .strict() satisfies z.ZodType<RecoverProjectArtifactPlacementRequest>;

export type ProjectArtifactPlacementConflictDetail = {
  reason: ProjectArtifactPlacementErrorReason;
  actualProjectVersions?: Record<string, string>;
};

const committedPlacementSchema = z.object({
  sourceArtifactIds: z.array(z.uuid()).min(1),
  destinationProjectId: z.uuid(),
  position: z.enum(ProjectArtifactPlacementPosition),
  targetArtifactId: z.uuid().optional(),
});
const sourceRootMappingSchema = z.object({
  sourceArtifactId: z.uuid(),
  rootArtifactId: z.uuid(),
});

/** Runtime validator for a committed or Desktop-pending placement receipt. */
export const projectArtifactPlacementResponseValidator = z.object({
  placed: z.literal(true),
  transactionId: z.uuid(),
  affectedArtifactIds: z.array(z.uuid()).min(1),
  affectedProjectIds: z.array(z.uuid()).min(1),
  descendantCount: z.number().int().nonnegative().safe().optional(),
  projectVersions: z.record(z.uuid(), z.string().min(1).max(128)),
  placement: committedPlacementSchema,
  sourceRootMappings: z.array(sourceRootMappingSchema).min(1).optional(),
  replayed: z.boolean(),
  undoAvailable: z.boolean(),
}) satisfies z.ZodType<ProjectArtifactPlacementResponse>;

const expectedProjectVersionsSchema = z.record(
  z.uuid(),
  z.string().min(1).max(128)
);
const idempotencyKeySchema = postgresStorableTextSchema(
  z.string().min(1).max(255)
);
const placementPositionSchema = z.enum([
  ProjectArtifactPlacementPosition.Before,
  ProjectArtifactPlacementPosition.After,
  ProjectArtifactPlacementPosition.Inside,
  ProjectArtifactPlacementPosition.Root,
]);
const placementSourceSchema = z.enum([
  ProjectArtifactPlacementSource.Pointer,
  ProjectArtifactPlacementSource.Keyboard,
  ProjectArtifactPlacementSource.Api,
]);
const placementGroupFieldSchema = z.enum(ProjectArtifactPlacementGroupField);

const placeProjectArtifactsShape = {
  kind: z.literal(ProjectArtifactPlacementKind.Place),
  sourceArtifactIds: z
    .array(z.uuid())
    .min(1)
    .max(PROJECT_ARTIFACT_PLACEMENT_MAX_SOURCES),
  destinationProjectId: z.uuid(),
  position: placementPositionSchema,
  targetArtifactId: z.uuid().optional(),
  rootUpdates: z
    .object({
      status: z.union([z.enum(DocumentStatus), z.enum(IssueStatus)]).optional(),
      assigneeId: z.uuid().nullable().optional(),
      priority: z.enum(Priority).nullable().optional(),
      tagIds: z
        .array(z.uuid())
        .max(PROJECT_ARTIFACT_PLACEMENT_MAX_SOURCES)
        .refine((ids) => new Set(ids).size === ids.length)
        .optional(),
    })
    .strict()
    .optional(),
  lanePatch: z
    .object({
      expectedPolicyRevision: z.string().min(1).max(128).optional(),
      field: placementGroupFieldSchema,
      value: z.string().nullable(),
      valuesByRootId: z
        .record(
          z.uuid(),
          z.union([z.enum(DocumentStatus), z.enum(IssueStatus)])
        )
        .optional(),
    })
    .strict()
    .optional(),
  surface: z.literal(ArtifactStatusEditSurface.Board).optional(),
  expectedProjectVersions: expectedProjectVersionsSchema,
  idempotencyKey: idempotencyKeySchema,
  source: placementSourceSchema,
} satisfies Record<keyof PlaceProjectArtifactsRequest, z.ZodTypeAny>;

const undoProjectArtifactPlacementShape = {
  kind: z.literal(ProjectArtifactPlacementKind.Undo),
  undoOfTransactionId: z.uuid(),
  expectedProjectVersions: expectedProjectVersionsSchema,
  idempotencyKey: idempotencyKeySchema,
  source: z.literal(ProjectArtifactPlacementSource.Undo),
} satisfies Record<keyof UndoProjectArtifactPlacementRequest, z.ZodTypeAny>;

const placeProjectArtifactsValidator = z
  .object(placeProjectArtifactsShape)
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.sourceArtifactIds).size !== value.sourceArtifactIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "sourceArtifactIds must not contain duplicate ids",
        path: ["sourceArtifactIds"],
      });
    }
    const valuesByRootId = value.lanePatch?.valuesByRootId;
    if (
      valuesByRootId &&
      (value.lanePatch?.field !== ProjectArtifactPlacementGroupField.Status ||
        Object.keys(valuesByRootId).length !== value.sourceArtifactIds.length ||
        value.sourceArtifactIds.some(
          (id) => !Object.hasOwn(valuesByRootId, id)
        ))
    ) {
      context.addIssue({
        code: "custom",
        message: "valuesByRootId must cover exactly the selected status roots",
        path: ["lanePatch", "valuesByRootId"],
      });
    }
    const targetRequired =
      value.position !== ProjectArtifactPlacementPosition.Root;
    if (targetRequired && value.targetArtifactId === undefined) {
      context.addIssue({
        code: "custom",
        message: `targetArtifactId is required for ${value.position}`,
        path: ["targetArtifactId"],
      });
    }
    if (
      value.position === ProjectArtifactPlacementPosition.Root &&
      value.targetArtifactId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "targetArtifactId must be omitted for root placement",
        path: ["targetArtifactId"],
      });
    }
  });

const undoProjectArtifactPlacementValidator = z
  .object(undoProjectArtifactPlacementShape)
  .strict();

/** Strict wire validator for atomic manual hierarchy placement and undo. */
export const projectArtifactPlacementValidator = z.discriminatedUnion("kind", [
  placeProjectArtifactsValidator,
  undoProjectArtifactPlacementValidator,
]);
