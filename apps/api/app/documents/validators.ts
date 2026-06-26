import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { MAX_ADDITIONAL_REPOS } from "@repo/api/src/types/loop";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";
import {
  repoBranchSchema,
  repoFullNameSchema,
} from "@/lib/repo-validator-helpers";

const documentStatusEnum = z.enum(DocumentStatus);
const documentTypeEnum = z.enum(DocumentType);
const priorityEnum = z.enum(Priority);

// Document repos differ from Loop repos in one place: branch is
// `nullable().optional()` here (projects don't pin branches by default) vs.
// required for Loops. The shared helpers cover regex and length so both
// surfaces validate the same shape.
const documentRepoEntrySchema = z.object({
  fullName: repoFullNameSchema,
  branch: repoBranchSchema.nullable().optional(),
});

const repositorySelectionInputSchema = z.object({
  primary: documentRepoEntrySchema,
  additional: z
    .array(documentRepoEntrySchema)
    .max(MAX_ADDITIONAL_REPOS)
    .optional(),
});

export const createDocumentValidator = z
  .object({
    projectId: uuidOrSlug(),
    sourceId: uuidOrSlug().optional(),
    type: documentTypeEnum,
    title: z.string().min(1, "Title is required"),
    fileName: z.string().optional(),
    approverId: z.uuid().nullable().optional(),
    status: documentStatusEnum.optional(),
    priority: priorityEnum.optional(),
    content: z.string(),
    assigneeId: z.uuid().nullable().optional(),
    repositorySelection: repositorySelectionInputSchema.optional(),
  })
  .strict();

export const updateDocumentValidator = z
  .object({
    title: z.string().min(1).optional(),
    fileName: z.string().optional(),
    approverId: z.uuid().nullable().optional(),
    status: documentStatusEnum.optional(),
    priority: priorityEnum.optional(),
    projectId: uuidOrSlug().optional(),
    assigneeId: z.uuid().nullable().optional(),
    sortOrder: z.number().nullable().optional(),
    customFields: z
      .record(
        z.uuid(),
        z.union([
          z.string().max(10_000),
          z.number(),
          z.array(z.uuid()).max(100),
          z.null(),
        ])
      )
      .optional(),
  })
  .strict();

export const newVersionValidator = z.object({
  content: z.string(),
});

export const findDocumentsQueryValidator = z.object({
  type: documentTypeEnum.optional(),
  projectId: uuidOrSlug().optional(),
  assigneeId: z.uuid().optional(),
});

export const batchMoveDocumentsValidator = z.object({
  documentIds: z.array(z.uuid()).min(1, "At least one document ID required"),
  targetProjectId: z.uuid(),
});

export const mergeDocumentsValidator = z
  .object({
    primaryDocumentId: z.uuid(),
    secondaryDocumentId: z.uuid(),
  })
  .refine((data) => data.primaryDocumentId !== data.secondaryDocumentId, {
    message: "Primary and secondary document IDs must be different",
    path: ["secondaryDocumentId"],
  });

export const batchUpdateStatusValidator = z.object({
  documentIds: z
    .array(z.uuid())
    .min(1, "At least one document ID required")
    .max(500),
  status: documentStatusEnum,
});

export const batchDeleteValidator = z.object({
  documentIds: z
    .array(z.uuid())
    .min(1, "At least one document ID required")
    .max(500),
});

/**
 * Body schema for `POST /projects/:id/artifacts/move` (PRD-421 / PLN-755).
 * Discriminated union with `.strict()` on every branch so unknown fields are
 * rejected uniformly: `top` / `bottom` reject any extra key (notably
 * `referenceArtifactId`), and `before` / `after` require `referenceArtifactId`
 * while still rejecting anything else. Keeps callers honest at the API
 * boundary so the service never has to handle ambiguous inputs.
 */
export const moveArtifactValidator = z.discriminatedUnion("position", [
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.Top),
    })
    .strict(),
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.Bottom),
    })
    .strict(),
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.Before),
      referenceArtifactId: uuidOrSlug(),
    })
    .strict(),
  z
    .object({
      artifactId: uuidOrSlug(),
      position: z.literal(MovePosition.After),
      referenceArtifactId: uuidOrSlug(),
    })
    .strict(),
]);
