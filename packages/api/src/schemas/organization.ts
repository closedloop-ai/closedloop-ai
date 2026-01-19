import { z } from "zod";

// Organization schemas
export const createOrganizationSchema = z.object({
  name: z.string().min(1, "Name is required"),
  slug: z.string().min(1, "Slug is required"),
  anthropicApiKey: z.string().optional(),
});

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  anthropicApiKey: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

// Project schemas
export const createProjectSchema = z.object({
  organizationId: z.string().min(1, "organizationId is required"),
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

// User schemas
export const createUserSchema = z.object({
  organizationId: z.string().min(1, "organizationId is required"),
  email: z.string().email("Invalid email format"),
  name: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  role: z
    .enum(["PM", "DESIGNER", "TECH_LEAD", "ENGINEER", "STAKEHOLDER"])
    .optional(),
});

export const updateUserSchema = z.object({
  name: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  role: z
    .enum(["PM", "DESIGNER", "TECH_LEAD", "ENGINEER", "STAKEHOLDER"])
    .optional(),
  linearUserId: z.string().optional(),
  slackUserId: z.string().optional(),
  githubUsername: z.string().optional(),
});

// Workstream schemas
const workstreamTypeEnum = z.enum([
  "FEATURE_DELIVERY",
  "BUG_FIX",
  "TECH_DEBT",
  "SPIKE",
]);

const workstreamStateEnum = z.enum([
  "INITIATED",
  "REQUIREMENTS_GENERATING",
  "REQUIREMENTS_PENDING_APPROVAL",
  "DESIGN_IN_PROGRESS",
  "DESIGN_PENDING_APPROVAL",
  "IMPLEMENTATION_PLANNING",
  "IMPLEMENTATION_IN_PROGRESS",
  "IMPLEMENTATION_PENDING_REVIEW",
  "CODE_REVIEW_RUNNING",
  "CODE_REVIEW_PENDING_APPROVAL",
  "VISUAL_QA_RUNNING",
  "VISUAL_QA_PENDING_APPROVAL",
  "MERGING",
  "DEPLOYED",
  "COMPLETED",
  "BLOCKED",
  "CANCELLED",
]);

export const createWorkstreamSchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  type: workstreamTypeEnum.optional(),
  createdById: z.string().min(1, "createdById is required"),
  assignedToId: z.string().optional(),
  hasUIChanges: z.boolean().optional(),
});

export const updateWorkstreamSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  state: workstreamStateEnum.optional(),
  type: workstreamTypeEnum.optional(),
  assignedToId: z.string().nullable().optional(),
  hasUIChanges: z.boolean().optional(),
});

// Artifact schemas
const artifactTypeEnum = z.enum([
  "PRD",
  "FIGMA_DESIGN",
  "IMPLEMENTATION_PLAN",
  "CODE_REVIEW_REPORT",
  "VISUAL_QA_REPORT",
  "ACCESSIBILITY_REPORT",
  "TEST_REPORT",
  "COMPLETION_SUMMARY",
]);

const artifactStatusEnum = z.enum(["DRAFT", "REVIEW", "APPROVED", "ARCHIVED"]);

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
  // documentSlug groups related artifact versions together
  // Multiple documents of the same type can exist in one workstream
  documentSlug: z.string().optional(),
});

export const updateArtifactSchema = z.object({
  title: z.string().min(1).optional(),
  fileName: z.string().optional(),
  approver: z.string().nullable().optional(),
  status: artifactStatusEnum.optional(),
  content: z.string().optional(),
  externalUrl: z.string().url().nullable().optional(),
});
