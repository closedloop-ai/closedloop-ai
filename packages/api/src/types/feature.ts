import type { Priority } from "./common";
import type { CustomFieldValueDetail } from "./custom-field";
import type { BasicUser } from "./user";

// Feature Status
export const FeatureStatus = {
  Draft: "DRAFT",
  InProgress: "IN_PROGRESS",
  InReview: "IN_REVIEW",
  Approved: "APPROVED",
  Executed: "EXECUTED",
  Done: "DONE",
  Obsolete: "OBSOLETE",
} as const;
export type FeatureStatus = (typeof FeatureStatus)[keyof typeof FeatureStatus];
export const FEATURE_STATUS_OPTIONS = Object.values(FeatureStatus);

export type Feature = {
  id: string;
  organizationId: string;
  workstreamId: string | null;
  projectId: string;
  title: string;
  slug: string;
  description: string | null;
  status: FeatureStatus;
  priority: Priority;
  assigneeId: string | null;
  assignee: BasicUser | null;
  createdById: string;
  createdBy: BasicUser | null;
  createdAt: Date;
  updatedAt: Date;
};

export type FeatureWithWorkstream = Feature & {
  workstream?: {
    id: string;
    title: string;
    state: string;
  } | null;
  project: {
    id: string;
    name: string;
    teams: { id: string; name: string }[];
  } | null;
  /** Custom field values attached to this feature. Omitted when not requested. */
  customFields?: CustomFieldValueDetail[];
};

export type FindFeaturesOptions = {
  workstreamId?: string;
  projectId?: string;
  status?: FeatureStatus;
  priority?: Priority;
  assigneeId?: string;
};

export type CreateFeatureInput = {
  workstreamId?: string;
  projectId: string;
  title: string;
  description?: string;
  status?: FeatureStatus;
  priority?: Priority;
  assigneeId?: string;
};

export type UpdateFeatureInput = {
  id: string;
  title?: string;
  description?: string;
  status?: FeatureStatus;
  priority?: Priority;
  assigneeId?: string | null;
  projectId?: string;
};
