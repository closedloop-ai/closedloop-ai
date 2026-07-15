import { describe, expect, it } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { signInPendingMessage } from "../desktop-sign-in-copy";

/**
 * FEA-2794: `signInPendingMessage` maps the in-flight desktop auth status to the
 * user-facing sign-in copy shared by the Settings Account tab and the app-wide
 * session-expired banner, keeping the two surfaces in sync. Neither consumer's
 * test asserts the status→string mapping today (the banner test only renders
 * `refresh_failed`, which hits the fallback, and never checks the text), so a
 * mis-mapped status would silently regress copy on both surfaces. Pin the two
 * distinguished statuses plus the fallback for every other status.
 */
describe("signInPendingMessage", () => {
  it("returns the exchanging copy while redeeming the auth code", () => {
    expect(signInPendingMessage("exchanging")).toBe("Finishing sign-in...");
  });

  it("returns the awaiting-redirect copy while the browser is open", () => {
    expect(signInPendingMessage("awaiting_redirect")).toBe(
      "Waiting for you to finish in your browser..."
    );
  });

  it("falls back to the opening copy for every other status", () => {
    const distinguished = new Set<DesktopAuthStatus>([
      "exchanging",
      "awaiting_redirect",
    ]);
    const others = Object.values(DesktopAuthStatus).filter(
      (status) => !distinguished.has(status)
    );
    // Sanity: real statuses actually exercise the fallback branch.
    expect(others.length).toBeGreaterThan(0);
    for (const status of others) {
      expect(signInPendingMessage(status)).toBe("Opening your browser...");
    }
  });
});
