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

import type { DocumentType } from "./document.js";

/** Contribution count for a single day in the heatmap. */
export type ContributionDay = {
  date: string;
  count: number;
};

/** Document counts grouped by type. */
export type DocumentsByType = {
  type: DocumentType;
  count: number;
};

/**
 * Range-scoped headline metrics for the user profile, returned by
 * GET /users/:id/stats/headline (FEA-4064).
 *
 * Every field here re-scopes to the profile-header range toggle's window
 * (30d / 90d / 1y), so this is the ONLY payload a range click re-fetches. It is
 * split apart from the fixed-window contribution heatmap widget
 * (`UserContributionHeatmap`) so the toggle never re-issues the trailing-year
 * heatmap SQL, and so a slow/failing heatmap read can never fail the ranged
 * headline response (widget independence per `packages/app/AGENTS.md`).
 *
 * Avg loop concurrency stays here (not with the heatmap) because a merged
 * correctness fix made it respect the selected window — it is a range-scoped
 * headline number, so it belongs with the headline and re-runs on toggle.
 */
export type UserProfileHeadline = {
  /** Total documents created by this user (in the selected window). */
  totalDocuments: number;
  /** Breakdown of documents by type (in the selected window). */
  documentsByType: DocumentsByType[];
  /** Total comments authored (in the selected window). */
  totalComments: number;
  /** Total PRs landed (merged in the selected window). */
  totalPRsLanded: number;
  /** Total loops initiated (in the selected window). */
  totalLoops: number;
  /** Average concurrent running loops over the selected window. */
  avgConcurrency: number;
  /** Total input tokens consumed by this user's loops (in the window). */
  totalTokensInput: number;
  /** Total output tokens consumed by this user's loops (in the window). */
  totalTokensOutput: number;
  /** Total estimated cost of this user's loops in the window (USD). */
  totalEstimatedCost: number;
};

/**
 * Fixed-window contribution heatmap widget, returned by
 * GET /users/:id/contributions (FEA-4064).
 *
 * A heatmap is a trailing-year grid by definition, so it is NOT re-scoped by
 * the profile range toggle. It loads independently of the headline query: the
 * range toggle never re-issues this SQL, and a failure here degrades to an
 * empty/error heatmap widget without blanking the headline numbers.
 */
export type UserContributionHeatmap = {
  /** Daily contribution counts for the last 52 weeks (heatmap). */
  contributionHeatmap: ContributionDay[];
};

/**
 * Full user profile statistics.
 *
 * Retained as the composition of the range-scoped headline and the fixed-window
 * heatmap widget so the legacy GET /users/:id/stats route (and any older client)
 * keeps returning the same combined shape. New callers should read the two
 * split payloads independently via /stats/headline and /contributions.
 */
export type UserProfileStats = UserProfileHeadline & UserContributionHeatmap;

/**
 * Kind of lifetime milestone achievement (FEA-4108). The kind identifies which
 * cumulative metric crossed a threshold, so the UI can pick an icon/label from a
 * canonical map rather than trusting a server-supplied display string.
 */
export const MilestoneKind = {
  PrsLanded: "prs-landed",
  DocumentsCreated: "documents-created",
  TokensUsed: "tokens-used",
} as const;
export type MilestoneKind = (typeof MilestoneKind)[keyof typeof MilestoneKind];

/**
 * A single lifetime milestone the user has earned (FEA-4108). Only earned
 * milestones (a real threshold crossed by a real cumulative total) are emitted;
 * the profile never renders a "0 of N" unearned placeholder.
 */
export type UserMilestone = {
  /** Which cumulative metric crossed a threshold. */
  kind: MilestoneKind;
  /** The threshold value that was crossed (e.g. 500 for "500 PRs landed"). */
  threshold: number;
  /** When the milestone was earned: the earliest activity that put the total
   * over the threshold. Serialized as an ISO string on the wire; the app's
   * `useApiClient` revives it back to a `Date` (matching `User.createdAt`), so
   * the contract types the revived value the callers actually receive. */
  earnedAt: Date;
};

/**
 * Consecutive-active-days streak for the user (FEA-4108), derived from the same
 * org-scoped document-artifact activity as the contribution heatmap. A day is
 * "active" when the user created at least one document artifact that day.
 */
export type UserStreak = {
  /** Current run of consecutive active days ending today (or yesterday). 0
   * when the user has no active day within the current run window. */
  currentDays: number;
  /** Longest run of consecutive active days ever recorded. */
  bestDays: number;
};

/**
 * Standing widgets for the profile (FEA-4108) — streak now, rank later.
 *
 * `streak` is null when the user has never had an active day (no real data to
 * show), so the Standing section can stay hidden rather than render a fake
 * zero streak. Rank is intentionally NOT part of this payload yet: a global,
 * cross-org ranking service is unbuilt (FEA-4122), so no rank field is emitted
 * and the profile renders no rank tile until that lands.
 */
export type UserProfileStanding = {
  /** Consecutive-active-days streak, or null when the user has no active day. */
  streak: UserStreak | null;
};

/**
 * Lifetime milestones/achievements for the profile (FEA-4108).
 *
 * `milestones` contains ONLY milestones actually earned (real thresholds
 * crossed), so the Milestones section renders nothing rather than a fake empty
 * state when the user has not crossed any threshold. Sourced from existing
 * per-user cumulative totals — no cross-org queries.
 */
export type UserProfileMilestones = {
  /** Earned lifetime milestones, newest-earned first. */
  milestones: UserMilestone[];
};
