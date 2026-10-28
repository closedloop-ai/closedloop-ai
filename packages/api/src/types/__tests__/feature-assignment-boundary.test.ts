import { describe, expect, it } from "vitest";
import { readFeatureAssignment } from "../feature-assignment-boundary";

/**
 * ISS-8372 — the boundary read a feature assignment gets after crossing a
 * process, a wire, or a structured clone.
 *
 * Delivery names are written-out literals for the reason the fold suite states:
 * an expectation derived from `FeatureAssignmentDelivery` cannot notice that
 * const changing underneath it.
 */
const SUBJECT = "user_boundary_1";

describe("readFeatureAssignment", () => {
  it("adopts a well-formed assignment for the requested subject", () => {
    expect(
      readFeatureAssignment(
        { userId: SUBJECT, resolved: true, flags: { "some-gate": true } },
        SUBJECT
      )
    ).toEqual({ delivery: "assigned", flags: { "some-gate": true } });
  });

  /**
   * THE VERSION-SKEW CASE, and the reason this schema is not `.strict()`.
   *
   * An already-installed Desktop build and a newer API do not upgrade together.
   * Under `.strict()` an additive optional field the receiver has never heard of
   * rejects the WHOLE payload, which reads as malformed, closes every gate, and
   * re-closes them on every retry — for a user whose only offence is running
   * yesterday's build. The unknown key is dropped and the assignment survives.
   */
  it("keeps the assignment when a newer peer adds a field this build has never seen", () => {
    expect(
      readFeatureAssignment(
        {
          userId: SUBJECT,
          resolved: true,
          flags: { "some-gate": true },
          evaluatedAt: "2026-08-28T00:00:00.000Z",
          cohort: { name: "canary" },
        },
        SUBJECT
      )
    ).toEqual({ delivery: "assigned", flags: { "some-gate": true } });
  });

  it("survives the structured clone the IPC bridge performs", () => {
    const payload = {
      userId: SUBJECT,
      resolved: true,
      flags: { "some-gate": true },
    };

    expect(readFeatureAssignment(structuredClone(payload), SUBJECT)).toEqual({
      delivery: "assigned",
      flags: { "some-gate": true },
    });
  });

  it("reports a payload whose shape it cannot read as MALFORMED", () => {
    expect(
      // A non-boolean verdict. Coercing it would publish a gate state nobody
      // evaluated; rejecting the payload closes everything instead.
      readFeatureAssignment(
        { userId: SUBJECT, resolved: true, flags: { "some-gate": "yes" } },
        SUBJECT
      )
    ).toEqual({ delivery: "malformed", flags: {} });
  });

  it("reports an assignment evaluated for another account as STALE, not as an answer", () => {
    expect(
      readFeatureAssignment(
        {
          userId: "user_previous_account",
          resolved: true,
          // Pre-seeded OPEN so a boundary that read the flags before checking
          // the subject would hand this account the other one's rollout.
          flags: { "some-gate": true },
        },
        SUBJECT
      )
    ).toEqual({ delivery: "identity-mismatch", flags: {} });
  });

  it("accepts any evaluated subject while anonymous, because there is none to mismatch", () => {
    expect(
      readFeatureAssignment(
        {
          userId: "anon_distinct_id",
          resolved: true,
          flags: { "some-gate": true },
        },
        null
      )
    ).toEqual({ delivery: "assigned", flags: { "some-gate": true } });
  });

  it("reports an unevaluated assignment as a failed evaluation, never as all-off", () => {
    expect(
      readFeatureAssignment(
        { userId: SUBJECT, resolved: false, flags: {} },
        SUBJECT
      )
    ).toEqual({ delivery: "evaluation-failed", flags: {} });
  });

  it("carries the organization marker only when the payload has a readable one", () => {
    const flags = { "group-gate": true };
    expect(
      readFeatureAssignment(
        {
          userId: SUBJECT,
          resolved: true,
          flags,
          organizationEvaluated: ["group-gate"],
        },
        SUBJECT
      )
    ).toEqual({
      delivery: "assigned",
      flags,
      organizationEvaluated: ["group-gate"],
    });
    expect(
      readFeatureAssignment(
        { userId: SUBJECT, resolved: true, flags, organizationEvaluated: 7 },
        SUBJECT
      )
    ).toEqual({ delivery: "assigned", flags });
  });

  it("reports an absent payload as a failed evaluation", () => {
    expect(readFeatureAssignment(null, SUBJECT)).toEqual({
      delivery: "evaluation-failed",
      flags: {},
    });
  });
});
