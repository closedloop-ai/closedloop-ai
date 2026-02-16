import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PullRequestStatusBadge } from "./pull-request-status-badge";

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
          reviewDecision: null,
        }}
      />
    );
    const badge = screen.getByText("OPEN");
    expect(badge).toBeDefined();
    // Check for blue color class - StatusBadge uses bg-blue-100 for OPEN state
    expect(badge.className).toContain("bg-blue-100");
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
          reviewDecision: null,
        }}
      />
    );
    const badge = screen.getByText("MERGED");
    expect(badge).toBeDefined();
    // Check for green color class - StatusBadge uses bg-green-100 for MERGED state
    expect(badge.className).toContain("bg-green-100");
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
          reviewDecision: null,
        }}
      />
    );
    const badge = screen.getByText("CLOSED");
    expect(badge).toBeDefined();
    // Check for red color class - StatusBadge uses bg-red-100 for CLOSED state
    expect(badge.className).toContain("bg-red-100");
  });

  it("renders null when pullRequest is not provided", () => {
    const { container } = render(
      <PullRequestStatusBadge pullRequest={undefined} />
    );
    expect(container.firstChild).toBeNull();
  });
});
