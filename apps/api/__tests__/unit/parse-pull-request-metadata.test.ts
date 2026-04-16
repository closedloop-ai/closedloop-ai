import { parsePullRequestMetadata } from "@repo/api/src/types/external-link-utils";
import { describe, expect, it } from "vitest";

describe("parsePullRequestMetadata", () => {
  describe("valid minimal input", () => {
    it("parses a complete minimal valid object", () => {
      const result = parsePullRequestMetadata({
        number: 42,
        headBranch: "feature/my-feature",
        baseBranch: "main",
        state: "OPEN",
      });

      expect(result).not.toBeNull();
      expect(result!.number).toBe(42);
      expect(result!.headBranch).toBe("feature/my-feature");
      expect(result!.baseBranch).toBe("main");
      expect(result!.state).toBe("OPEN");
    });
  });

  describe("timestamp fields — ISO string path (backend/webhook)", () => {
    it("accepts ISO string for lastVerifiedAt", () => {
      const result = parsePullRequestMetadata({
        number: 1,
        headBranch: "feat",
        baseBranch: "main",
        state: "MERGED",
        lastVerifiedAt: "2024-01-15T10:30:00.000Z",
      });

      expect(result).not.toBeNull();
      expect(result!.lastVerifiedAt).toBe("2024-01-15T10:30:00.000Z");
    });

    it("accepts ISO string for lastRefreshAttemptAt", () => {
      const result = parsePullRequestMetadata({
        number: 1,
        headBranch: "feat",
        baseBranch: "main",
        state: "OPEN",
        lastRefreshAttemptAt: "2024-06-01T00:00:00.000Z",
      });

      expect(result).not.toBeNull();
      expect(result!.lastRefreshAttemptAt).toBe("2024-06-01T00:00:00.000Z");
    });

    it("accepts ISO strings for both timestamp fields", () => {
      const result = parsePullRequestMetadata({
        number: 5,
        headBranch: "branch",
        baseBranch: "main",
        state: "CLOSED",
        lastVerifiedAt: "2024-01-01T00:00:00.000Z",
        lastRefreshAttemptAt: "2024-01-02T00:00:00.000Z",
      });

      expect(result).not.toBeNull();
      expect(result!.lastVerifiedAt).toBe("2024-01-01T00:00:00.000Z");
      expect(result!.lastRefreshAttemptAt).toBe("2024-01-02T00:00:00.000Z");
    });
  });

  describe("timestamp fields — Date object path (normalized to string)", () => {
    it("normalizes Date object for lastVerifiedAt to ISO string", () => {
      const date = new Date("2024-03-10T12:00:00.000Z");
      const result = parsePullRequestMetadata({
        number: 7,
        headBranch: "fix/bug",
        baseBranch: "main",
        state: "OPEN",
        lastVerifiedAt: date,
      });

      expect(result).not.toBeNull();
      expect(result!.lastVerifiedAt).toBe("2024-03-10T12:00:00.000Z");
    });

    it("normalizes Date object for lastRefreshAttemptAt to ISO string", () => {
      const date = new Date("2024-04-20T08:00:00.000Z");
      const result = parsePullRequestMetadata({
        number: 8,
        headBranch: "hotfix",
        baseBranch: "main",
        state: "MERGED",
        lastRefreshAttemptAt: date,
      });

      expect(result).not.toBeNull();
      expect(result!.lastRefreshAttemptAt).toBe("2024-04-20T08:00:00.000Z");
    });

    it("normalizes Date objects for both timestamp fields to ISO strings", () => {
      const verified = new Date("2024-05-01T00:00:00.000Z");
      const attempted = new Date("2024-05-02T00:00:00.000Z");
      const result = parsePullRequestMetadata({
        number: 9,
        headBranch: "release/1.0",
        baseBranch: "main",
        state: "MERGED",
        lastVerifiedAt: verified,
        lastRefreshAttemptAt: attempted,
      });

      expect(result).not.toBeNull();
      expect(result!.lastVerifiedAt).toBe("2024-05-01T00:00:00.000Z");
      expect(result!.lastRefreshAttemptAt).toBe("2024-05-02T00:00:00.000Z");
    });
  });

  describe("null and missing timestamp fields", () => {
    it("accepts null for lastVerifiedAt", () => {
      const result = parsePullRequestMetadata({
        number: 10,
        headBranch: "feat",
        baseBranch: "main",
        state: "OPEN",
        lastVerifiedAt: null,
      });

      expect(result).not.toBeNull();
      expect(result!.lastVerifiedAt).toBeNull();
    });

    it("accepts null for lastRefreshAttemptAt", () => {
      const result = parsePullRequestMetadata({
        number: 11,
        headBranch: "feat",
        baseBranch: "main",
        state: "OPEN",
        lastRefreshAttemptAt: null,
      });

      expect(result).not.toBeNull();
      expect(result!.lastRefreshAttemptAt).toBeNull();
    });

    it("accepts missing lastVerifiedAt (field omitted entirely)", () => {
      const result = parsePullRequestMetadata({
        number: 12,
        headBranch: "feat",
        baseBranch: "main",
        state: "CLOSED",
      });

      expect(result).not.toBeNull();
      expect(result!.lastVerifiedAt).toBeUndefined();
    });

    it("accepts missing lastRefreshAttemptAt (field omitted entirely)", () => {
      const result = parsePullRequestMetadata({
        number: 13,
        headBranch: "feat",
        baseBranch: "main",
        state: "CLOSED",
      });

      expect(result).not.toBeNull();
      expect(result!.lastRefreshAttemptAt).toBeUndefined();
    });
  });

  describe("missing githubId — backward compatibility", () => {
    it("parses successfully when githubId is absent", () => {
      const result = parsePullRequestMetadata({
        number: 100,
        headBranch: "legacy-branch",
        baseBranch: "main",
        state: "MERGED",
      });

      expect(result).not.toBeNull();
      expect(result!.githubId).toBeUndefined();
    });

    it("includes githubId when present", () => {
      const result = parsePullRequestMetadata({
        number: 101,
        githubId: "PR_kwABCDEFGH",
        headBranch: "new-feature",
        baseBranch: "main",
        state: "OPEN",
      });

      expect(result).not.toBeNull();
      expect(result!.githubId).toBe("PR_kwABCDEFGH");
    });
  });

  describe("extra unknown fields are stripped, not rejected", () => {
    it("strips isDraft and returns valid metadata", () => {
      const result = parsePullRequestMetadata({
        number: 20,
        headBranch: "draft-branch",
        baseBranch: "main",
        state: "OPEN",
        isDraft: true,
      });

      expect(result).not.toBeNull();
      expect(result!.number).toBe(20);
      expect((result as Record<string, unknown>).isDraft).toBeUndefined();
    });

    it("strips multiple unknown fields while preserving known ones", () => {
      const result = parsePullRequestMetadata({
        number: 21,
        headBranch: "feat",
        baseBranch: "develop",
        state: "CLOSED",
        isDraft: false,
        labels: ["bug", "enhancement"],
        reviewers: ["alice", "bob"],
        unknownField: "value",
      });

      expect(result).not.toBeNull();
      expect(result!.number).toBe(21);
      expect(result!.headBranch).toBe("feat");
      expect(result!.baseBranch).toBe("develop");
      expect(result!.state).toBe("CLOSED");
      expect((result as Record<string, unknown>).isDraft).toBeUndefined();
      expect((result as Record<string, unknown>).labels).toBeUndefined();
      expect((result as Record<string, unknown>).reviewers).toBeUndefined();
    });
  });

  describe("full valid metadata — webhook path", () => {
    it("parses a complete webhook-shaped object with all fields present", () => {
      const result = parsePullRequestMetadata({
        number: 999,
        githubId: "PR_kwDOABCDEFG",
        headBranch: "feature/full-webhook-test",
        baseBranch: "main",
        state: "MERGED",
        lastVerifiedAt: "2024-12-01T15:00:00.000Z",
        lastRefreshAttemptAt: "2024-12-01T15:05:00.000Z",
        isDraft: false,
        title: "My PR title",
        htmlUrl: "https://github.com/org/repo/pull/999",
      });

      expect(result).not.toBeNull();
      expect(result!.number).toBe(999);
      expect(result!.githubId).toBe("PR_kwDOABCDEFG");
      expect(result!.headBranch).toBe("feature/full-webhook-test");
      expect(result!.baseBranch).toBe("main");
      expect(result!.state).toBe("MERGED");
      expect(result!.lastVerifiedAt).toBe("2024-12-01T15:00:00.000Z");
      expect(result!.lastRefreshAttemptAt).toBe("2024-12-01T15:05:00.000Z");
      expect((result as Record<string, unknown>).isDraft).toBeUndefined();
      expect((result as Record<string, unknown>).title).toBeUndefined();
      expect((result as Record<string, unknown>).htmlUrl).toBeUndefined();
    });
  });

  describe("invalid inputs return null", () => {
    it("returns null for null input", () => {
      expect(parsePullRequestMetadata(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(parsePullRequestMetadata(undefined)).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(parsePullRequestMetadata("string")).toBeNull();
      expect(parsePullRequestMetadata(42)).toBeNull();
      expect(parsePullRequestMetadata(true)).toBeNull();
    });

    it("returns null when required field number is missing", () => {
      expect(
        parsePullRequestMetadata({
          headBranch: "feat",
          baseBranch: "main",
          state: "OPEN",
        })
      ).toBeNull();
    });

    it("returns null when required field headBranch is missing", () => {
      expect(
        parsePullRequestMetadata({
          number: 1,
          baseBranch: "main",
          state: "OPEN",
        })
      ).toBeNull();
    });

    it("returns null when required field baseBranch is missing", () => {
      expect(
        parsePullRequestMetadata({
          number: 1,
          headBranch: "feat",
          state: "OPEN",
        })
      ).toBeNull();
    });

    it("returns null when state is an invalid enum value", () => {
      expect(
        parsePullRequestMetadata({
          number: 1,
          headBranch: "feat",
          baseBranch: "main",
          state: "INVALID_STATE",
        })
      ).toBeNull();
    });

    it("returns null when number is a string instead of a number", () => {
      expect(
        parsePullRequestMetadata({
          number: "42",
          headBranch: "feat",
          baseBranch: "main",
          state: "OPEN",
        })
      ).toBeNull();
    });
  });
});
