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
