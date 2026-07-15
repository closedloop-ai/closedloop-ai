import { describe, expect, it } from "vitest";
import { deriveStatusIdentity } from "../use-live-pr-status";

describe("deriveStatusIdentity", () => {
  it("splits a clean owner/name slug + PR number into an identity", () => {
    expect(
      deriveStatusIdentity({
        repoFullName: "octo/repo",
        prNumber: 42,
        multiPrWarning: false,
      })
    ).toEqual({ owner: "octo", repo: "repo", prNumber: 42 });
  });

  it("gates (null) on a multi-PR warning — ambiguous attribution", () => {
    expect(
      deriveStatusIdentity({
        repoFullName: "octo/repo",
        prNumber: 42,
        multiPrWarning: true,
      })
    ).toBeNull();
  });

  it("gates when there is no repo identity or no PR number", () => {
    expect(
      deriveStatusIdentity({
        repoFullName: null,
        prNumber: 42,
        multiPrWarning: false,
      })
    ).toBeNull();
    expect(
      deriveStatusIdentity({
        repoFullName: "octo/repo",
        prNumber: null,
        multiPrWarning: false,
      })
    ).toBeNull();
  });

  it("falls back to a matching GitHub PR URL when repo identity is missing", () => {
    expect(
      deriveStatusIdentity({
        repoFullName: null,
        prUrl: "https://github.com/octo/repo/pull/42",
        prNumber: 42,
        multiPrWarning: false,
      })
    ).toEqual({ owner: "octo", repo: "repo", prNumber: 42 });
  });

  it("gates a mismatched PR URL instead of guessing the repository", () => {
    expect(
      deriveStatusIdentity({
        repoFullName: null,
        prUrl: "https://github.com/octo/repo/pull/43",
        prNumber: 42,
        multiPrWarning: false,
      })
    ).toBeNull();
  });

  it("gates a non owner/name slug rather than mis-splitting it", () => {
    expect(
      deriveStatusIdentity({
        repoFullName: "justaname",
        prNumber: 1,
        multiPrWarning: false,
      })
    ).toBeNull();
    expect(
      deriveStatusIdentity({
        repoFullName: "too/many/parts",
        prNumber: 1,
        multiPrWarning: false,
      })
    ).toBeNull();
  });
});
