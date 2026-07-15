import { describe, expect, it } from "vitest";
import {
  decodeSharedDashboard,
  encodeSharedDashboard,
} from "../share-dashboard";
import { SHARED_DASHBOARD_FIXTURE as SNAPSHOT } from "./fixtures";

// base64url tokens must avoid the standard-base64 chars that need escaping.
const NON_URL_SAFE_BASE64 = /[+/=]/;

describe("share-dashboard codec", () => {
  it("round-trips a customized dashboard snapshot", () => {
    const token = encodeSharedDashboard(SNAPSHOT);
    expect(decodeSharedDashboard(token)).toEqual(SNAPSHOT);
  });

  it("produces a URL-safe token free of characters that need escaping", () => {
    const token = encodeSharedDashboard(SNAPSHOT);
    expect(token).toBe(encodeURIComponent(token));
    expect(token).not.toMatch(NON_URL_SAFE_BASE64);
  });

  it("defaults settings to an empty record when omitted from the token", () => {
    const token = encodeSharedDashboard({
      ...SNAPSHOT,
      settings: {},
    });
    expect(decodeSharedDashboard(token)?.settings).toEqual({});
  });

  it("returns null for absent params", () => {
    expect(decodeSharedDashboard(null)).toBeNull();
    expect(decodeSharedDashboard(undefined)).toBeNull();
    expect(decodeSharedDashboard("")).toBeNull();
  });

  it("returns null for malformed base64 or JSON", () => {
    expect(decodeSharedDashboard("!!!not-base64!!!")).toBeNull();
    expect(decodeSharedDashboard(btoa("{not json"))).toBeNull();
  });

  it("returns null when the decoded payload fails schema validation", () => {
    const badShape = btoa(JSON.stringify({ t: "not-an-array", l: {} }));
    expect(decodeSharedDashboard(badShape)).toBeNull();
  });
});
