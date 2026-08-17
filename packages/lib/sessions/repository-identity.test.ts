import { describe, expect, it } from "vitest";
import { normalizeRepositoryIdentity } from "./repository-identity.ts";

describe("normalizeRepositoryIdentity (ISS-4996)", () => {
  it("preserves the stored spelling verbatim, trimming only", () => {
    // The Repository facet groups on the STORED value, so a normalizer that
    // lowercased or rewrote it would put the label out of sync with the option
    // it sits under. (`normalizeRepoFullName` in packages/api/src/types/branch.ts
    // is the artifact-KEY normalizer and DOES lowercase — different lane.)
    expect(normalizeRepositoryIdentity("Owner/Repo.js")).toBe("Owner/Repo.js");
    expect(
      normalizeRepositoryIdentity("  closedloop-ai/symphony-alpha  ")
    ).toBe("closedloop-ai/symphony-alpha");
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["filesystem root", "/"],
    ["repeated slashes", "//"],
    ["slashes and whitespace", "  / "],
  ])("rejects %s — it carries no identity", (_label, value) => {
    expect(normalizeRepositoryIdentity(value)).toBe(null);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("returns null for %s", (_label, value) => {
    expect(normalizeRepositoryIdentity(value)).toBe(null);
  });

  // `resolveRepoFullName` (apps/desktop/src/server/operations/git-helpers.ts)
  // captures the one-slash tail of ANY origin remote — no host check, no
  // character class — so these all resolve and persist for real users. An
  // `owner/repo` char-class guard here would reject a repository that genuinely
  // resolved, AND disagree with the Repository facet, which still offers the
  // stored value.
  it.each([
    ["a local-path remote", "my projects/repo"],
    ["a gitolite remote", "~user/repo"],
    ["a non-ASCII self-hosted owner", "Grüne/repo"],
    ["a deeper self-hosted path", "group/subgroup/repo"],
    ["a single-segment name", "symphony-alpha"],
  ])("accepts %s rather than rejecting it as malformed", (_label, value) => {
    expect(normalizeRepositoryIdentity(value)).toBe(value);
  });
});
