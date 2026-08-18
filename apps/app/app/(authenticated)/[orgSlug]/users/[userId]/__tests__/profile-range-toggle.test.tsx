/**
 * FEA-4064: the profile-header range toggle re-scopes ONLY the ranged headline
 * query. We assert on the `useUserProfileHeadline` filter (the real scoping
 * input the toggle drives) and prove the fixed-window
 * `useUserContributionHeatmap` query is NOT re-scoped by the toggle — it never
 * receives a range filter, so a range click cannot re-issue the trailing-year
 * heatmap SQL.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUser = {
  id: "user-1",
  clerkId: "clerk-1",
  organizationId: "org-1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: null,
  phoneNumber: null,
  role: "ENGINEER",
  linearId: null,
  slackId: null,
  githubUsername: null,
  active: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const mockHeadline = {
  totalDocuments: 10,
  documentsByType: [],
  totalComments: 5,
  totalPRsLanded: 3,
  totalLoops: 7,
  avgConcurrency: 1.2,
  totalTokensInput: 1000,
  totalTokensOutput: 500,
  totalEstimatedCost: 4.2,
};

const mockHeatmap = { contributionHeatmap: [] };

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useUser: vi.fn(() => ({ data: mockUser, isLoading: false })),
  useUserProfileHeadline: vi.fn(() => ({
    data: mockHeadline,
    isLoading: false,
    isError: false,
  })),
  useUserContributionHeatmap: vi.fn(() => ({
    data: mockHeatmap,
    isLoading: false,
    isError: false,
  })),
  // FEA-4108: standing/milestones widgets are unranged; this suite only asserts
  // the range toggle, so both resolve with no real data (sections hidden).
  useUserProfileStanding: vi.fn(() => ({
    data: { streak: null },
    isLoading: false,
    isError: false,
  })),
  useUserProfileMilestones: vi.fn(() => ({
    data: { milestones: [] },
    isLoading: false,
    isError: false,
  })),
}));

vi.mock("../../../../components/header", () => ({
  Header: () => null,
}));

vi.mock("next/image", () => ({
  __esModule: true,
  default: () => null,
}));

import {
  useUserContributionHeatmap,
  useUserProfileHeadline,
} from "@repo/app/users/hooks/use-users";
import UserProfilePage from "../page";

// `use(params)` caches by promise identity, so the params promise must be a
// stable module-level reference (a fresh one per render re-suspends forever).
const PARAMS = Promise.resolve({ orgSlug: "acme", userId: "user-1" });

async function renderPage() {
  // Settle the suspended params promise inside act so the tree resumes: render,
  // then await a microtask so React flushes the resumed Suspense boundary.
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <UserProfilePage params={PARAMS} />
      </Suspense>
    );
    await PARAMS;
  });
  await screen.findByRole("group");
}

/** Read the `filters` arg (2nd positional) of the latest headline-hook call. */
function latestHeadlineFilters() {
  return vi.mocked(useUserProfileHeadline).mock.calls.at(-1)?.[1];
}

describe("UserProfilePage — range toggle (FEA-4064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the three range options and defaults to 30d", async () => {
    await renderPage();

    const group = screen.getByRole("group");
    expect(within(group).getByText("30d")).toBeInTheDocument();
    expect(within(group).getByText("90d")).toBeInTheDocument();
    expect(within(group).getByText("1y")).toBeInTheDocument();

    // Default scope is the trailing 30 days, so the initial headline fetch
    // carries a non-empty startDate rather than an all-time (undefined) window.
    expect(latestHeadlineFilters()?.startDate).toEqual(expect.any(String));

    // The active window is stated under the toggle (as one unit with it) so the
    // numbers below are not read as lifetime totals.
    expect(screen.getByText("Showing last 30 days")).toBeInTheDocument();
  });

  it("re-scopes ONLY the headline query when a different range is selected", async () => {
    await renderPage();

    const before = latestHeadlineFilters()?.startDate;

    fireEvent.click(screen.getByText("90d"));

    const after = latestHeadlineFilters()?.startDate;
    // A wider window means an earlier lower bound, so the startDate must move.
    expect(after).toEqual(expect.any(String));
    expect(after).not.toEqual(before);
    expect(new Date(after as string).getTime()).toBeLessThan(
      new Date(before as string).getTime()
    );
    expect(screen.getByText("Showing last 90 days")).toBeInTheDocument();
  });

  it("never passes a range filter to the fixed-window heatmap query", async () => {
    // The heatmap hook is called positionally as (userId, options?) — it must
    // never receive a range/startDate filter, so the toggle cannot re-issue the
    // trailing-year heatmap SQL. Toggling the range does not change that.
    await renderPage();

    for (const call of vi.mocked(useUserContributionHeatmap).mock.calls) {
      // First arg is the userId string; there is no range-filter argument.
      expect(call[0]).toBe("user-1");
      const second = call[1] as { startDate?: unknown } | undefined;
      expect(second?.startDate).toBeUndefined();
    }

    fireEvent.click(screen.getByText("1y"));

    for (const call of vi.mocked(useUserContributionHeatmap).mock.calls) {
      const second = call[1] as { startDate?: unknown } | undefined;
      expect(second?.startDate).toBeUndefined();
    }
  });
});
