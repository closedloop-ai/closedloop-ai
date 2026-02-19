import {
  ARTIFACT_STATUS_OPTIONS,
  ARTIFACT_TYPE_OPTIONS,
} from "@repo/api/src/types/artifact";
import { ENTITY_TYPE_OPTIONS } from "@repo/api/src/types/entity-link";
import { z } from "zod";

const artifactStatusEnum = z.enum(ARTIFACT_STATUS_OPTIONS);
const artifactTypeEnum = z.enum(ARTIFACT_TYPE_OPTIONS);
const entityTypeEnum = z.enum(ENTITY_TYPE_OPTIONS);

// Validate owner/repo format (e.g., "closedloop/astoria-service")
const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;

export const createArtifactValidator = z
  .object({
    workstreamId: z.uuidv7().optional(),
    projectId: z.uuidv7().optional(),
    sourceId: z.uuidv7().optional(),
    sourceType: entityTypeEnum.optional(),
    sourceVersion: z.number().int().positive().optional(),
    type: artifactTypeEnum,
    title: z.string().min(1, "Title is required"),
    fileName: z.string().optional(),
    approverId: z.uuidv7().nullable().optional(),
    status: artifactStatusEnum.optional(),
    content: z.string(),
    targetRepo: z
      .string()
      .regex(OWNER_REPO_REGEX, "Must be owner/repo format")
      .optional(),
    targetBranch: z.string().optional(),
    ownerId: z.uuidv7().optional(),
  })
  .refine(
    (data) => data.type === "TEMPLATE" || data.workstreamId || data.projectId,
    {
      message:
        "Either workstreamId or projectId is required (except for templates)",
    }
  );

export const updateArtifactValidator = z.object({
  title: z.string().min(1).optional(),
  fileName: z.string().optional(),
  approverId: z.uuidv7().nullable().optional(),
  status: artifactStatusEnum.optional(),
  targetRepo: z
    .string()
    .regex(OWNER_REPO_REGEX, "Must be owner/repo format")
    .nullable()
    .optional(),
  targetBranch: z.string().nullable().optional(),
  projectId: z.uuidv7().nullable().optional(),
  ownerId: z.uuidv7().nullable().optional(),
  sortOrder: z.number().nullable().optional(),
});

export const newVersionValidator = z.object({
  content: z.string(),
});

export const findArtifactsQueryValidator = z.object({
  type: artifactTypeEnum.optional(),
  workstreamId: z.uuidv7().optional(),
  projectId: z.uuidv7().optional(),
  ownerId: z.uuidv7().optional(),
});

export const reorderArtifactsValidator = z.object({
  artifactIds: z.array(z.string().uuid()),
});

export const batchMoveArtifactsValidator = z.object({
  artifactIds: z
    .array(z.string().uuid())
    .min(1, "At least one artifact ID required"),
  targetProjectId: z.uuidv7(),
});

export const batchCreateArtifactsValidator = z.object({
  items: z
    .array(createArtifactValidator)
    .min(1, "At least one artifact required")
    .max(50, "Maximum 50 artifacts per batch"),
});
