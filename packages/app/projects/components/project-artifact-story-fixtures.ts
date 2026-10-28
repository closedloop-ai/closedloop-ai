import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import type { DetailedArtifact } from "@repo/api/src/types/project-tree";
export const projectStoryNow = new Date("2026-10-19T12:00:00Z");
export const projectStoryProject: ProjectWithDetails = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-test",
  name: "Sprint",
  description: null,
  priority: null,
  status: ProjectStatus.InProgress,
  assigneeId: null,
  createdById: "user-test",
  slug: "PRO-1",
  targetDate: null,
  codebaseSummary: null,
  lastIndexedAt: null,
  settings: {},
  sortOrder: null,
  createdAt: projectStoryNow,
  updatedAt: projectStoryNow,
  completionPercentage: 67,
  teams: [],
};
export const projectStoryArtifact: DetailedArtifact = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: projectStoryProject.organizationId,
  projectId: projectStoryProject.id,
  type: ArtifactType.Document,
  subtype: ArtifactSubtype.Prd,
  name: "Delivery plan",
  slug: "PRD-1",
  status: DocumentStatus.Draft,
  priority: null,
  assigneeId: null,
  assignee: null,
  dueDate: null,
  externalUrl: null,
  sortOrder: null,
  createdById: "user-test",
  createdAt: projectStoryNow,
  updatedAt: projectStoryNow,
};
