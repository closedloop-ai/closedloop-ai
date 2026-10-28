/**
 * ISS-5850: the producer's ACTIVITY EXTENT survives the sync ingress.
 *
 * `sessionSpanSchema` is a plain `z.object`, which STRIPS keys it does not
 * declare. So the two lines declaring `startMs`/`endMs` are the only thing
 * carrying the producer's measured extent across this boundary — delete them and
 * every synced span arrives without it, `resolveTimelineSourceExtent` reports
 * the extent as unknown, and the whole cloud population silently falls back to
 * the pre-ISS-5850 behaviour of treating an unmeasured column as an observed
 * idle one. That is a total loss of the disclosure with nothing red anywhere:
 * the renderer's own suites build their fixtures in-process and never cross this
 * schema, so they keep passing. That in-process blindness is exactly why this
 * file exists and asserts against the parsed payload rather than a fixture.
 *
 * DB-free: exercises only `parseDesktopAgentSessionsPayload` (the pure ingress
 * contract), matching its sibling schema suites.
 */

import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import type { SessionSpan } from "@repo/api/src/types/session-trace-shape";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";
import { sessionSpanSchema } from "./desktop-agent-sessions-trace-schema";

const EXTENT_START_MS = Date.UTC(2026, 5, 10, 10, 12, 0);
const EXTENT_END_MS = Date.UTC(2026, 5, 10, 10, 47, 0);

/**
 * Every wire field of a {@link SessionSpan}, mapped to the schema's own shape.
 *
 * The value of this map is entirely in its TYPE: `Record<keyof …, …>` over
 * `sessionSpanSchema.shape` means a field added to `SessionSpan` without a
 * matching schema entry is a compile error here, rather than a key silently
 * stripped at ingress and a feature that quietly does nothing in production.
 * This is the ISS-5712 guard pattern, applied to the second shape on this lane.
 */
const SESSION_SPAN_WIRE_KEYS: Record<keyof SessionSpan, unknown> =
  sessionSpanSchema.shape;

function buildPayload(span: Record<string, unknown>): unknown {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000001",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "sess-1",
        status: "active",
        startedAt: "2026-06-10T10:00:00.000Z",
        updatedAt: "2026-06-10T11:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
        span: { first: "0:00", last: "0:35", ...span },
      },
    ],
  };
}

/**
 * The parsed span, or a thrown failure naming why the payload was rejected.
 *
 * Throws rather than asserting: an assertion buried in a helper is one that can
 * silently not run, and the interesting expectations all belong to the span it
 * returns.
 */
function parseSpan(span: Record<string, unknown>) {
  const parsed = parseDesktopAgentSessionsPayload(buildPayload(span));
  if (!parsed.ok) {
    throw new Error(`payload did not parse: ${JSON.stringify(parsed)}`);
  }
  return parsed.payload.sessions[0].span;
}

describe("desktop sync schema — session-span activity extent (ISS-5850)", () => {
  it("carries the producer's measured extent through the ingress unchanged", () => {
    const span = parseSpan({
      startMs: EXTENT_START_MS,
      endMs: EXTENT_END_MS,
    });

    // The falsifier for the whole feature: undeclared keys are STRIPPED, so this
    // is red the moment the schema stops declaring them — which is the only
    // signal that the extent disclosure has been disabled cloud-wide.
    expect(span?.startMs).toBe(EXTENT_START_MS);
    expect(span?.endMs).toBe(EXTENT_END_MS);
  });

  it("preserves OMISSION for a desktop build that predates the extent", () => {
    const span = parseSpan({});

    /*
     * `Object.hasOwn`, not `toBeUndefined()`. The two are not the same
     * assertion, and only one of them is the contract: `toBeUndefined()` passes
     * just as happily when the key IS present carrying an explicit `undefined`
     * or `null`, which is the serialization this repo's cross-repo rule
     * forbids. The key must be absent so an older reader — and the consumer's
     * own `resolveTimelineSourceExtent` — sees the field as simply not there.
     */
    expect(span).toBeDefined();
    expect(Object.hasOwn(span ?? {}, "startMs")).toBe(false);
    expect(Object.hasOwn(span ?? {}, "endMs")).toBe(false);
    // The offset half of the span is untouched by skew and must still arrive.
    expect(span?.first).toBe("0:00");
  });

  it("accepts a span carrying only one of the two bounds", () => {
    // Skew must never hard-fail the batch: a half-stated extent still validates,
    // and the consumer's own gate is what declines to use it.
    const span = parseSpan({ startMs: EXTENT_START_MS });

    expect(span?.startMs).toBe(EXTENT_START_MS);
    expect(Object.hasOwn(span ?? {}, "endMs")).toBe(false);
  });

  it("rejects a non-finite extent bound rather than storing it", () => {
    // `NaN`/`Infinity` fail every comparison downstream, so a stored one would
    // make every column's coverage test silently answer "no overlap". JSON
    // cannot carry them, but a hand-built or future producer can.
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({
        startMs: Number.POSITIVE_INFINITY,
        endMs: EXTENT_END_MS,
      })
    );

    expect(parsed.ok).toBe(false);
  });

  it("declares a schema entry for every wire field of the span shape", () => {
    // The runtime half of the compile-time guard above: names the two fields
    // explicitly so a reader sees WHICH keys the type check is protecting.
    expect(Object.keys(SESSION_SPAN_WIRE_KEYS)).toEqual(
      expect.arrayContaining(["startMs", "endMs"])
    );
  });
});
