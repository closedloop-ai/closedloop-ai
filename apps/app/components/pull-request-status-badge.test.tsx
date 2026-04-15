import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PullRequestStatusBadge } from "./pull-request-status-badge";

afterEach(() => {
  cleanup();
});

describe("PullRequestStatusBadge", () => {
  it("renders blue badge for OPEN state", () => {
    render(
      <PullRequestStatusBadge
        pullRequest={{
          id: "pr-1",
          state: "OPEN",
          htmlUrl: "http://example.com",
          number: 1,
          title: "Test PR 1",
          headBranch: "feature-branch",
          baseBranch: "main",
          createdAt: new Date("2024-01-01T00:00:00Z"),
          checksStatus: null,
          reviewDecision: null,
          externalLinkId: null,
        }}
      />
    );
    const badge = screen.getByText("OPEN");
    expect(badge).toBeDefined();
    // Check for info token class - StatusBadge uses bg-info/10 for OPEN state
    expect(badge.className).toContain("bg-info/10");
  });

  it("renders green badge for MERGED state", () => {
    render(
      <PullRequestStatusBadge
        pullRequest={{
          id: "pr-2",
          state: "MERGED",
          htmlUrl: "http://example.com",
          number: 2,
          title: "Test PR 2",
          headBranch: "feature-branch",
          baseBranch: "main",
          createdAt: new Date("2024-01-02T00:00:00Z"),
          checksStatus: null,
          reviewDecision: null,
          externalLinkId: null,
        }}
      />
    );
    const badge = screen.getByText("MERGED");
    expect(badge).toBeDefined();
    // Check for success token class - StatusBadge uses bg-success/10 for MERGED state
    expect(badge.className).toContain("bg-success/10");
  });

  it("renders red badge for CLOSED state", () => {
    render(
      <PullRequestStatusBadge
        pullRequest={{
          id: "pr-3",
          state: "CLOSED",
          htmlUrl: "http://example.com",
          number: 3,
          title: "Test PR 3",
          headBranch: "feature-branch",
          baseBranch: "main",
          createdAt: new Date("2024-01-03T00:00:00Z"),
          checksStatus: null,
          reviewDecision: null,
          externalLinkId: null,
        }}
      />
    );
    const badge = screen.getByText("CLOSED");
    expect(badge).toBeDefined();
    // Check for destructive token class - StatusBadge uses bg-destructive/10 for CLOSED state
    expect(badge.className).toContain("bg-destructive/10");
  });

  it("renders null when pullRequest is not provided", () => {
    const { container } = render(
      <PullRequestStatusBadge pullRequest={undefined} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders null when pullRequest is null", () => {
    const { container } = render(<PullRequestStatusBadge pullRequest={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("CI status indicator", () => {
  const basePullRequest = {
    id: "pr-ci",
    state: "OPEN" as const,
    htmlUrl: "http://example.com",
    number: 10,
    title: "CI Test PR",
    headBranch: "feature-branch",
    baseBranch: "main",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    reviewDecision: null,
    externalLinkId: null,
  };

  it("renders green checkmark for checksStatus PASSING", () => {
    render(
      <PullRequestStatusBadge
        pullRequest={{ ...basePullRequest, checksStatus: "PASSING" }}
      />
    );
    expect(screen.getByTestId("ci-status-passing")).toBeDefined();
  });

  it("renders red X for checksStatus FAILING", () => {
    render(
      <PullRequestStatusBadge
        pullRequest={{ ...basePullRequest, checksStatus: "FAILING" }}
      />
    );
    expect(screen.getByTestId("ci-status-failing")).toBeDefined();
  });

  it("renders yellow clock for checksStatus PENDING", () => {
    render(
      <PullRequestStatusBadge
        pullRequest={{ ...basePullRequest, checksStatus: "PENDING" }}
      />
    );
    expect(screen.getByTestId("ci-status-pending")).toBeDefined();
  });

  it("renders no CI icon for checksStatus UNKNOWN", () => {
    render(
      <PullRequestStatusBadge
        pullRequest={{ ...basePullRequest, checksStatus: "UNKNOWN" }}
      />
    );
    expect(screen.queryByTestId("ci-status-passing")).toBeNull();
    expect(screen.queryByTestId("ci-status-failing")).toBeNull();
    expect(screen.queryByTestId("ci-status-pending")).toBeNull();
  });

  it("renders no CI icon for checksStatus null", () => {
    render(
      <PullRequestStatusBadge
        pullRequest={{ ...basePullRequest, checksStatus: null }}
      />
    );
    expect(screen.queryByTestId("ci-status-passing")).toBeNull();
    expect(screen.queryByTestId("ci-status-failing")).toBeNull();
    expect(screen.queryByTestId("ci-status-pending")).toBeNull();
  });
});
