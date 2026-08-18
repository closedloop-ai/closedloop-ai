/**
 * Auth-error code classification (ISS-5095, split by ISS-5118).
 *
 * The whole point of these codes is that two failures which used to arrive as
 * an indistinguishable 403 now say which question they answered. `OrgForbidden`
 * is a decision — Clerk said "not a member" — and re-authenticating is the
 * user's way out. `OrgUnverifiable` is an outage — Clerk said nothing at all —
 * and re-authenticating cannot help, so it must NOT reach the re-auth surface.
 *
 * Pinned here rather than only through the query boundary. The boundary keys on
 * the CODE alone (each code carries its own transport — 403 for `OrgForbidden`,
 * 503 for `OrgUnverifiable`), so this classification is the only thing standing
 * between a mis-labelled code and the wrong recovery affordance.
 */

import { describe, expect, it } from "vitest";
import { AuthErrorCode, isSessionAuthErrorCode } from "../auth-error.js";

describe("isSessionAuthErrorCode", () => {
  it("treats a genuine org denial as a session failure", () => {
    expect(isSessionAuthErrorCode(AuthErrorCode.OrgForbidden)).toBe(true);
  });

  it("does NOT treat an unverifiable org as a session failure", () => {
    // An identity-provider outage is an availability failure. Classifying it as
    // a session failure would put the user in front of a "sign in again" card
    // for a condition signing in again cannot fix.
    expect(isSessionAuthErrorCode(AuthErrorCode.OrgUnverifiable)).toBe(false);
  });

  it("does not recognize an unknown or absent code", () => {
    expect(isSessionAuthErrorCode("some_other_code")).toBe(false);
    expect(isSessionAuthErrorCode(undefined)).toBe(false);
  });
});
