export const ApproverRole = {
  Pm: "PM",
  Designer: "DESIGNER",
  TechLead: "TECH_LEAD",
  Engineer: "ENGINEER",
  Stakeholder: "STAKEHOLDER",
} as const;
export type ApproverRole = (typeof ApproverRole)[keyof typeof ApproverRole];
export const APPROVER_ROLE_OPTIONS = Object.values(ApproverRole);

// User types
export type User = {
  id: string;
  clerkId: string;
  organizationId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  phoneNumber: string | null;
  role: ApproverRole;
  linearId: string | null;
  slackId: string | null;
  githubUsername: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type BasicUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

export type CreateUserInput = {
  clerkId: string;
  organizationId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  phoneNumber?: string | null;
  role?: ApproverRole;
};

export type UpdateUserInput = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  phoneNumber?: string | null;
  role?: ApproverRole;
  linearId?: string | null;
  slackId?: string | null;
  githubUsername?: string | null;
  active?: boolean;
};

export type UpdateUserProfileFromClerkInput = {
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  phoneNumber?: string | null;
};

import type { ArtifactType } from "./artifact";

/** Contribution count for a single day in the heatmap. */
export type ContributionDay = {
  date: string;
  count: number;
};

/** Artifact counts grouped by type. */
export type ArtifactsByType = {
  type: ArtifactType;
  count: number;
};

/** User profile statistics returned by GET /users/:id/stats. */
export type UserProfileStats = {
  /** Total artifacts created by this user. */
  totalArtifacts: number;
  /** Breakdown of artifacts by type. */
  artifactsByType: ArtifactsByType[];
  /** Total comments authored. */
  totalComments: number;
  /** Total PRs landed (merged). */
  totalPRsLanded: number;
  /** Total loops initiated. */
  totalLoops: number;
  /** Total workstreams created or assigned. */
  totalWorkstreams: number;
  /** Average concurrent running loops (when loops are active). */
  avgConcurrency: number;
  /** Daily contribution counts for the last 52 weeks (heatmap). */
  contributionHeatmap: ContributionDay[];
  /** Total input tokens consumed by this user's loops. */
  totalTokensInput: number;
  /** Total output tokens consumed by this user's loops. */
  totalTokensOutput: number;
  /** Total estimated cost of this user's loops (USD). */
  totalEstimatedCost: number;
};
