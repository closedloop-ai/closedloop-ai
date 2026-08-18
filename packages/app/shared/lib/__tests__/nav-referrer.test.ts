import { describe, expect, it } from "vitest";
import {
  NAV_FROM_PARAM,
  NavReferrerSurface,
  resolveNavReferrerSurface,
  withNavReferrer,
} from "../nav-referrer";

describe("resolveNavReferrerSurface", () => {
  it("accepts the known session referrer surface", () => {
    expect(resolveNavReferrerSurface(NavReferrerSurface.Session)).toBe(
      NavReferrerSurface.Session
    );
  });

  it("accepts the known branch referrer surface", () => {
    expect(resolveNavReferrerSurface(NavReferrerSurface.Branch)).toBe(
      NavReferrerSurface.Branch
    );
  });

  it("rejects an unknown value so callers keep their static back behavior", () => {
    expect(resolveNavReferrerSurface("https://evil.example")).toBeUndefined();
    expect(resolveNavReferrerSurface("/absolute/path")).toBeUndefined();
    expect(resolveNavReferrerSurface("dashboard")).toBeUndefined();
  });

  it("treats absent referrers as undefined", () => {
    expect(resolveNavReferrerSurface(null)).toBeUndefined();
    expect(resolveNavReferrerSurface(undefined)).toBeUndefined();
    expect(resolveNavReferrerSurface("")).toBeUndefined();
  });
});

describe("withNavReferrer", () => {
  it("appends the referrer param to a query-less href", () => {
    expect(
      withNavReferrer("/org/branches/b-1", NavReferrerSurface.Session)
    ).toBe(`/org/branches/b-1?${NAV_FROM_PARAM}=${NavReferrerSurface.Session}`);
  });

  it("appends with & when the href already carries a query string", () => {
    expect(
      withNavReferrer(
        "/org/branches/b-1?tab=sessions-timeline",
        NavReferrerSurface.Session
      )
    ).toBe(
      `/org/branches/b-1?tab=sessions-timeline&${NAV_FROM_PARAM}=${NavReferrerSurface.Session}`
    );
  });
});
