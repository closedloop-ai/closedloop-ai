import { describe, expect, it } from "vitest";
import {
  clampWindowBounds,
  rendererHashFromUrl,
  rendererRouteHash,
  rendererRouteOpenDecision,
  rendererUrlWithHash,
} from "../src/main/lifecycle/renderer-window-session-state.js";

describe("renderer window session state", () => {
  it("clamps restored bounds to the selected current display", () => {
    expect(
      clampWindowBounds(
        { x: 2500, y: -400, width: 1800, height: 1200 },
        { x: 0, y: 23, width: 1440, height: 877 }
      )
    ).toEqual({ x: 0, y: 23, width: 1440, height: 877 });
    expect(
      clampWindowBounds(
        { x: -1800, y: 80, width: 1200, height: 700 },
        { x: -1920, y: 0, width: 1920, height: 1080 }
      )
    ).toEqual({ x: -1800, y: 80, width: 1200, height: 700 });
  });

  it("preserves route hashes across bundled and development URLs", () => {
    expect(
      rendererUrlWithHash(
        "app://renderer/design-system/index.html",
        "#/sessions/session-1"
      )
    ).toBe("app://renderer/design-system/index.html#/sessions/session-1");
    expect(
      rendererUrlWithHash(
        "http://127.0.0.1:5173/path?bridge=token#old",
        "#/approvals"
      )
    ).toBe("http://127.0.0.1:5173/path?bridge=token#/approvals");
  });

  it("normalizes navigation payloads and rejects unrelated hashes", () => {
    expect(rendererRouteHash("sessions")).toBe("#/sessions");
    expect(rendererRouteHash("/settings?panel=desktop-app")).toBe(
      "#/settings?panel=desktop-app"
    );
    expect(
      rendererHashFromUrl(
        "app://renderer/design-system/index.html#/sessions/session-1"
      )
    ).toBe("#/sessions/session-1");
    expect(
      rendererHashFromUrl(
        "app://renderer/index.html#tab=sessions&sessionId=session-1"
      )
    ).toBe("#tab=sessions&sessionId=session-1");
    expect(rendererHashFromUrl("app://renderer/index.html")).toBe("");
    expect(rendererHashFromUrl("not a url")).toBe("");
  });

  it("uses an initial hash once, then queues later routes while loading", () => {
    expect(rendererRouteOpenDecision(false, "approvals")).toEqual({
      initialHash: "#/approvals",
      queuedRoute: null,
    });
    expect(rendererRouteOpenDecision(true, "/sessions/session-2")).toEqual({
      initialHash: null,
      queuedRoute: "/sessions/session-2",
    });
  });
});
