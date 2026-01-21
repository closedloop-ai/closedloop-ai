import {
  ARTIFACT_STATUS_OPTIONS,
  ARTIFACT_TYPE_OPTIONS,
} from "@repo/api/src/types/artifact";
import { z } from "zod";

const artifactTypeEnum = z.enum(ARTIFACT_TYPE_OPTIONS);
const artifactStatusEnum = z.enum(ARTIFACT_STATUS_OPTIONS);

// Validate owner/repo format (e.g., "closedloop/astoria-service")
const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;

export const createArtifactSchema = z.object({
  workstreamId: z.string().optional(),
  projectId: z.string().optional(),
  type: artifactTypeEnum,
  title: z.string().min(1, "Title is required"),
  fileName: z.string().optional(),
  approver: z.string().optional(),
  status: artifactStatusEnum.optional(),
  content: z.string().optional(),
  externalUrl: z.string().url().optional(),
  generatedBy: z.string().optional(),
  documentSlug: z.string().optional(),
  targetRepo: z
    .string()
    .regex(OWNER_REPO_REGEX, "Must be owner/repo format")
    .optional(),
  targetBranch: z.string().optional(),
});

export const updateArtifactSchema = z.object({
  title: z.string().min(1).optional(),
  fileName: z.string().optional(),
  approver: z.string().nullable().optional(),
  status: artifactStatusEnum.optional(),
  content: z.string().optional(),
  externalUrl: z.string().url().nullable().optional(),
  targetRepo: z
    .string()
    .regex(OWNER_REPO_REGEX, "Must be owner/repo format")
    .nullable()
    .optional(),
  targetBranch: z.string().nullable().optional(),
});
