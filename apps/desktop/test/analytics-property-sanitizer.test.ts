import assert from "node:assert/strict";
import {
  DESKTOP_ANALYTICS_ARRAY_ELEMENT_MAX_LENGTH,
  DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS,
  DESKTOP_ANALYTICS_ARRAY_PROPERTY_KEYS,
} from "@repo/api/src/types/desktop-analytics";
import {
  OnboardingAccountMode,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { describe, test } from "vitest";
import { sanitizeAnalyticsProperties } from "../src/main/telemetry/analytics-property-sanitizer.js";

describe("sanitizeAnalyticsProperties arrays (ISS-10502)", () => {
  test("clamps array elements to the ARRAY element cap and caps the item count", () => {
    const overLong = "x".repeat(
      DESKTOP_ANALYTICS_ARRAY_ELEMENT_MAX_LENGTH + 10
    );
    const overCap = Array.from(
      { length: DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS + 5 },
      (_, index) => `harness-${index}`
    );

    const sanitized = sanitizeAnalyticsProperties({
      harnesses_detected: [overLong],
      steps_skipped: overCap,
    });

    assert.deepEqual(sanitized.harnesses_detected, [
      overLong.slice(0, DESKTOP_ANALYTICS_ARRAY_ELEMENT_MAX_LENGTH),
    ]);
    assert.deepEqual(
      sanitized.steps_skipped,
      overCap.slice(0, DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS)
    );
  });

  test("drops non-string elements rather than coercing them", () => {
    const sanitized = sanitizeAnalyticsProperties({
      steps_skipped: ["account", 42, null, "invite_team"],
    });

    assert.deepEqual(sanitized.steps_skipped, ["account", "invite_team"]);
  });

  test("drops an array on a primitive-valued key rather than shaping it (#7748 review)", () => {
    // The relay refuses a payload WHOLE on an array outside the declared array
    // keys, so passing a shaped array through would cost the entire event —
    // the opposite of this function's purpose.
    const sanitized = sanitizeAnalyticsProperties({
      flow_id: "flow-1",
      step: ["welcome"],
    });

    assert.deepEqual(sanitized, { flow_id: "flow-1" });
  });

  test("leaves an in-bounds string array untouched", () => {
    const sanitized = sanitizeAnalyticsProperties({
      harnesses_detected: ["Claude Code", "Codex"],
    });

    assert.deepEqual(sanitized.harnesses_detected, ["Claude Code", "Codex"]);
  });
});

describe("sanitizeAnalyticsProperties account_mode (ISS-10913)", () => {
  // The contract half of ISS-10913, landed and deployed AHEAD of the emitter.
  // `account_mode` was declared scalar while it was reserved, so the array
  // branch below dropped it outright and the cloud API would have rejected the
  // whole event. All THREE readers key off that one declaration — this
  // sanitizer, the renderer-event IPC guard, and the API schema — so it has to
  // be true before anything produces a value (tamsinb on #7793/#7815).
  test("carries an account_mode array through instead of dropping it", () => {
    const sanitized = sanitizeAnalyticsProperties({
      [OnboardingAnalyticsProperty.AccountMode]: [
        OnboardingAccountMode.Created,
        OnboardingAccountMode.SignedIn,
      ],
    });

    assert.deepEqual(sanitized, {
      [OnboardingAnalyticsProperty.AccountMode]: [
        OnboardingAccountMode.Created,
        OnboardingAccountMode.SignedIn,
      ],
    });
  });

  test("carries a single-value account_mode array through", () => {
    const sanitized = sanitizeAnalyticsProperties({
      [OnboardingAnalyticsProperty.AccountMode]: [
        OnboardingAccountMode.SignedIn,
      ],
    });

    assert.deepEqual(sanitized[OnboardingAnalyticsProperty.AccountMode], [
      OnboardingAccountMode.SignedIn,
    ]);
  });

  test("the key is declared array-valued, which is what keeps it off the drop path", () => {
    // Pins the declaration itself: flipping it back silently re-introduces the
    // drop, and the assertions above would then read as a sanitizer bug rather
    // than the contract regression it actually is.
    assert.equal(
      DESKTOP_ANALYTICS_ARRAY_PROPERTY_KEYS.has(
        OnboardingAnalyticsProperty.AccountMode
      ),
      true
    );
  });
});
