/**
 * ISS-9743 review — `trace.desktopBuildCommit` is a TRUST boundary.
 *
 * The desktop resolver only decides what THIS repo's desktop emits. The wire is
 * open: an authenticated client can put any string in the field, and whatever
 * arrives becomes a Datadog trace dimension — wrong build attribution if it is
 * a plausible-looking lie, unbounded metric cardinality if it is not.
 *
 * These assertions read the DOWNSTREAM CALL SHAPE. `handleTelemetryEvent` ends
 * at one `log.info("Desktop telemetry event received", …)`, and its `trace` is
 * the object that reaches the sink, so asserting on it is the only way to prove
 * the dimension is actually gone rather than merely unparsed somewhere upstream.
 */

import { log } from "@repo/observability/log";
import {
  TelemetryCategory,
  TelemetrySeverity,
} from "@repo/observability/telemetry/telemetry-category";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTelemetryEvent } from "@/lib/desktop-telemetry-handler";
import {
  defaultHandlerContext,
  validDesktopWirePayload,
} from "./utils/desktop-telemetry-fixtures";

const SOURCE_BUILD_COMMIT = "3fc32f406200b2a46b2a477f2f045527794f24bd";

/**
 * The shapes an OLD or buggy desktop actually puts on this field. Types do not
 * constrain a wire, so the non-strings are reachable here even though the
 * producer's own type forbids them.
 */
const REJECTED_BUILD_COMMITS: readonly unknown[] = [
  "unknown",
  "",
  "3fc32f4",
  SOURCE_BUILD_COMMIT.toUpperCase(),
  `${SOURCE_BUILD_COMMIT}0`,
  "0.16.69",
  42,
  null,
  { sha: SOURCE_BUILD_COMMIT },
];

function emitWithBuildCommit(desktopBuildCommit: unknown): {
  ok: boolean;
  trace: Record<string, unknown> | undefined;
} {
  const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {
    // The sink is stubbed; the call ARGUMENTS are the contract under test.
  });

  const result = handleTelemetryEvent(
    {
      ...validDesktopWirePayload,
      category: TelemetryCategory.TokenCostPricingMiss,
      severity: TelemetrySeverity.Warn,
      trace: { ...validDesktopWirePayload.trace, desktopBuildCommit },
    },
    defaultHandlerContext
  );

  const infoCall = infoSpy.mock.calls.find(
    (args) => args[0] === "Desktop telemetry event received"
  );
  const meta = infoCall?.[1] as Record<string, unknown> | undefined;
  return {
    ok: result.ok,
    trace: meta?.trace as Record<string, unknown> | undefined,
  };
}

describe("desktop build commit at the telemetry ingest boundary (ISS-9743)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts a real commit on the trace that reaches the sink", () => {
    const { ok, trace } = emitWithBuildCommit(SOURCE_BUILD_COMMIT);

    expect(ok).toBe(true);
    expect(trace?.desktopBuildCommit).toBe(SOURCE_BUILD_COMMIT);
  });

  it("keeps no build dimension for anything that is not a full commit sha", () => {
    const outcomes = REJECTED_BUILD_COMMITS.map((sent) => {
      const { ok, trace } = emitWithBuildCommit(sent);
      return {
        sent,
        accepted: ok,
        // Absence of the KEY, not an `undefined` value: a `null` or a
        // `"unknown"` on this dimension names a build nobody ever built, and
        // splits one real build's traffic across two labels.
        dimension: trace
          ? Object.hasOwn(trace, "desktopBuildCommit")
          : "no log",
      };
    });

    expect(outcomes).toEqual(
      REJECTED_BUILD_COMMITS.map((sent) => ({
        sent,
        // Version skew: the event still lands. Rejecting it would drop the
        // whole span for every installed build that ever mis-resolves a
        // commit, and drop it again on every retry.
        accepted: true,
        dimension: false,
      }))
    );
  });

  it("leaves the rest of the trace intact when the commit is rejected", () => {
    const { trace } = emitWithBuildCommit("unknown");

    expect(trace).toMatchObject({
      commandId: validDesktopWirePayload.trace.commandId,
      operationId: validDesktopWirePayload.trace.operationId,
      computeTargetId: validDesktopWirePayload.trace.computeTargetId,
    });
  });
});
