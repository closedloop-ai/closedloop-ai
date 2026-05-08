import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";

const documentStatusEnum = z.enum(DocumentStatus);
const documentTypeEnum = z.enum(DocumentType);
const priorityEnum = z.enum(Priority);

// Validate owner/repo format (e.g., "closedloop/astoria-service")
const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;

export const createDocumentValidator = z.object({
  workstreamId: uuidOrSlug().optional(),
  projectId: uuidOrSlug(),
  sourceId: uuidOrSlug().optional(),
  type: documentTypeEnum,
  title: z.string().min(1, "Title is required"),
  fileName: z.string().optional(),
  approverId: z.uuid().nullable().optional(),
  status: documentStatusEnum.optional(),
  priority: priorityEnum.optional(),
  content: z.string(),
  targetRepo: z
    .string()
    .regex(OWNER_REPO_REGEX, "Must be owner/repo format")
    .optional(),
  targetBranch: z.string().optional(),
  assigneeId: z.uuid().nullable().optional(),
});

export const updateDocumentValidator = z.object({
  title: z.string().min(1).optional(),
  fileName: z.string().optional(),
  approverId: z.uuid().nullable().optional(),
  status: documentStatusEnum.optional(),
  priority: priorityEnum.optional(),
  targetRepo: z
    .string()
    .regex(OWNER_REPO_REGEX, "Must be owner/repo format")
    .nullable()
    .optional(),
  targetBranch: z.string().nullable().optional(),
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
});

export const newVersionValidator = z.object({
  content: z.string(),
});

export const findDocumentsQueryValidator = z.object({
  type: documentTypeEnum.optional(),
  workstreamId: uuidOrSlug().optional(),
  projectId: uuidOrSlug().optional(),
  assigneeId: z.uuid().optional(),
});

export const reorderDocumentsValidator = z.object({
  documentIds: z.array(z.uuid()),
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
