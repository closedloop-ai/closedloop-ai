import { DocumentType } from "@repo/api/src/types/document";
import {
  MilestoneKind,
  type UserContributionHeatmap,
  type UserProfileHeadline,
  type UserProfileMilestones,
  type UserProfileStanding,
} from "@repo/api/src/types/user";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import {
  currentUserFixture,
  liveAppShellRoutes,
  organizationUsersFixture,
} from "./live-app-fixtures";

// The live User Profile (`apps/app/.../users/[userId]/page.tsx`) reads the
// user, their headline stats for the chosen range, their contribution heatmap,
// their streak and their milestones. These are those responses for the
// signed-in engineer.

export const userHeadlineFixture: UserProfileHeadline = {
  documentsByType: [
    { count: 14, type: DocumentType.Feature },
    { count: 5, type: DocumentType.Prd },
    { count: 7, type: DocumentType.ImplementationPlan },
  ],
  totalComments: 86,
  totalDocuments: 26,
  totalPRsLanded: 38,
  totalLoops: 0,
  avgConcurrency: 0,
  totalTokensInput: 0,
  totalTokensOutput: 0,
  totalEstimatedCost: 0,
};

/** A year of activity: busier on weekdays, with a quiet August. */
export const userContributionsFixture: UserContributionHeatmap = {
  contributionHeatmap: Array.from({ length: 365 }, (_unused, index) => {
    const day = new Date(Date.UTC(2025, 9, 7 + index));
    const weekday = day.getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const august = day.getUTCMonth() === 7;
    const base = weekend ? 1 : 6;
    const count = august
      ? index % 5
      : Math.max(0, Math.round(base + 4 * Math.sin(index / 6)));
    return { count, date: day.toISOString().slice(0, 10) };
  }),
};

export const userStandingFixture: UserProfileStanding = {
  streak: { bestDays: 23, currentDays: 9 },
};

export const userMilestonesFixture: UserProfileMilestones = {
  milestones: [
    {
      earnedAt: new Date("2026-09-18T15:20:00.000Z"),
      kind: MilestoneKind.PrsLanded,
      threshold: 100,
    },
    {
      earnedAt: new Date("2026-07-02T11:05:00.000Z"),
      kind: MilestoneKind.DocumentsCreated,
      threshold: 50,
    },
  ],
};

const BASE = `/users/${currentUserFixture.id}`;

export const userProfileApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  { method: "GET", path: "/users", respond: () => organizationUsersFixture },
  {
    method: "GET",
    path: `${BASE}/stats/headline`,
    respond: () => userHeadlineFixture,
  },
  {
    method: "GET",
    path: `${BASE}/contributions`,
    respond: () => userContributionsFixture,
  },
  {
    method: "GET",
    path: `${BASE}/standing`,
    respond: () => userStandingFixture,
  },
  {
    method: "GET",
    path: `${BASE}/milestones`,
    respond: () => userMilestonesFixture,
  },
  { method: "GET", path: BASE, respond: () => currentUserFixture },
];
