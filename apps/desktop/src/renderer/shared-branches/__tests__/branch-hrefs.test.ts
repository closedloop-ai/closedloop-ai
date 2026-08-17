import {
  BRANCH_DETAIL_TAB_PARAM,
  BranchDetailTabParam,
} from "@repo/api/src/types/notification-routes";
import { describe, expect, it } from "vitest";
import {
  desktopBranchDetailHref,
  desktopBranchSessionsHref,
} from "../branch-hrefs";

describe("desktopBranchDetailHref", () => {
  it("builds an unprefixed branch-detail path the port Link resolves", () => {
    // Unprefixed (no leading `#`): the desktop port Link matches this through
    // the route table on left-click and hash-prefixes the rendered anchor
    // itself (FEA-4051).
    expect(desktopBranchDetailHref({ id: "b-1" })).toBe("/branches/b-1");
  });

  it("encodes ids containing path separators", () => {
    // A composite `owner/repo::branch` id must stay encoded so the route
    // table's decodeSegment recovers it intact.
    expect(desktopBranchDetailHref({ id: "owner/repo::feat/x" })).toBe(
      "/branches/owner%2Frepo%3A%3Afeat%2Fx"
    );
  });
});

describe("desktopBranchSessionsHref", () => {
  const SESSIONS_TAB = `${BRANCH_DETAIL_TAB_PARAM}=${BranchDetailTabParam.SessionsTimeline}`;

  it("appends the sessions-timeline tab to the branch-detail path", () => {
    expect(desktopBranchSessionsHref({ id: "b-1" })).toBe(
      `/branches/b-1?${SESSIONS_TAB}`
    );
  });

  it("encodes the branch id the same way the Name link does", () => {
    // The Linked Sessions count and the Name link in the same row must resolve
    // to the SAME branch. Desktop branch ids come out of `encodeBranchId`
    // already percent-encoded (`owner%2Fweb::feature`), and the desktop route
    // decodes each path segment once — so the id must be encoded here (built off
    // `branchDetailHref`) or the segment would decode to an id we never issued
    // and land on the not-found detail state.
    const id = "owner%2Fweb::feature";
    expect(desktopBranchSessionsHref({ id })).toBe(
      `${desktopBranchDetailHref({ id })}?${SESSIONS_TAB}`
    );
    // The `::` and the already-present `%` both survive a single route decode.
    expect(desktopBranchSessionsHref({ id })).toBe(
      `/branches/owner%252Fweb%3A%3Afeature?${SESSIONS_TAB}`
    );
  });
});
