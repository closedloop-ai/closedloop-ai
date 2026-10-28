import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  type DisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_STATUS_DISPLAY,
  getStatusDisplay,
} from "../session-status-display";

// The wire value a server emits for a member added after this build shipped.
// The cast is the point: the TYPE forbids it, the wire does not.
const SKEWED_STATUS =
  "INACTIVE_FROM_A_NEWER_SERVER" as AgentSessionDetail["status"];

const ALL_STATUSES = Object.values(SESSION_STATUS) as DisplayedSessionStatus[];

/**
 * ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23/24) retired the two
 * display-only members (`stale`, `unknown`) this module used to carry a
 * tooltip for. `STATUS_DISPLAY_BY_STATUS` is now exactly the three lifecycle
 * entries, none of which carry a tooltip, and an unrecognized status falls
 * back to the Active entry rather than a dedicated Unknown one — rewritten
 * from the pre-ISS-10364 suite, which pinned that retired shape.
 */
describe("getStatusDisplay (ISS-7019)", () => {
  it("falls back to the Active entry on a missing entry, not a dedicated Unknown one", () => {
    expect(getStatusDisplay(SKEWED_STATUS)).toBe(FALLBACK_STATUS_DISPLAY);
    expect(FALLBACK_STATUS_DISPLAY.label).toBe(
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
    );
  });

  it("gives every status this build recognizes its own entry", () => {
    for (const status of ALL_STATUSES) {
      expect(getStatusDisplay(status).label).toBe(
        SESSION_STATUS_LABELS[status]
      );
    }
  });

  it("gives every status a distinct glyph", () => {
    // In the expanded Status row the icon is the ONE non-text signal, so no two
    // statuses may share it. Iterating the whole vocabulary means a future
    // member that reaches for a taken glyph fails here rather than in review.
    const icons = ALL_STATUSES.map((status) => getStatusDisplay(status).icon);
    expect(new Set(icons).size).toBe(ALL_STATUSES.length);
  });
});
