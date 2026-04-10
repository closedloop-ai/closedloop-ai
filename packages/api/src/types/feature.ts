import type { Priority } from "./common";
import type { CustomFieldValueDetail } from "./custom-field";
import type { BasicUser } from "./user";

// Feature Status — unified set used by UI dropdowns and display mappings
const FeatureStatusActive = {
  Draft: "DRAFT",
  InProgress: "IN_PROGRESS",
  InReview: "IN_REVIEW",
  Approved: "APPROVED",
  Executed: "EXECUTED",
  Done: "DONE",
  Obsolete: "OBSOLETE",
} as const;
// Deprecated values kept for Prisma type compatibility (data migrated away)
export const FeatureStatus = {
  ...FeatureStatusActive,
  /** @deprecated Migrated to DRAFT */
  NotStarted: "NOT_STARTED",
  /** @deprecated Migrated to DONE */
  Completed: "COMPLETED",
} as const;
export type FeatureStatus = (typeof FeatureStatus)[keyof typeof FeatureStatus];
/** Only active statuses — drives UI dropdowns */
export const FEATURE_STATUS_OPTIONS = Object.values(FeatureStatusActive);

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
