import { Priority } from "@repo/api/src/types/common";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { ProjectStatus } from "@repo/api/src/types/project";

export const makeProject = (
  overrides?: Partial<ProjectWithDetails>
): ProjectWithDetails => ({
  id: "project-1",
  organizationId: "org-1",
  name: "Test Project",
  description: null,
  priority: Priority.Medium,
  assigneeId: null,
  createdById: "user-1",
  slug: null,
  targetDate: null,
  codebaseSummary: null,
  lastIndexedAt: null,
  settings: {},
  sortOrder: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  status: ProjectStatus.InProgress,
  completionPercentage: 0,
  teams: [{ id: "team-1", name: "Team One" }],
  ...overrides,
});
