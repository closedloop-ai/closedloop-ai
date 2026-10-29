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

  it("drops only the corrupt tile position from a shared layout", () => {
    // ISS-8738: a hand-built token with one h:0 entry used to fail the whole
    // decode and silently fall back to the recipient's own dashboard.
    const token = encodeSharedDashboard({
      ...SNAPSHOT,
      layout: {
        ...SNAPSHOT.layout,
        "kpi:merged": { x: 0, y: 0, w: 12, h: 0 },
      },
    });

    expect(decodeSharedDashboard(token)).toEqual({
      ...SNAPSHOT,
      layout: { "chart:prTrend": SNAPSHOT.layout["chart:prTrend"] },
    });
  });

  it("decodes an all-invalid layout as empty", () => {
    const token = btoa(
      JSON.stringify({
        t: SNAPSHOT.tiles,
        l: { "kpi:merged": { x: 0, y: 0, w: 0, h: 2 }, "chart:prTrend": 4 },
      })
    );
    expect(decodeSharedDashboard(token)).toEqual({
      tiles: SNAPSHOT.tiles,
      layout: {},
      settings: {},
    });
  });

  it("returns null when the layout is not a plain object", () => {
    const token = btoa(JSON.stringify({ t: SNAPSHOT.tiles, l: "nope" }));
    expect(decodeSharedDashboard(token)).toBeNull();
  });
});
