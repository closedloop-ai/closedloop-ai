import { z } from "zod";
import { ArtifactStatusEditSurface } from "./artifact-status-contract.ts";
import { Priority } from "./common.ts";
import { postgresStorableTextSchema } from "./postgres-text.ts";

export const ProjectHierarchyOperation = {
  Move: "move",
  Undo: "undo",
} as const;
export type ProjectHierarchyOperation =
  (typeof ProjectHierarchyOperation)[keyof typeof ProjectHierarchyOperation];
export const ProjectHierarchyPlacement = {
  Before: "before",
  Inside: "inside",
  After: "after",
  Start: "start",
  End: "end",
} as const;
export type ProjectHierarchyPlacement =
  (typeof ProjectHierarchyPlacement)[keyof typeof ProjectHierarchyPlacement];
export const ProjectHierarchySource = {
  Drag: "drag",
  Keyboard: "keyboard",
  Menu: "menu",
  Api: "api",
} as const;
export type ProjectHierarchySource =
  (typeof ProjectHierarchySource)[keyof typeof ProjectHierarchySource];

export type ProjectHierarchyRevision = { projectId: string; revision: string };
export type ProjectHierarchyRootUpdates = {
  status?: string;
  assigneeId?: string | null;
  priority?: Priority | null;
  tagIds?: string[];
};
export type ProjectHierarchyMoveRequest = {
  operation: typeof ProjectHierarchyOperation.Move;
  artifactIds: string[];
  targetProjectId?: string;
  placement: ProjectHierarchyPlacement;
  targetArtifactId?: string;
  parentArtifactId?: string | null;
  rootUpdates?: ProjectHierarchyRootUpdates;
  surface?: typeof ArtifactStatusEditSurface.Board;
  expectedRevisions: ProjectHierarchyRevision[];
  idempotencyKey: string;
  source: ProjectHierarchySource;
};
export type ProjectHierarchyUndoRequest = {
  operation: typeof ProjectHierarchyOperation.Undo;
  transactionId: string;
  expectedRevisions: ProjectHierarchyRevision[];
  idempotencyKey: string;
  source: ProjectHierarchySource;
};
export type ProjectHierarchyTransactionRequest =
  | ProjectHierarchyMoveRequest
  | ProjectHierarchyUndoRequest;
export type ProjectHierarchyTransactionResponse = {
  transactionId: string;
  changedArtifactIds: string[];
  descendantCount: number;
  projectRevisions: ProjectHierarchyRevision[];
  inverse: { transactionId: string };
  replayed: boolean;
};

export const PROJECT_HIERARCHY_MAX_SELECTED = 500;
export const PROJECT_HIERARCHY_MAX_LEVELS = 4;

const revisionSchema = z
  .object({ projectId: z.uuid(), revision: z.string().min(1).max(128) })
  .strict();
const common = {
  expectedRevisions: z
    .array(revisionSchema)
    .min(1)
    .max(2)
    .refine(
      (rows) => new Set(rows.map((row) => row.projectId)).size === rows.length
    ),
  idempotencyKey: z.uuid(),
  source: z.enum(ProjectHierarchySource),
};
const rootUpdatesSchema = z
  .object({
    status: postgresStorableTextSchema(
      z.string().trim().min(1).max(128)
    ).optional(),
    assigneeId: z.uuid().nullable().optional(),
    priority: z.enum(Priority).nullable().optional(),
    tagIds: z
      .array(z.uuid())
      .max(PROJECT_HIERARCHY_MAX_SELECTED)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .strict();
const moveSchema = z
  .object({
    ...common,
    operation: z.literal(ProjectHierarchyOperation.Move),
    artifactIds: z
      .array(z.uuid())
      .min(1)
      .max(PROJECT_HIERARCHY_MAX_SELECTED)
      .refine((ids) => new Set(ids).size === ids.length),
    targetProjectId: z.uuid().optional(),
    placement: z.enum(ProjectHierarchyPlacement),
    targetArtifactId: z.uuid().optional(),
    parentArtifactId: z.uuid().nullable().optional(),
    rootUpdates: rootUpdatesSchema.optional(),
    surface: z.literal(ArtifactStatusEditSurface.Board).optional(),
  })
  .strict();
const undoSchema = z
  .object({
    ...common,
    operation: z.literal(ProjectHierarchyOperation.Undo),
    transactionId: z.uuid(),
  })
  .strict();
export const projectHierarchyTransactionSchema: z.ZodType<ProjectHierarchyTransactionRequest> =
  z
    .discriminatedUnion("operation", [moveSchema, undoSchema])
    .superRefine((input, context) => {
      if (input.operation !== ProjectHierarchyOperation.Move) {
        return;
      }
      const relative =
        input.placement === ProjectHierarchyPlacement.Before ||
        input.placement === ProjectHierarchyPlacement.After ||
        input.placement === ProjectHierarchyPlacement.Inside;
      if (relative !== (input.targetArtifactId !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["targetArtifactId"],
          message:
            "Relative placement requires a target artifact; start/end omit it.",
        });
      }
      if (relative && input.parentArtifactId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["parentArtifactId"],
          message: "Relative placement derives its parent from the target.",
        });
      }
    });

export const projectHierarchyRevisionSchema: z.ZodType<ProjectHierarchyRevision> =
  revisionSchema;
export const projectHierarchyTransactionResponseSchema: z.ZodType<ProjectHierarchyTransactionResponse> =
  z.object({
    transactionId: z.uuid(),
    changedArtifactIds: z.array(z.uuid()),
    descendantCount: z.number().int().nonnegative().safe(),
    projectRevisions: z.array(revisionSchema),
    inverse: z.object({ transactionId: z.uuid() }),
    replayed: z.boolean(),
  });
