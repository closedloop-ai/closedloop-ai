import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import { EntityType } from "@repo/api/src/types/entity-link";
import { z } from "zod";

const artifactStatusEnum = z.enum(ArtifactStatus);
const artifactTypeEnum = z.enum(ArtifactType);
const entityTypeEnum = z.enum(EntityType);

// Validate owner/repo format (e.g., "closedloop/astoria-service")
const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;

export const createArtifactValidator = z.object({
  workstreamId: z.uuid().optional(),
  projectId: z.uuid(),
  sourceId: z.uuid().optional(),
  sourceType: entityTypeEnum.optional(),
  sourceVersion: z.number().int().positive().optional(),
  type: artifactTypeEnum,
  title: z.string().min(1, "Title is required"),
  fileName: z.string().optional(),
  approverId: z.uuid().nullable().optional(),
  status: artifactStatusEnum.optional(),
  content: z.string(),
  targetRepo: z
    .string()
    .regex(OWNER_REPO_REGEX, "Must be owner/repo format")
    .optional(),
  targetBranch: z.string().optional(),
  assigneeId: z.uuid().nullable().optional(),
});

export const updateArtifactValidator = z.object({
  title: z.string().min(1).optional(),
  fileName: z.string().optional(),
  approverId: z.uuid().nullable().optional(),
  status: artifactStatusEnum.optional(),
  targetRepo: z
    .string()
    .regex(OWNER_REPO_REGEX, "Must be owner/repo format")
    .nullable()
    .optional(),
  targetBranch: z.string().nullable().optional(),
  projectId: z.uuid().optional(),
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

export const findArtifactsQueryValidator = z.object({
  type: artifactTypeEnum.optional(),
  workstreamId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  assigneeId: z.uuid().optional(),
});

export const reorderArtifactsValidator = z.object({
  artifactIds: z.array(z.uuid()),
});

export const batchMoveArtifactsValidator = z.object({
  artifactIds: z.array(z.uuid()).min(1, "At least one artifact ID required"),
  targetProjectId: z.uuid(),
});

export const mergeArtifactsValidator = z
  .object({
    primaryArtifactId: z.uuid(),
    secondaryArtifactId: z.uuid(),
  })
  .refine((data) => data.primaryArtifactId !== data.secondaryArtifactId, {
    message: "Primary and secondary artifact IDs must be different",
    path: ["secondaryArtifactId"],
  });

export const batchCreateArtifactsValidator = z.object({
  items: z
    .array(createArtifactValidator)
    .min(1, "At least one artifact required")
    .max(50, "Maximum 50 artifacts per batch"),
});
