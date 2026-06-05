import type { ArtifactStatus, ArtifactType } from "./artifact";
import type { Priority } from "./common";
import type { FeatureStatus } from "./feature";
import type { ProjectStatus } from "./project";
import type { BasicUser } from "./user";
import type { WorkstreamState } from "./workstream";

export type ArtifactSearchResult = {
  id: string;
  title: string;
  slug: string;
  type: ArtifactType;
  status: ArtifactStatus;
  projectName: string | null;
  workstreamTitle: string | null;
  assignee: BasicUser | null;
  updatedAt: Date;
};

export type FeatureSearchResult = {
  id: string;
  title: string;
  slug: string;
  status: FeatureStatus;
  priority: Priority;
  projectName: string | null;
  workstreamTitle: string | null;
  assignee: BasicUser | null;
  updatedAt: Date;
};

export type WorkstreamSearchResult = {
  id: string;
  title: string;
  slug: string | null;
  state: WorkstreamState;
  projectName: string | null;
  updatedAt: Date;
};

export type ProjectSearchResult = {
  id: string;
  name: string;
  slug: string | null;
  status: ProjectStatus;
  priority: Priority;
  teamName: string | null;
  teamId: string | null;
  assignee: BasicUser | null;
  updatedAt: Date;
};

export type GlobalSearchResponse = {
  query: string;
  artifacts: ArtifactSearchResult[];
  features: FeatureSearchResult[];
  workstreams: WorkstreamSearchResult[];
  projects: ProjectSearchResult[];
};
