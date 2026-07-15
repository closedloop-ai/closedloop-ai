import { DesktopAnalyticsEventName } from "@repo/api/src/types/desktop-analytics";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_IDENTITY_PROPERTY_KEY_VALUES,
  parseDesktopAnalyticsPayload,
} from "./desktop-analytics-schema";

/**
 * FEA-2734 Phase 3 (PRD-510 FR11) — payload-supplied identity is ignored on the
 * ingest boundary; server-side attribution (org / user / target from the
 * authenticated API key) is authoritative. The desktop analytics parser is the
 * one ingest surface whose wire payload carries a freeform `properties` bag, so
 * it is where a client could try to smuggle an org identifier. This suite locks
 * in that every identity key is dropped rather than trusted, so a forged
 * `organization_id` can never reach — let alone override — the persisted event's
 * org stamp.
 */

const VALID_EVENT = DesktopAnalyticsEventName.CommandCompleted;
const OCCURRED_AT = "2026-07-14T10:00:00.000Z";

describe("parseDesktopAnalyticsPayload — FR11 identity attribution guard", () => {
  // Import the parser's own forbidden-key contract and assert every key is
  // dropped — so the coverage tracks the parser (add a key there, this test
  // demands it be enforced) rather than a hand-maintained list that can drift.
  it.each(
    FORBIDDEN_IDENTITY_PROPERTY_KEY_VALUES
  )("silently drops payload-supplied %s instead of trusting it", (identityKey) => {
    const result = parseDesktopAnalyticsPayload({
      event: VALID_EVENT,
      occurredAt: OCCURRED_AT,
      properties: {
        [identityKey]: "org-attacker-controlled",
        // A legitimate allowed property alongside it survives, proving the
        // drop is targeted at identity keys, not a blanket reject.
        outcome: "success",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The forged identity key never reaches the sanitized properties, so it
      // cannot influence the server-stamped org/user/target attribution.
      expect(result.payload.properties).not.toHaveProperty(identityKey);
      expect(result.payload.properties).toEqual({ outcome: "success" });
    }
  });

  it("rejects an unknown NON-identity property (no silent passthrough)", () => {
    const result = parseDesktopAnalyticsPayload({
      event: VALID_EVENT,
      occurredAt: OCCURRED_AT,
      properties: { not_a_real_property: "x" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("property_not_allowed");
    }
  });

  it("accepts a clean payload and preserves allowed properties", () => {
    const result = parseDesktopAnalyticsPayload({
      event: VALID_EVENT,
      occurredAt: OCCURRED_AT,
      properties: { outcome: "success", duration_ms: 42 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.properties).toEqual({
        outcome: "success",
        duration_ms: 42,
      });
    }
  });
});
