import type { ProjectPriority } from "@repo/api/src/types/organization";

// Project types
export type ProjectOwner = {
  id: string;
  name: string;
  avatarUrl?: string;
  initials?: string;
};

export type ProjectTeam = {
  id: string;
  name: string;
};

export type ProjectRepository = {
  id: string;
  name: string;
  url?: string;
};

export type ProjectWithDetails = {
  id: string;
  name: string;
  description?: string;
  priority: ProjectPriority;
  owner?: ProjectOwner;
  targetDate?: string;
  status: number; // 0-100 percentage
  teams: ProjectTeam[];
  repositories?: ProjectRepository[];
  createdAt: string;
  updatedAt: string;
};
