import { ProjectStatus } from "@repo/api/src/types/project";

export const PROJECT_DETAIL_TEST_PROJECT = {
  assignee: null,
  assigneeId: null,
  description: "",
  id: "project-1",
  name: "Apollo",
  priority: null,
  status: ProjectStatus.InProgress,
  targetDate: null,
  teams: [{ id: "team-1", name: "Platform" }],
};

export const PROJECT_DETAIL_TEST_TEAM = {
  id: "team-1",
  name: "Platform",
};
