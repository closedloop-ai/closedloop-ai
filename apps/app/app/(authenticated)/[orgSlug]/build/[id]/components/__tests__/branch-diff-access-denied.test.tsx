// @vitest-environment jsdom
import { BranchViewFileDiffErrorCode } from "@repo/api/src/types/branch-view";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { ApiError } from "@repo/app/shared/api/api-error";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/acme/build/branch-1",
}));

import { BranchDiffErrorState } from "../branch-diff-access-denied";

const GENERIC_ERROR = /Failed to load diff/u;
const CONNECT_GITHUB = /Connect GitHub/u;
const CONNECT_TO_VIEW_DIFF = /Connect GitHub to view this diff/u;
const NO_REPOSITORY_ACCESS = /You don't have access to this repository/u;
const CONNECTION_NEEDS_RENEWING = /Your GitHub connection needs renewing/u;
const RATE_LIMITED = /GitHub is rate-limiting this request/u;
const GITHUB_UNAVAILABLE = /GitHub didn't respond/u;
const ORG_NOT_APPROVED = /hasn't approved Closedloop on GitHub/u;

function denialError(reason: GitHubAccessDenialReason) {
  return new ApiError("Forbidden", 403, {
    code: BranchViewFileDiffErrorCode.GithubAccessDenied,
    details: { accessDenial: reason },
  });
}

describe("BranchDiffErrorState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("names the cause and offers a connect CTA for a fixable credential problem", () => {
    render(
      <BranchDiffErrorState
        error={denialError(GitHubAccessDenialReason.NotConnected)}
      />
    );

    expect(screen.getByText(CONNECT_TO_VIEW_DIFF)).toBeTruthy();
    expect(screen.getByRole("link", { name: CONNECT_GITHUB })).toBeTruthy();
    expect(screen.queryByText(GENERIC_ERROR)).toBeNull();
  });

  test("returns the reader to the diff they were on after connecting", () => {
    render(
      <BranchDiffErrorState
        error={denialError(GitHubAccessDenialReason.NotConnected)}
      />
    );

    // A real href, not a click handler, so the CTA survives middle-click and
    // keyboard opening the way the sibling identity prompt's does.
    expect(
      screen.getByRole("link", { name: CONNECT_GITHUB }).getAttribute("href")
    ).toBe("/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-1");
  });

  test("offers no CTA when only GitHub can grant the access", () => {
    // A connect button here would be a dead end: reconnecting the same account
    // cannot grant repository access the account does not have.
    render(
      <BranchDiffErrorState
        error={denialError(GitHubAccessDenialReason.NoInstallation)}
      />
    );

    expect(screen.getByText(NO_REPOSITORY_ACCESS)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("offers no CTA when an org owner has to approve on GitHub", () => {
    render(
      <BranchDiffErrorState
        error={denialError(GitHubAccessDenialReason.OrgRestricted)}
      />
    );

    expect(screen.getByText(ORG_NOT_APPROVED)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test.each([
    [GitHubAccessDenialReason.RateLimited, RATE_LIMITED],
    [GitHubAccessDenialReason.Unavailable, GITHUB_UNAVAILABLE],
    [GitHubAccessDenialReason.BudgetDeferred, GITHUB_UNAVAILABLE],
  ])("names %s as a transient GitHub failure rather than an access problem", (reason, expectedCopy) => {
    // These are the states most easily mistaken for "you're locked out".
    // The copy has to read as "not right now", and a connect CTA would be
    // wrong: the reader's credential is fine.
    render(<BranchDiffErrorState error={denialError(reason)} />);

    expect(screen.getByText(expectedCopy)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(NO_REPOSITORY_ACCESS)).toBeNull();
  });

  test("falls back to the generic error for a non-denial failure", () => {
    render(<BranchDiffErrorState error={new Error("network down")} />);

    expect(screen.getByText(GENERIC_ERROR)).toBeTruthy();
  });

  test("gives the denial state an accessible name matching its heading", () => {
    render(
      <BranchDiffErrorState
        error={denialError(GitHubAccessDenialReason.Revoked)}
      />
    );

    expect(
      screen.getByRole("region", {
        name: CONNECTION_NEEDS_RENEWING,
      })
    ).toBeTruthy();
  });
});
