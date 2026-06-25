import type { Priority } from "./common";
import type { DocumentStatus, DocumentType } from "./document";
import type { ProjectStatus } from "./project";
import type { BasicUser } from "./user";

export type DocumentSearchResult = {
  id: string;
  title: string;
  slug: string;
  type: DocumentType;
  status: DocumentStatus;
  priority: Priority | null;
  projectName: string | null;
  assignee: BasicUser | null;
  updatedAt: Date;
};

export type ProjectSearchResult = {
  id: string;
  name: string;
  slug: string | null;
  status: ProjectStatus;
  priority: Priority | null;
  teamName: string | null;
  teamId: string | null;
  assignee: BasicUser | null;
  updatedAt: Date;
};

export type GlobalSearchResponse = {
  query: string;
  documents: DocumentSearchResult[];
  projects: ProjectSearchResult[];
  /** Present when the search was scoped to a specific tag. */
  tagId?: string;
  tagName?: string;
};
