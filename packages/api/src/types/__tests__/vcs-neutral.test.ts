import { describe, expect, it } from "vitest";
import {
  ChecksStatus as GitHubChecksStatus,
  ReviewDecision as GitHubReviewDecision,
} from "../branch-checks";
import { GitHubInstallationStatus } from "../github";
import { GitHubPRState } from "../github-status";
import {
  ChangeRequestState,
  changeRequestStateFromGitHub,
  changeRequestStateToGitHub,
  VcsCheckStatus,
  VcsConnectionStatus,
  VcsProviderKind,
  VcsReviewDecision,
  vcsCheckStatusFromGitHub,
  vcsCheckStatusToGitHub,
  vcsConnectionStatusFromGitHub,
  vcsConnectionStatusToGitHub,
  vcsReviewDecisionFromGitHub,
  vcsReviewDecisionToGitHub,
} from "../vcs-neutral";

describe("neutral VCS enum wire values", () => {
  it("pins ChangeRequestState values (superset of GitHubPRState + LOCKED)", () => {
    expect(ChangeRequestState.Open).toBe("OPEN");
    expect(ChangeRequestState.Merged).toBe("MERGED");
    expect(ChangeRequestState.Closed).toBe("CLOSED");
    expect(ChangeRequestState.Locked).toBe("LOCKED");
  });

  it("pins VcsCheckStatus values", () => {
    expect(VcsCheckStatus.Unknown).toBe("UNKNOWN");
    expect(VcsCheckStatus.Pending).toBe("PENDING");
    expect(VcsCheckStatus.Passing).toBe("PASSING");
    expect(VcsCheckStatus.Failing).toBe("FAILING");
  });

  it("pins VcsReviewDecision values", () => {
    expect(VcsReviewDecision.Approved).toBe("APPROVED");
    expect(VcsReviewDecision.ChangesRequested).toBe("CHANGES_REQUESTED");
    expect(VcsReviewDecision.Commented).toBe("COMMENTED");
    expect(VcsReviewDecision.Dismissed).toBe("DISMISSED");
  });

  it("pins VcsConnectionStatus values", () => {
    expect(VcsConnectionStatus.PendingClaim).toBe("PENDING_CLAIM");
    expect(VcsConnectionStatus.Active).toBe("ACTIVE");
    expect(VcsConnectionStatus.Suspended).toBe("SUSPENDED");
    expect(VcsConnectionStatus.Uninstalled).toBe("UNINSTALLED");
  });

  it("pins VcsProviderKind", () => {
    expect(VcsProviderKind.GitHub).toBe("github");
  });
});

describe("ChangeRequestState <-> GitHubPRState", () => {
  it("maps every GitHubPRState to a neutral state (total)", () => {
    for (const state of Object.values(GitHubPRState)) {
      expect(() => changeRequestStateFromGitHub(state)).not.toThrow();
    }
    expect(changeRequestStateFromGitHub(GitHubPRState.Open)).toBe(
      ChangeRequestState.Open
    );
    expect(changeRequestStateFromGitHub(GitHubPRState.Merged)).toBe(
      ChangeRequestState.Merged
    );
    expect(changeRequestStateFromGitHub(GitHubPRState.Closed)).toBe(
      ChangeRequestState.Closed
    );
  });

  it("round-trips the shared GitHub states losslessly", () => {
    for (const state of Object.values(GitHubPRState)) {
      const neutral = changeRequestStateFromGitHub(state);
      expect(changeRequestStateToGitHub(neutral)).toBe(state);
    }
  });

  it("folds neutral-only LOCKED onto CLOSED for GitHub writes", () => {
    expect(changeRequestStateToGitHub(ChangeRequestState.Locked)).toBe(
      GitHubPRState.Closed
    );
  });

  it("maps every neutral state to a GitHubPRState (total)", () => {
    for (const state of Object.values(ChangeRequestState)) {
      expect(Object.values(GitHubPRState)).toContain(
        changeRequestStateToGitHub(state)
      );
    }
  });
});

describe("VcsCheckStatus <-> ChecksStatus", () => {
  it("round-trips every value in both directions", () => {
    for (const status of Object.values(GitHubChecksStatus)) {
      const neutral = vcsCheckStatusFromGitHub(status);
      expect(vcsCheckStatusToGitHub(neutral)).toBe(status);
    }
    for (const status of Object.values(VcsCheckStatus)) {
      const gh = vcsCheckStatusToGitHub(status);
      expect(vcsCheckStatusFromGitHub(gh)).toBe(status);
    }
  });

  it("covers every GitHub check status", () => {
    for (const status of Object.values(GitHubChecksStatus)) {
      expect(() => vcsCheckStatusFromGitHub(status)).not.toThrow();
    }
  });
});

describe("VcsReviewDecision <-> ReviewDecision", () => {
  it("round-trips every value in both directions", () => {
    for (const decision of Object.values(GitHubReviewDecision)) {
      const neutral = vcsReviewDecisionFromGitHub(decision);
      expect(vcsReviewDecisionToGitHub(neutral)).toBe(decision);
    }
    for (const decision of Object.values(VcsReviewDecision)) {
      const gh = vcsReviewDecisionToGitHub(decision);
      expect(vcsReviewDecisionFromGitHub(gh)).toBe(decision);
    }
  });

  it("covers every GitHub review decision", () => {
    for (const decision of Object.values(GitHubReviewDecision)) {
      expect(() => vcsReviewDecisionFromGitHub(decision)).not.toThrow();
    }
  });
});

describe("VcsConnectionStatus <-> GitHubInstallationStatus", () => {
  it("round-trips every value in both directions", () => {
    for (const status of Object.values(GitHubInstallationStatus)) {
      const neutral = vcsConnectionStatusFromGitHub(status);
      expect(vcsConnectionStatusToGitHub(neutral)).toBe(status);
    }
    for (const status of Object.values(VcsConnectionStatus)) {
      const gh = vcsConnectionStatusToGitHub(status);
      expect(vcsConnectionStatusFromGitHub(gh)).toBe(status);
    }
  });

  it("covers every GitHub installation status", () => {
    for (const status of Object.values(GitHubInstallationStatus)) {
      expect(() => vcsConnectionStatusFromGitHub(status)).not.toThrow();
    }
  });
});
