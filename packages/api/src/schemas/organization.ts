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
