import { NavReferrerSurface } from "@repo/app/shared/lib/nav-referrer";
import { describe, expect, it } from "vitest";
import { resolveBranchBackHref } from "../branch-back-href";

describe("resolveBranchBackHref", () => {
  const branchesHref = "/acme/branches";
  const sessionsHref = "/acme/sessions";

  it("returns the sessions href when arriving from a session cross-link", () => {
    expect(
      resolveBranchBackHref({
        branchesHref,
        from: NavReferrerSurface.Session,
        sessionsHref,
      })
    ).toBe(sessionsHref);
  });

  it("falls back to the branches href when no referrer is present", () => {
    expect(
      resolveBranchBackHref({ branchesHref, from: undefined, sessionsHref })
    ).toBe(branchesHref);
  });

  it("ignores a non-session referrer surface", () => {
    expect(
      resolveBranchBackHref({
        branchesHref,
        from: NavReferrerSurface.Branch,
        sessionsHref,
      })
    ).toBe(branchesHref);
  });

  it("keeps the branches href when the surface has no session list to return to", () => {
    expect(
      resolveBranchBackHref({
        branchesHref,
        from: NavReferrerSurface.Session,
        sessionsHref: undefined,
      })
    ).toBe(branchesHref);
  });
});
