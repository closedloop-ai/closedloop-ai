/**
 * ISS-8051: none of the SIXTEEN arrays enumerated below rejects for being too
 * long any more.
 *
 * Deliberately NOT a universal claim about the wire. `tokenEvents` is the
 * seventeenth array of exactly this kind and is removed in the sibling
 * `tokenEvents` change, not here — until that lands, a session shipping 10,001
 * token events still 400s the whole batch, and a reader who took a universal
 * claim at face value would miss it. (`agents`, `events` and `tokenUsageByModel`
 * never carried a cardinality bound at all, so they have nothing to assert.)
 *
 * Every case below sends one element MORE than the cardinality bound that used
 * to guard that array, and asserts the payload parses AND the array survives at
 * its full length. Both halves matter: `.ok` alone would pass if the cap were
 * swapped from "reject" to "silently slice", which is the ISS-5029 trap — a
 * truncated set stored as a complete one.
 *
 * The counts are pinned as INDEPENDENT LITERALS, never derived from the
 * constants being removed, so the fixture cannot drift with a constant and each
 * one crosses its retired boundary by exactly one element.
 *
 * DB-free: exercises only `parseDesktopAgentSessionsPayload` and
 * `desktopAgentComponentsPayloadSchema` (the pure ingress contracts), matching
 * its sibling schema suites.
 */
import {
  AgentSessionSyncMode,
  SessionTraceCorrectionSourceKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
} from "@repo/api/src/types/agent-session";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { SessionPrRelationType } from "@repo/api/src/types/session-pr-link-metadata";
import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
  desktopAgentComponentsPayloadSchema,
  parseDesktopAgentSessionsPayload,
} from "./desktop-agent-sessions-schema";

const AGENT_SESSION_SYNC_SCHEMA_VERSION = 2 as const;
const BATCH_ID = "00000000-0000-4000-8000-000000000001";
const STARTED_AT = "2026-06-10T10:00:00.000Z";
const UPDATED_AT = "2026-06-10T11:00:00.000Z";

/** Retired bound + 1, per array. Literals on purpose — see the file header. */
const OVER_ACTIVITY_BUCKETS = 501;
const OVER_ACTIVITY_SEGMENT_ROWS = 5001;
const OVER_ARTIFACT_REFS = 501;
const OVER_COMPONENT_BATCH = 201;
const OVER_COMPONENT_USAGE = 501;
const OVER_EVIDENCE_LAYERS = 17;
const OVER_MARKERS = 501;
const OVER_PHASE_LOOPBACKS = 101;
const OVER_PHASES = 101;
const OVER_PRS = 501;
const OVER_SESSIONS = 201;
const OVER_THROTTLES = 101;
const OVER_TRACE_SOURCES = 101;

describe("desktop sync schema — the sixteen retired array cardinality bounds (ISS-8051)", () => {
  it.each([
    [
      "activityBuckets",
      OVER_ACTIVITY_BUCKETS,
      (index: number) => buildActivityBucket(index),
    ],
    ["markers", OVER_MARKERS, (index: number) => buildMarker(index)],
    ["throttles", OVER_THROTTLES, (index: number) => buildThrottle(index)],
    [
      "tracePhaseSources",
      OVER_TRACE_SOURCES,
      (index: number) => buildPhaseSource(index),
    ],
    [
      "throttleSources",
      OVER_TRACE_SOURCES,
      (index: number) => buildThrottleSource(index),
    ],
    ["correctionSources", OVER_TRACE_SOURCES, () => buildCorrectionSource()],
    ["phases", OVER_PHASES, (index: number) => buildPhase(index)],
    [
      "phaseLoopbacks",
      OVER_PHASE_LOOPBACKS,
      (index: number) => buildPhaseLoopback(index),
    ],
    ["prs", OVER_PRS, (index: number) => buildPr(index)],
    ["prRefs", OVER_PRS, (index: number) => buildPrRef(index)],
    [
      "artifactRefs",
      OVER_ARTIFACT_REFS,
      (index: number) => buildSlugRef(index),
    ],
    [
      "components",
      OVER_COMPONENT_USAGE,
      (index: number) => buildComponentUsage(index),
    ],
    [
      "activitySegmentRows",
      OVER_ACTIVITY_SEGMENT_ROWS,
      (index: number) => buildActivitySegmentRow(index),
    ],
  ])(
    "accepts and preserves an over-limit %s array",
    (field, count, buildEntry) => {
      const entries = Array.from({ length: count }, (_unused, index) =>
        buildEntry(index)
      );

      const parsed = parseDesktopAgentSessionsPayload(
        buildBatch([buildSession({ [field]: entries })])
      );

      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const session = parsed.payload.sessions[0] as unknown as Record<
          string,
          unknown[]
        >;
        // Length, not just `.ok`: a cap swapped from reject to slice would
        // still parse, and storing that slice as a complete set is the exact
        // ISS-5029 bug this ticket exists to prevent.
        expect(session[field]).toHaveLength(count);
      }
    },
    120_000
  );

  it("accepts and preserves an over-limit sessions batch", () => {
    const sessions = Array.from({ length: OVER_SESSIONS }, (_unused, index) =>
      buildSession({ externalSessionId: `sess-${index}` })
    );

    const parsed = parseDesktopAgentSessionsPayload(buildBatch(sessions));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions).toHaveLength(OVER_SESSIONS);
      expect(parsed.payload.sessions.at(-1)?.externalSessionId).toBe(
        `sess-${OVER_SESSIONS - 1}`
      );
    }
  });

  it("accepts and preserves an over-limit evidenceLayers array on one segment", () => {
    const evidenceLayers = Array.from(
      { length: OVER_EVIDENCE_LAYERS },
      (_unused, index) => `layer-${index}`
    );

    const parsed = parseDesktopAgentSessionsPayload(
      buildBatch([
        buildSession({
          activitySegmentRows: [
            { ...buildActivitySegmentRow(0), evidenceLayers },
          ],
        }),
      ])
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(
        parsed.payload.sessions[0]?.activitySegmentRows?.[0]?.evidenceLayers
      ).toHaveLength(OVER_EVIDENCE_LAYERS);
    }
  });

  it("accepts and preserves an over-limit component-inventory batch", () => {
    const components = Array.from(
      { length: OVER_COMPONENT_BATCH },
      (_unused, index) => ({
        externalId: `component-${index}`,
        componentKind: "skill",
      })
    );

    const parsed = desktopAgentComponentsPayloadSchema.safeParse({
      schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
      batchId: BATCH_ID,
      syncMode: AgentSessionSyncMode.Incremental,
      componentCount: OVER_COMPONENT_BATCH,
      components,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.components).toHaveLength(OVER_COMPONENT_BATCH);
    }
  });
});

function buildBatch(sessions: Record<string, unknown>[]): unknown {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: BATCH_ID,
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function buildSession(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    externalSessionId: "sess-1",
    status: "active",
    startedAt: STARTED_AT,
    updatedAt: UPDATED_AT,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function buildActivityBucket(index: number): Record<string, unknown> {
  return {
    label: `bucket-${index}`,
    cIn: 1,
    cOut: 0.5,
    cCache: 0.5,
    total: 2,
    toolStart: 1,
    tl0: 0,
    byModel: {},
  };
}

function buildMarker(index: number): Record<string, unknown> {
  return {
    kind: "commit",
    x: 0,
    t: `t-${index}`,
    label: `marker-${index}`,
    tl: 0,
  };
}

function buildThrottle(index: number): Record<string, unknown> {
  return { x0: 0, t0: `t0-${index}`, t1: `t1-${index}`, durMin: 1, tl: 0 };
}

function buildPhaseSource(index: number): Record<string, unknown> {
  return {
    sourceType: SessionTracePhaseSourceType.Explicit,
    phaseKey: `phase-${index}`,
    startedAt: STARTED_AT,
  };
}

function buildThrottleSource(index: number): Record<string, unknown> {
  return {
    sourceType: SessionTraceThrottleSourceType.ApiError,
    provider: `provider-${index}`,
    observedAt: STARTED_AT,
  };
}

function buildCorrectionSource(): Record<string, unknown> {
  return {
    kind: SessionTraceCorrectionSourceKind.ManualRegression,
    observedAt: STARTED_AT,
  };
}

function buildPhase(index: number): Record<string, unknown> {
  return {
    key: `phase-${index}`,
    label: `Phase ${index}`,
    dur: "1m",
    cost: "$1",
    cOut: 0,
    cCache: 0,
    cIn: 0,
  };
}

function buildPhaseLoopback(index: number): Record<string, unknown> {
  return {
    from: `phase-${index}`,
    to: `phase-${index + 1}`,
    label: `loop-${index}`,
    depth: 1,
  };
}

function buildPr(index: number): Record<string, unknown> {
  return { num: index + 1, title: `PR ${index}`, status: "open" };
}

function buildPrRef(index: number): Record<string, unknown> {
  return {
    repositoryFullName: "acme/repo",
    prNumber: index + 1,
    relationType: SessionPrRelationType.Referenced,
  };
}

function buildSlugRef(index: number): Record<string, unknown> {
  return {
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: `FEA-${index + 1}`,
    isPrimary: false,
    method: "test",
  };
}

function buildComponentUsage(index: number): Record<string, unknown> {
  return {
    componentKind: "skill",
    componentKey: `component-${index}`,
    invocations: 1,
    errorCount: 0,
  };
}

function buildActivitySegmentRow(index: number): Record<string, unknown> {
  return {
    phase: "build",
    startMs: index * 2,
    endMs: index * 2 + 1,
    confidence: 0.5,
    evidenceLayers: ["layer-a"],
    version: 1,
  };
}
