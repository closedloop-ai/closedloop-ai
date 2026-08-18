import { describe, expect, it } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import type { DesktopBrowserSignInFailure } from "../../types/desktop-api";
import {
  signInFailureMessage,
  signInPendingMessage,
} from "../desktop-sign-in-copy";

const NETWORK_BLAME = /connection|network|offline/i;
const SECRET_LEAK = /sk_live|token|Bearer/i;

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

/**
 * ISS-5301: the FAILURE half of the same shared copy, which had no coverage.
 * The Settings Account tab and the Sessions KPI-card sign-in CTA both read it,
 * so a missing arm shows the wrong reason in two places at once — and, unlike
 * the pending copy above, these strings are what a user acts on to recover.
 */

const ALL_FAILURE_REASONS_MAP: Record<DesktopBrowserSignInFailure, true> = {
  unavailable: true,
  already_in_progress: true,
  start_failed: true,
  open_failed: true,
  redirect_timeout: true,
  state_mismatch: true,
  expired: true,
  cancelled: true,
  exchange_failed: true,
};
const ALL_FAILURE_REASONS = Object.keys(
  ALL_FAILURE_REASONS_MAP
) as DesktopBrowserSignInFailure[];

describe("signInFailureMessage", () => {
  it("names the local setup failure without blaming the network", () => {
    // `start_failed` is a keystore / loopback-listener problem: pointing the
    // user at their connection would send them to fix the wrong thing.
    const message = signInFailureMessage("start_failed");

    expect(message).toBe(
      "Couldn't start sign-in. Please try again — restart the app if it keeps failing."
    );
    expect(message).not.toMatch(NETWORK_BLAME);
  });

  it("maps each remaining known reason to its own copy", () => {
    expect(signInFailureMessage("open_failed")).toBe(
      "Couldn't open your browser. Try again."
    );
    expect(signInFailureMessage("redirect_timeout")).toBe(
      "Sign-in timed out waiting for your browser. Try again."
    );
    expect(signInFailureMessage("state_mismatch")).toBe(
      "The sign-in response failed a security check. Try again."
    );
    expect(signInFailureMessage("expired")).toBe(
      "The sign-in request expired. Try again."
    );
    expect(signInFailureMessage("exchange_failed")).toBe(
      "Sign-in completed but credentials couldn't be established. Try again."
    );
    expect(signInFailureMessage("already_in_progress")).toBe(
      "A sign-in is already in progress."
    );
  });

  it("falls back for a reason with no dedicated copy", () => {
    // `unavailable` and `cancelled` have no arm — `cancelled` on purpose, since
    // callers suppress an explicit cancel before reaching here.
    expect(signInFailureMessage("unavailable")).toBe(
      "Sign-in isn't available right now. Try again."
    );
    expect(signInFailureMessage("cancelled")).toBe(
      "Sign-in isn't available right now. Try again."
    );
  });

  it("gives every reason a non-empty, actionable message", () => {
    for (const reason of ALL_FAILURE_REASONS) {
      const message = signInFailureMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      // Secret-free: no reason may surface a code, token, or raw error.
      expect(message).not.toMatch(SECRET_LEAK);
    }
  });
});
