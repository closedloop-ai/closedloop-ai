import {
  ARTIFACT_STATUS_OPTIONS,
  ARTIFACT_TYPE_OPTIONS,
} from "@repo/api/src/types/artifact";
import { z } from "zod";

const artifactTypeEnum = z.enum(ARTIFACT_TYPE_OPTIONS);
const artifactStatusEnum = z.enum(ARTIFACT_STATUS_OPTIONS);

// Validate owner/repo format (e.g., "closedloop/astoria-service")
const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;

export const createArtifactValidator = z
  .object({
    workstreamId: z.uuidv7().optional(),
    projectId: z.uuidv7().optional(),
    parentId: z.uuidv7().optional(),
    type: artifactTypeEnum,
    title: z.string().min(1, "Title is required"),
    fileName: z.string().optional(),
    approver: z.string().optional(),
    status: artifactStatusEnum.optional(),
    content: z.string().optional(),
    externalUrl: z.url().optional(),
    targetRepo: z
      .string()
      .regex(OWNER_REPO_REGEX, "Must be owner/repo format")
      .optional(),
    targetBranch: z.string().optional(),
  })
  .refine((data) => data.workstreamId || data.projectId, {
    message: "Either workstreamId or projectId is required",
  });

export const updateArtifactValidator = z.object({
  title: z.string().min(1).optional(),
  fileName: z.string().optional(),
  approver: z.string().nullable().optional(),
  status: artifactStatusEnum.optional(),
  externalUrl: z.url().nullable().optional(),
  targetRepo: z
    .string()
    .regex(OWNER_REPO_REGEX, "Must be owner/repo format")
    .nullable()
    .optional(),
  targetBranch: z.string().nullable().optional(),
});

export const newVersionValidator = z.object({
  content: z.string(),
});
