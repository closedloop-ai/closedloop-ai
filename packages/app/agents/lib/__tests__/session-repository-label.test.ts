import {
  resolveSessionRepositoryDisplay,
  resolveSessionRepositoryFullName,
  resolveSessionRepositoryLabel,
  SESSION_REPOSITORY_UNKNOWN_LABEL,
  SessionRepositoryDisplayKind,
  toGitHubRepoPath,
} from "@repo/app/agents/lib/session-repository-label";
import { describe, expect, it } from "vitest";

describe("session repository identity (FEA-3780)", () => {
  it("resolves a well-formed remote", () => {
    expect(
      resolveSessionRepositoryFullName({
        repositoryFullName: "closedloop-ai/symphony-alpha",
      })
    ).toBe("closedloop-ai/symphony-alpha");
    expect(
      resolveSessionRepositoryLabel({
        repositoryFullName: "closedloop-ai/symphony-alpha",
      })
    ).toBe("closedloop-ai/symphony-alpha");
  });

  it("trims surrounding whitespace off an otherwise valid remote", () => {
    expect(
      resolveSessionRepositoryLabel({
        repositoryFullName: "  closedloop-ai/symphony-alpha  ",
      })
    ).toBe("closedloop-ai/symphony-alpha");
  });

  it("preserves the stored spelling verbatim", () => {
    // The Repository facet groups on the STORED value, so a label that
    // lowercased or rewrote it would no longer match the option it sits under.
    // (`normalizeRepoFullName` in packages/api/src/types/branch.ts is the
    // artifact-key normalizer and DOES lowercase — different lane, see the
    // module doc.)
    expect(
      resolveSessionRepositoryLabel({ repositoryFullName: "Owner/Repo.js" })
    ).toBe("Owner/Repo.js");
  });

  it("falls back to the `repo` alias when `repositoryFullName` is absent", () => {
    // Version skew: an older producer that populated only `repo`.
    expect(
      resolveSessionRepositoryLabel({
        repositoryFullName: null,
        repo: "closedloop-ai/symphony-alpha",
      })
    ).toBe("closedloop-ai/symphony-alpha");
  });

  it("skips a degenerate `repositoryFullName` in favour of a valid alias", () => {
    expect(
      resolveSessionRepositoryLabel({
        repositoryFullName: "/",
        repo: "closedloop-ai/symphony-alpha",
      })
    ).toBe("closedloop-ai/symphony-alpha");
  });

  it("never renders a bare slash — the reported FEA-3780 symptom", () => {
    expect(resolveSessionRepositoryFullName({ repositoryFullName: "/" })).toBe(
      null
    );
    expect(resolveSessionRepositoryLabel({ repositoryFullName: "/" })).toBe(
      SESSION_REPOSITORY_UNKNOWN_LABEL
    );
    expect(resolveSessionRepositoryLabel({ repo: "/" })).toBe(
      SESSION_REPOSITORY_UNKNOWN_LABEL
    );
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["filesystem root", "/"],
    ["repeated slashes", "//"],
    ["slashes and whitespace", "  / "],
  ])("rejects %s — it carries no identity", (_label, value) => {
    // The predicate itself is covered in `@repo/lib/sessions/repository-identity`
    // (ISS-4996 moved it there so the ingest schema can share it); this asserts
    // the LABEL the surface renders for such a value.
    expect(resolveSessionRepositoryLabel({ repositoryFullName: value })).toBe(
      SESSION_REPOSITORY_UNKNOWN_LABEL
    );
  });

  // `resolveRepoFullName` (apps/desktop/src/server/operations/git-helpers.ts)
  // captures the one-slash tail of ANY origin remote — no host check, no
  // character class — so these all resolve and persist for real users. An
  // `owner/repo` char-class guard here would render "Unknown" for a repository
  // that genuinely resolved, AND disagree with the Repository facet, which
  // still offers the stored value.
  it.each([
    ["a local-path remote", "my projects/repo"],
    ["a gitolite remote", "~user/repo"],
    ["a non-ASCII self-hosted owner", "Grüne/repo"],
    ["a deeper self-hosted path", "group/subgroup/repo"],
    ["a single-segment name", "symphony-alpha"],
  ])("renders %s rather than claiming Unknown", (_label, value) => {
    expect(resolveSessionRepositoryLabel({ repositoryFullName: value })).toBe(
      value
    );
  });

  it("reports Unknown when the record carries no repository fields at all", () => {
    expect(resolveSessionRepositoryFullName({})).toBe(null);
    expect(resolveSessionRepositoryLabel({})).toBe(
      SESSION_REPOSITORY_UNKNOWN_LABEL
    );
    expect(
      resolveSessionRepositoryLabel({ repositoryFullName: null, repo: null })
    ).toBe(SESSION_REPOSITORY_UNKNOWN_LABEL);
  });
});

describe("toGitHubRepoPath", () => {
  it("accepts a github-shaped owner/repo", () => {
    expect(toGitHubRepoPath("closedloop-ai/symphony-alpha")).toBe(
      "closedloop-ai/symphony-alpha"
    );
    expect(toGitHubRepoPath("  Owner/Repo.js  ")).toBe("Owner/Repo.js");
  });

  it.each([
    ["empty", ""],
    ["filesystem root", "/"],
    ["a local-path remote", "my projects/repo"],
    ["a gitolite remote", "~user/repo"],
    ["a non-ASCII owner", "Grüne/repo"],
    ["a three-segment path", "group/subgroup/repo"],
    ["a single segment", "symphony-alpha"],
  ])("rejects %s — it cannot become a github.com URL", (_label, value) => {
    // Stricter than the display label on purpose: these are legitimate repo
    // LABELS (covered above) but would build a broken github.com link.
    expect(toGitHubRepoPath(value)).toBe(null);
  });
});

/**
 * ISS-4996 — an absent repository and a stored-but-unreadable one are different
 * facts, and the Sessions grid rendered both as the same word.
 */
describe("resolveSessionRepositoryDisplay (ISS-4996)", () => {
  it("resolves a real remote", () => {
    expect(
      resolveSessionRepositoryDisplay({
        repositoryFullName: "closedloop-ai/symphony-alpha",
      })
    ).toEqual({
      kind: SessionRepositoryDisplayKind.Resolved,
      label: "closedloop-ai/symphony-alpha",
    });
  });

  it("classifies SES-78746's both-null record as Absent, not Malformed", () => {
    expect(
      resolveSessionRepositoryDisplay({
        repositoryFullName: null,
        repo: null,
      }).kind
    ).toBe(SessionRepositoryDisplayKind.Absent);
  });

  it("classifies an omitted field as Absent — omission is not corruption", () => {
    expect(resolveSessionRepositoryDisplay({}).kind).toBe(
      SessionRepositoryDisplayKind.Absent
    );
  });

  it("classifies a stored value carrying no identity as Malformed", () => {
    for (const stored of ["", "   ", "/", "//"]) {
      expect(
        resolveSessionRepositoryDisplay({ repositoryFullName: stored }).kind
      ).toBe(SessionRepositoryDisplayKind.Malformed);
    }
  });

  it("gives null and an empty string DIFFERENT classifications", () => {
    expect(
      resolveSessionRepositoryDisplay({ repositoryFullName: null }).kind
    ).not.toBe(
      resolveSessionRepositoryDisplay({ repositoryFullName: "" }).kind
    );
  });

  it("still resolves when the malformed field has a good compatibility alias", () => {
    expect(
      resolveSessionRepositoryDisplay({
        repositoryFullName: "",
        repo: "owner/repo",
      })
    ).toEqual({
      kind: SessionRepositoryDisplayKind.Resolved,
      label: "owner/repo",
    });
  });
});
