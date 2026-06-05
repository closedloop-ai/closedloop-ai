import { describe, expect, it } from "vitest";
import { deriveBaseRepoPath } from "@/lib/engineer/worktree-utils";

describe("deriveBaseRepoPath", () => {
  it("strips ticket-based suffix", () => {
    // Ticket "AI-123" sanitizes to "AI-123" (dashes kept), suffix "-AI-123"
    expect(
      deriveBaseRepoPath("/Users/me/Source/closedloop-ai-AI-123", "AI-123")
    ).toBe("/Users/me/Source/closedloop-ai");
  });

  it("strips loop-based suffix", () => {
    expect(
      deriveBaseRepoPath(
        "/Users/me/Source/closedloop-ai-loop-plan-1",
        "AI-123"
      )
    ).toBe("/Users/me/Source/closedloop-ai");
  });

  it("prefers ticket-based suffix over loop regex for repos with -loop- in name", () => {
    // Repo named "data-loop" with ticket AI-123
    // Worktree: data-loop-AI-123 (ticket suffix matches first)
    expect(
      deriveBaseRepoPath("/Users/me/Source/data-loop-AI-123", "AI-123")
    ).toBe("/Users/me/Source/data-loop");
  });

  it("handles repo named data-loop with loop-style worktree", () => {
    // Repo "data-loop", loop worktree: data-loop-loop-plan-5
    // Ticket doesn't match, falls through to loop regex
    expect(
      deriveBaseRepoPath("/Users/me/Source/data-loop-loop-plan-5", "AI-123")
    ).toBe("/Users/me/Source/data-loop");
  });

  it("returns dirname as-is when neither pattern matches", () => {
    expect(deriveBaseRepoPath("/Users/me/Source/some-repo", "NOMATCH")).toBe(
      "/Users/me/Source/some-repo"
    );
  });

  it("handles special characters in ticket identifier", () => {
    // Ticket "PROJ/123" sanitizes to "PROJ_123" (slash -> underscore)
    expect(
      deriveBaseRepoPath("/Users/me/Source/my-repo-PROJ_123", "PROJ/123")
    ).toBe("/Users/me/Source/my-repo");
  });

  it("handles ticket IDs with dots", () => {
    // Ticket "5tVcaqmn.4PDTD" sanitizes to "5tVcaqmn_4PDTD"
    expect(
      deriveBaseRepoPath(
        "/Users/me/Source/closedloop-ai-5tVcaqmn_4PDTD",
        "5tVcaqmn.4PDTD"
      )
    ).toBe("/Users/me/Source/closedloop-ai");
  });
});
