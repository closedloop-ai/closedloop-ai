import { describe, expect, it } from "vitest";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "./universal-artifact-status-flag";

/**
 * ISS-9304 — pins the VALUE this module exports, and only that.
 *
 * The value is what a PostHog flag gets created under, what the registration
 * ledger row attests, and what every future adapter's gate resolves; each of
 * those is hand-written where it lives, so an edit to the constant here orphans
 * them silently. That edit is exactly what this catches, and it is the whole of
 * what it catches. It does NOT read the ledger, so drift introduced on the
 * LEDGER side is out of its reach — `scripts/lint/posthog-flag-registration.test.ts`
 * owns that direction, pinning the row both against its own hand-written
 * `UNVERIFIED_ROWS` literal and, since the whitlockk review of PR #7022, against
 * THIS module's export: `the shipped constant resolves to the ledger row that
 * registers it` looks the row up by the constant rather than by a spelling of
 * it, so editing the export and this expectation in step no longer keeps the
 * pair green. Two literals agreeing is not the two artifacts agreeing, and that
 * cross-artifact case is what proves the latter.
 *
 * Spelled out rather than compared against the import on purpose: a test that
 * read its expectation from the constant it polices would stay green through
 * every rename of that constant's value.
 */
describe("the Universal Artifact Status rollout flag key", () => {
  it("still exports the exact key string this flag was registered under", () => {
    expect(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY).toBe(
      "universal-artifact-status"
    );
  });
});
