import {
  type AgentSessionDetail,
  AgentSessionState,
} from "@repo/api/src/types/agent-session";
import { DISPLAYED_SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  SESSION_STATUS_LABELS,
  SESSION_UNKNOWN_TOOLTIP,
} from "@repo/api/src/types/session-status-display";
import { describe, expect, it } from "vitest";
import {
  getStatusDisplay,
  UNKNOWN_STATUS_DISPLAY,
} from "../session-status-display";

// The wire value a server emits for a member added after this build shipped.
// The cast is the point: the TYPE forbids it, the wire does not.
const SKEWED_STATE =
  "INACTIVE_FROM_A_NEWER_SERVER" as AgentSessionDetail["state"];

describe("getStatusDisplay (ISS-4654)", () => {
  it("falls back on a missing entry, not merely on a falsy state", () => {
    expect(getStatusDisplay(SKEWED_STATE)).toBe(UNKNOWN_STATUS_DISPLAY);
  });

  it("keeps every recognized state on its own display", () => {
    for (const state of Object.values(AgentSessionState)) {
      const display = getStatusDisplay(state);
      expect(display).not.toBe(UNKNOWN_STATUS_DISPLAY);
      // A recognized state asserts a fact, so it carries no hedge disclosure.
      expect(display.tooltip).toBeUndefined();
    }
  });

  it("reads its label and disclosure from the canonical vocabulary", () => {
    expect(UNKNOWN_STATUS_DISPLAY.label).toBe(
      SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.UNKNOWN]
    );
    expect(UNKNOWN_STATUS_DISPLAY.tooltip).toBe(SESSION_UNKNOWN_TOOLTIP);
  });

  it("does not share its glyph with any state this build recognizes", () => {
    // In the expanded Status row the icon is the ONE non-text signal, so
    // "unknown" and a real state (CircleDashed = "Awaiting your approval") must
    // not share a glyph. Iterating the whole enum means a future state that
    // reaches for the same one fails here rather than in review.
    for (const state of Object.values(AgentSessionState)) {
      expect(getStatusDisplay(state).icon).not.toBe(
        UNKNOWN_STATUS_DISPLAY.icon
      );
    }
  });
});
