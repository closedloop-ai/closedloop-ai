/**
 * ISS-9743 — the desktop build identity has to SURVIVE ingest.
 *
 * `desktopTelemetryEventInputSchema.trace` is a plain `z.object`, so Zod's
 * default `.strip` drops any key it does not declare — no rejection, no log.
 * A build identity the desktop emits and the wire schema does not know would
 * therefore vanish on every event while both sides' own tests stayed green.
 * These assertions are that boundary.
 */

import { describe, expect, it } from "vitest";
import { buildTelemetryTraceContext } from "../telemetry/context";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/**
 * Pinned independently of the schema and of the desktop producer: a fixture
 * that read its expectation off the module under test would survive that
 * module being emptied.
 */
const SOURCE_BUILD_COMMIT = "3fc32f406200b2a46b2a477f2f045527794f24bd";
const OTHER_SOURCE_BUILD_COMMIT = "34dfd645e5b5005755deb1f302d511bf70a818a1";
const SERIES_ANCHOR_VERSION = "0.16.69";

/**
 * Strings a desktop can hold in `BUILD_COMMIT_HASH` that name no build.
 * `"unknown"` is the specific one the ticket's own resolver rejects.
 */
const REJECTED_BUILD_COMMIT_STRINGS: readonly string[] = [
  "unknown",
  "",
  // A real but abbreviated sha: accepting it would let two spellings of one
  // commit become two build dimensions.
  "3fc32f4",
  SOURCE_BUILD_COMMIT.toUpperCase(),
  `${SOURCE_BUILD_COMMIT}0`,
  SERIES_ANCHOR_VERSION,
];

/**
 * What an authenticated client can actually put on the WIRE.
 *
 * The producer's type says `string | undefined`, but a type constrains no wire:
 * at ingest the non-strings below are reachable too, from a version-skewed
 * client or from one that simply chose to send them, and they are exactly what
 * a hand-rolled check on the shape would have let through.
 */
const REJECTED_WIRE_BUILD_COMMITS: readonly unknown[] = [
  ...REJECTED_BUILD_COMMIT_STRINGS,
  42,
  null,
  { sha: SOURCE_BUILD_COMMIT },
];

function desktopWireEvent(trace: Record<string, unknown>) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.SyncDurableCursorStalled,
    severity: "error",
    timestamp: "2026-09-08T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "019d271f-12d1-73ae-924b-479c5f3f2395",
      ...trace,
    },
  };
}

describe("desktop build identity survives telemetry ingest (ISS-9743)", () => {
  it("keeps two source builds at one version distinguishable across the wire", () => {
    const parsedA = desktopTelemetryEventSchema.safeParse(
      desktopWireEvent({
        desktopClientVersion: SERIES_ANCHOR_VERSION,
        desktopBuildCommit: SOURCE_BUILD_COMMIT,
      })
    );
    const parsedB = desktopTelemetryEventSchema.safeParse(
      desktopWireEvent({
        desktopClientVersion: SERIES_ANCHOR_VERSION,
        desktopBuildCommit: OTHER_SOURCE_BUILD_COMMIT,
      })
    );

    expect(parsedA.success).toBe(true);
    expect(parsedB.success).toBe(true);
    const commitA = parsedA.success
      ? parsedA.data.trace.desktopBuildCommit
      : undefined;
    const commitB = parsedB.success
      ? parsedB.data.trace.desktopBuildCommit
      : undefined;

    // Not stripped...
    expect(commitA).toBe(SOURCE_BUILD_COMMIT);
    expect(commitB).toBe(OTHER_SOURCE_BUILD_COMMIT);
    // ...and still telling the two builds apart after the transform, which the
    // version alone cannot do: both events carry the same series anchor.
    expect(commitA).not.toBe(commitB);
  });

  it("leaves the key off the parsed trace when the client sent none", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      desktopWireEvent({ desktopClientVersion: SERIES_ANCHOR_VERSION })
    );

    expect(parsed.success).toBe(true);
    // An older desktop build sends nothing here. It must be attributable by
    // OMISSION rather than by a placeholder that collides with a real value.
    expect(
      parsed.success && Object.hasOwn(parsed.data.trace, "desktopBuildCommit")
    ).toBe(false);
  });
});

describe("desktop build identity is validated at the wire boundary (ISS-9743)", () => {
  it("records nothing for a value that is not a full commit sha", () => {
    const outcomes = REJECTED_WIRE_BUILD_COMMITS.map((desktopBuildCommit) => {
      const parsed = desktopTelemetryEventSchema.safeParse(
        desktopWireEvent({
          desktopClientVersion: SERIES_ANCHOR_VERSION,
          desktopBuildCommit,
        })
      );
      return {
        sent: desktopBuildCommit,
        // Not `=== undefined`: an own key holding `undefined` is still a key,
        // and the contract is OMISSION. A `null` or a `"unknown"` placeholder
        // would be a build dimension that names a build nobody built.
        recorded: parsed.success
          ? Object.hasOwn(parsed.data.trace, "desktopBuildCommit")
          : "event rejected",
      };
    });

    expect(outcomes).toEqual(
      REJECTED_WIRE_BUILD_COMMITS.map((sent) => ({ sent, recorded: false }))
    );
  });

  it("keeps the rest of the span when a skewed client sends a bad commit", () => {
    // The version-skew property. Every installed desktop vintage is already
    // sending this key, so a boundary that rejected the whole event on a bad
    // value would drop the unit outright — and re-drop it on every retry.
    const parsed = desktopTelemetryEventSchema.safeParse(
      desktopWireEvent({
        desktopClientVersion: SERIES_ANCHOR_VERSION,
        desktopBuildCommit: "unknown",
      })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.trace).toEqual({
      commandId: "",
      operationId: "",
      computeTargetId: "019d271f-12d1-73ae-924b-479c5f3f2395",
      desktopClientVersion: SERIES_ANCHOR_VERSION,
      loopSessionId: undefined,
    });
  });

  it("still carries a real commit through the tightened boundary", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      desktopWireEvent({ desktopBuildCommit: SOURCE_BUILD_COMMIT })
    );

    expect(parsed.success && parsed.data.trace.desktopBuildCommit).toBe(
      SOURCE_BUILD_COMMIT
    );
  });
});

describe("buildTelemetryTraceContext build identity (ISS-9743)", () => {
  it("carries an explicit commit through", () => {
    expect(
      buildTelemetryTraceContext({ desktopBuildCommit: SOURCE_BUILD_COMMIT })
        .desktopBuildCommit
    ).toBe(SOURCE_BUILD_COMMIT);
  });

  it("omits the key entirely rather than defaulting it", () => {
    expect(
      Object.hasOwn(buildTelemetryTraceContext({}), "desktopBuildCommit")
    ).toBe(false);
  });

  it("omits a commit that is not a full sha, on the last hop before the sink", () => {
    const outcomes = REJECTED_BUILD_COMMIT_STRINGS.map(
      (desktopBuildCommit) => ({
        sent: desktopBuildCommit,
        recorded: Object.hasOwn(
          buildTelemetryTraceContext({ desktopBuildCommit }),
          "desktopBuildCommit"
        ),
      })
    );

    expect(outcomes).toEqual(
      REJECTED_BUILD_COMMIT_STRINGS.map((sent) => ({ sent, recorded: false }))
    );
  });
});
