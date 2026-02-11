export const ActivityType = {
  ArtifactCreated: "ARTIFACT_CREATED",
  ArtifactUpdated: "ARTIFACT_UPDATED",
  StateChanged: "STATE_CHANGED",
  ApprovalRequested: "APPROVAL_REQUESTED",
  ApprovalGranted: "APPROVAL_GRANTED",
  ApprovalRejected: "APPROVAL_REJECTED",
  ProjectCreated: "PROJECT_CREATED",
  ProjectUpdated: "PROJECT_UPDATED",
} as const;
export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

export type ActivityItem = {
  id: string;
  type: ActivityType;
  actor?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  description: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
};

export type ActivityResponse = {
  activities: ActivityItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
};
