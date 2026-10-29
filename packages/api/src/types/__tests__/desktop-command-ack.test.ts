import { describe, expect, it } from "vitest";
import {
  classifyDesktopCommandAckRejection,
  classifyDesktopCommandAckTimeout,
  DesktopCommandAckOutcome,
  DesktopCommandAckRejectionReason,
  knownDesktopCommandAckWireReasons,
  legacyDesktopCommandAckWireReasons,
  resolveDesktopCommandAckOutcome,
} from "../desktop-command-ack";
import { RELAY_PRESENCE_SILENCE_MS } from "../relay-heartbeat";

describe("classifyDesktopCommandAckRejection", () => {
  const cases: [string, DesktopCommandAckRejectionReason][] = [
    [
      "operationId/path mismatch",
      DesktopCommandAckRejectionReason.UnroutableOperation,
    ],
    [
      "onboarding not completed",
      DesktopCommandAckRejectionReason.OnboardingIncomplete,
    ],
    [
      "cloud commands paused by user",
      DesktopCommandAckRejectionReason.CommandsPaused,
    ],
    [
      "commandId is required",
      DesktopCommandAckRejectionReason.MissingCommandId,
    ],
    ["unsupported method", DesktopCommandAckRejectionReason.UnsupportedMethod],
    [
      "path must start with /api/gateway/",
      DesktopCommandAckRejectionReason.PathOutsideGateway,
    ],
    [
      "unauthorized: no keys authorized",
      DesktopCommandAckRejectionReason.SigningNoKeysAuthorized,
    ],
    [
      "unauthorized: unsigned command",
      DesktopCommandAckRejectionReason.SigningUnsignedCommand,
    ],
    [
      "unauthorized: unknown signing key",
      DesktopCommandAckRejectionReason.SigningUnknownKey,
    ],
    [
      "unauthorized: invalid signature",
      DesktopCommandAckRejectionReason.SigningInvalidSignature,
    ],
    [
      "unauthorized: stale or replayed command",
      DesktopCommandAckRejectionReason.SigningStaleOrReplayed,
    ],
    [
      "unauthorized: payload_mismatch",
      DesktopCommandAckRejectionReason.SigningPayloadMismatch,
    ],
    [
      "invalid github resync nudge payload",
      DesktopCommandAckRejectionReason.NudgePayloadInvalid,
    ],
    [
      "github resync nudge target context absent",
      DesktopCommandAckRejectionReason.NudgeContextAbsent,
    ],
    [
      "github resync nudge active target context unresolved",
      DesktopCommandAckRejectionReason.NudgeActiveContextUnresolved,
    ],
    [
      "github resync nudge compute target mismatch",
      DesktopCommandAckRejectionReason.NudgeComputeTargetMismatch,
    ],
    [
      "github resync nudge gateway mismatch",
      DesktopCommandAckRejectionReason.NudgeGatewayMismatch,
    ],
    [
      "invalid browser command key approval request payload",
      DesktopCommandAckRejectionReason.BrowserKeyApprovalPayloadInvalid,
    ],
    [
      "invalid browser command key revocation payload",
      DesktopCommandAckRejectionReason.BrowserKeyRevokePayloadInvalid,
    ],
    [
      "browser command key active target context unresolved",
      DesktopCommandAckRejectionReason.BrowserKeyActiveContextUnresolved,
    ],
    [
      "browser command key compute target mismatch",
      DesktopCommandAckRejectionReason.BrowserKeyComputeTargetMismatch,
    ],
    [
      "browser command key gateway mismatch",
      DesktopCommandAckRejectionReason.BrowserKeyGatewayMismatch,
    ],
    [
      "browser command key revocation failed",
      DesktopCommandAckRejectionReason.BrowserKeyRevokeFailed,
    ],
    // ISS-7486 retired, still accepted for a pre-split Desktop build.
    [
      "github resync nudge target context mismatch",
      DesktopCommandAckRejectionReason.NudgeContextMismatch,
    ],
    [
      "browser command key target context mismatch",
      DesktopCommandAckRejectionReason.BrowserKeyContextMismatch,
    ],
  ];

  it.each(cases)("folds %s to its own code", (wire, code) => {
    expect(classifyDesktopCommandAckRejection(wire)).toBe(code);
  });

  it("gives every known reason a DISTINCT code, so no reject path is lumped", () => {
    // The whole point of ISS-7486 is naming the dominant path; two reasons
    // sharing a code would hide which of them owns the rejections.
    const codes = cases.map(([, code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("covers every wire reason the fold table declares", () => {
    expect(new Set(cases.map(([wire]) => wire))).toEqual(
      new Set(knownDesktopCommandAckWireReasons())
    );
  });

  it("keeps the retired reasons folding to codes of their own", () => {
    // ISS-7486 split the two context reasons into the conditions each was
    // collapsing. They must not fold onto one of the split codes: a pre-split
    // build cannot say which condition it hit, and inheriting a split code
    // would publish a guess as a measurement. ISS-12784 retired the six
    // signing rejects and the browser command-key rejects, which installed
    // Desktops still send.
    const retired = legacyDesktopCommandAckWireReasons();
    expect(new Set(retired)).toEqual(
      new Set([
        "github resync nudge target context mismatch",
        "browser command key target context mismatch",
        "unauthorized: no keys authorized",
        "unauthorized: unsigned command",
        "unauthorized: unknown signing key",
        "unauthorized: invalid signature",
        "unauthorized: stale or replayed command",
        "unauthorized: payload_mismatch",
        "invalid browser command key approval request payload",
        "invalid browser command key revocation payload",
        "browser command key active target context unresolved",
        "browser command key compute target mismatch",
        "browser command key gateway mismatch",
        "browser command key revocation failed",
      ])
    );
    const retiredCodes = retired.map((reason) =>
      classifyDesktopCommandAckRejection(reason)
    );
    expect(retiredCodes).not.toContain(
      DesktopCommandAckRejectionReason.NudgeComputeTargetMismatch
    );
    expect(new Set(retiredCodes).size).toBe(retired.length);
  });

  it("declares every retired reason inside the full fold table", () => {
    const known = new Set(knownDesktopCommandAckWireReasons());
    expect(
      legacyDesktopCommandAckWireReasons().filter(
        (reason) => !known.has(reason)
      )
    ).toEqual([]);
  });

  it("maps an absent reason to unspecified, not unknown", () => {
    expect(classifyDesktopCommandAckRejection(undefined)).toBe(
      DesktopCommandAckRejectionReason.Unspecified
    );
  });

  it("maps a blank reason to unspecified", () => {
    expect(classifyDesktopCommandAckRejection("   ")).toBe(
      DesktopCommandAckRejectionReason.Unspecified
    );
  });

  it("maps an unrecognized reason to unknown rather than throwing or leaking it", () => {
    // A newer desktop build inventing a reason must not mint a metric tag.
    expect(classifyDesktopCommandAckRejection("some brand new reason")).toBe(
      DesktopCommandAckRejectionReason.Unknown
    );
  });

  it("does not resolve prototype keys to an inherited member", () => {
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(classifyDesktopCommandAckRejection(key)).toBe(
        DesktopCommandAckRejectionReason.Unknown
      );
    }
  });
});

/**
 * ISS-7223. The outcome literals below are written out rather than imported
 * from the module under test on purpose: importing the const object would make
 * every assertion agree with whatever the module currently says, including a
 * typo'd or renamed value. These strings are the Datadog tag values a dashboard
 * and a monitor query by name, so the duplication IS the test.
 */
describe("resolveDesktopCommandAckOutcome", () => {
  it("names an accepted ack `accepted`", () => {
    expect(resolveDesktopCommandAckOutcome(true)).toBe("accepted");
  });

  it("names a rejected ack `rejected`, never the timeout bucket", () => {
    const outcome = resolveDesktopCommandAckOutcome(false);

    expect(outcome).toBe("rejected");
    // The positive sibling of the negative: a rejection is a real, arrived ack,
    // so it must land in its own bucket and not inflate the never-arrived one.
    expect(outcome).not.toBe("timed_out");
  });

  it("reserves `timed_out` for the outcome no desktop can send", () => {
    // Nothing an ack payload carries may produce it — a desktop that acks has,
    // by definition, not timed out.
    expect(DesktopCommandAckOutcome.TimedOut).toBe("timed_out");
    expect([
      resolveDesktopCommandAckOutcome(true),
      resolveDesktopCommandAckOutcome(false),
    ]).not.toContain("timed_out");
  });
});

describe("classifyDesktopCommandAckTimeout", () => {
  it("calls a target silent past two presence heartbeats", () => {
    expect(
      classifyDesktopCommandAckTimeout({
        silentMs: RELAY_PRESENCE_SILENCE_MS,
        inFlightOnTarget: 0,
      })
    ).toBe("target_silent");
  });

  it("checks silence before in-flight work, so stranded rows do not read as busy", () => {
    // The disconnect-correlated half is the half the ticket exists to size. A
    // gone target's `accepted`/`running` rows are stranded, not busy, and
    // reading them as busy would move that half into the wrong bucket.
    expect(
      classifyDesktopCommandAckTimeout({
        silentMs: RELAY_PRESENCE_SILENCE_MS * 10,
        inFlightOnTarget: 4,
      })
    ).toBe("target_silent");
  });

  it("calls a live target with in-flight work busy, not a lost ack", () => {
    expect(
      classifyDesktopCommandAckTimeout({
        silentMs: 0,
        inFlightOnTarget: 1,
      })
    ).toBe("target_busy");
  });

  it("calls a live, idle target a lost ack", () => {
    const cause = classifyDesktopCommandAckTimeout({
      silentMs: RELAY_PRESENCE_SILENCE_MS - 1,
      inFlightOnTarget: 0,
    });

    expect(cause).toBe("target_present");
    expect(cause).not.toBe("target_busy");
  });

  it("reports an unreadable presence timestamp as unknown, never as present", () => {
    // A missing read is not a target that was there. Folding it into either
    // real cause would publish a split the data does not support.
    expect(
      classifyDesktopCommandAckTimeout({
        silentMs: undefined,
        inFlightOnTarget: 0,
      })
    ).toBe("target_unknown");
    expect(
      classifyDesktopCommandAckTimeout({
        silentMs: Number.NaN,
        inFlightOnTarget: 0,
      })
    ).toBe("target_unknown");
  });
});
