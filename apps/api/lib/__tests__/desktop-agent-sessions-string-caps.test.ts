/**
 * ISS-8051: the desktop session-ingest lane enforces no PAYLOAD-SIZE string cap.
 *
 * `route.ts` safeParses the WHOLE batch, so a `z.string().max(N)` here is not a
 * truncation — one over-long value 400s up to 200 sessions with no per-item
 * salvage and keeps 400ing them on every retry. This suite pins the removal of
 * that class of bound.
 *
 * It does NOT pin the removal of every bound, and the counterweights are
 * asserted here on purpose so the distinction cannot quietly collapse in either
 * direction. A bound whose removal would make the failure WORSE is not a
 * payload-size cap and stays, in two shapes:
 *
 * - TRUNCATING or FOLDING, where a reader downstream holds a premise but the
 *   batch must still be admitted — `billingMode` (a usage-summary group-by key),
 *   `deviceTimeZone` (an IANA value domain), and a marker `label`. Each asserts
 *   both that the value is bounded AND that its batch still parses.
 *
 * The REJECTING shape used to have a third member — the component identity
 * fields, which were btree index keys with a 512-character `.max()`. ISS-8201
 * removed those caps and the last describe block now pins the opposite: an
 * over-long identity is ADMITTED, because ISS-8736 projects it to a byte budget
 * at the write. A character cap could never bound a byte-sized index tuple, and
 * keeping one only meant an ASCII identity 400'd where a multibyte one of the
 * same length was accepted and projected.
 *
 * The lengths below are written as literals ON PURPOSE and are NOT imported
 * from the schema or from any `*_MAX_CHARS` constant: a fixture that reads its
 * expectation from the thing it polices cannot detect the bound moving.
 * Every length used here exceeded the cap it is testing (512 for component
 * identity; 300 for the trace-source fields; 262,144 for component content).
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  SessionTraceCorrectionSourceKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import {
  parseDesktopAgentSessionsPayload,
  syncedComponentSchema,
} from "../desktop-agent-sessions-schema";

/** Longer than every removed identity/label/title cap (max removed was 512). */
const OVER_ANY_IDENTITY_CAP = 5000;
/**
 * Longer than the removed 300-char trace-source cap, but small enough that the
 * three trace-source arrays stay under the 64,000-byte aggregate budget that
 * ISS-8051 did NOT touch — that budget is a payload-size guard on the whole
 * group, not a per-field string cap, and it must still bind.
 */
const OVER_TRACE_SOURCE_CAP = 1000;
/** Longer than the removed 262,144-char component-content cap. */
const OVER_CONTENT_CAP = 300_000;

const identityString = "x".repeat(OVER_ANY_IDENTITY_CAP);
const traceString = "y".repeat(OVER_TRACE_SOURCE_CAP);
const contentString = "z".repeat(OVER_CONTENT_CAP);

const baseSession = {
  externalSessionId: "sess-1",
  name: "Session One",
  status: SESSION_STATUS.ACTIVE,
  harness: "claude",
  cwd: "/tmp/worktree",
  model: "claude-sonnet-4",
  startedAt: "2026-05-20T17:00:00.000Z",
  updatedAt: "2026-05-20T17:05:00.000Z",
  metadata: { source: "desktop" },
  attribution: {
    repositoryFullName: "closedloop-ai/closedloop-ai",
    worktreePath: null,
    sourceArtifactId: "artifact-1",
    sourceLoopId: null,
    baseBranch: null,
  },
  agents: [],
  events: [],
  tokenUsageByModel: [],
};

function parseWithSessionFields(fields: Record<string, unknown>) {
  return parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [{ ...baseSession, ...fields }],
  });
}

/** The parsed session, or a failure the assertion can name. */
function parsedSession(fields: Record<string, unknown>) {
  const result = parseWithSessionFields(fields);
  if (!result.ok) {
    throw new Error(`payload rejected: ${result.reason}`);
  }
  return result.payload.sessions[0];
}

describe("ISS-8051: session-level strings carry no REJECTING length cap", () => {
  it("truncates an over-long billingMode instead of rejecting its batch", () => {
    // ISS-8051 review (whitlockk): `billingMode` is a GROUP-BY key in the usage
    // summary, not free text, so the STORED value stays bounded. The bound is a
    // truncation, so the over-long value still costs its batch nothing — which
    // is the only property ISS-8051 ever claimed.
    const session = parsedSession({ billingMode: identityString });

    expect(session.billingMode).toHaveLength(64);
  });

  it("folds an unresolvable deviceTimeZone to null instead of rejecting its batch", () => {
    // ISS-8051 review (codex): `deviceTimeZone` is an IANA zone NAME, a value
    // domain. An unresolvable value would otherwise be retained as a key in
    // `getDateOnlyFormatter`'s process-global map forever while rendering as UTC
    // regardless, so it folds to the `null` that already means "no device zone".
    const session = parsedSession({ deviceTimeZone: identityString });

    expect(session.deviceTimeZone).toBeNull();
  });

  it("preserves a resolvable deviceTimeZone, canonical or legacy alias", () => {
    // The opposite state: the value-domain check must not discard a real zone.
    // `US/Pacific` is a legacy alias absent from `Intl.supportedValuesOf`, which
    // is why the check constructs rather than consulting that list.
    expect(
      parsedSession({ deviceTimeZone: "America/Chicago" }).deviceTimeZone
    ).toBe("America/Chicago");
    expect(parsedSession({ deviceTimeZone: "US/Pacific" }).deviceTimeZone).toBe(
      "US/Pacific"
    );
  });

  it("still rejects an EMPTY billingMode and deviceTimeZone", () => {
    // The opposite state of the assertion above: removing the length cap must
    // not have removed the min(1) emptiness rule on the same two fields.
    expect(parseWithSessionFields({ billingMode: "" }).ok).toBe(false);
    expect(parseWithSessionFields({ deviceTimeZone: "" }).ok).toBe(false);
  });

  it("accepts and preserves an over-long PR title and status", () => {
    const session = parsedSession({
      prs: [{ num: 42, title: identityString, status: identityString }],
    });

    expect(session.prs?.[0]?.title).toHaveLength(OVER_ANY_IDENTITY_CAP);
    expect(session.prs?.[0]?.status).toHaveLength(OVER_ANY_IDENTITY_CAP);
  });

  it("accepts and preserves an over-long diff-stat source on both lanes", () => {
    const stats = {
      linesAdded: 1,
      linesRemoved: 1,
      filesChanged: 1,
      source: identityString,
    };
    const session = parsedSession({
      gitDiffStats: stats,
      branchDiffStats: stats,
    });

    expect(session.gitDiffStats?.source).toHaveLength(OVER_ANY_IDENTITY_CAP);
    expect(session.branchDiffStats?.source).toHaveLength(OVER_ANY_IDENTITY_CAP);
  });

  it("accepts and preserves an over-long activity-bucket label and model key", () => {
    const session = parsedSession({
      activityBuckets: [
        {
          label: identityString,
          cIn: 0,
          cOut: 0,
          cCache: 0,
          total: 0,
          toolStart: 0,
          tl0: null,
          byModel: { [identityString]: { cIn: 0, cOut: 0, cCache: 0 } },
        },
      ],
    });

    expect(session.activityBuckets?.[0]?.label).toHaveLength(
      OVER_ANY_IDENTITY_CAP
    );
    expect(
      Object.keys(session.activityBuckets?.[0]?.byModel ?? {})[0]
    ).toHaveLength(OVER_ANY_IDENTITY_CAP);
  });

  it("accepts and preserves an over-long activity-segment phase and evidence layer", () => {
    const session = parsedSession({
      activitySegmentRows: [
        {
          phase: identityString,
          startMs: 0,
          endMs: 10,
          confidence: 1,
          evidenceLayers: [identityString],
          version: 1,
        },
      ],
    });

    expect(session.activitySegmentRows?.[0]?.phase).toHaveLength(
      OVER_ANY_IDENTITY_CAP
    );
    expect(session.activitySegmentRows?.[0]?.evidenceLayers[0]).toHaveLength(
      OVER_ANY_IDENTITY_CAP
    );
  });

  it("accepts and preserves over-long span, marker, and throttle strings", () => {
    const session = parsedSession({
      span: { first: identityString, last: identityString },
      markers: [
        {
          kind: "commit",
          x: 0,
          t: identityString,
          label: identityString,
          tl: 0,
        },
      ],
      throttles: [
        { x0: 0, t0: identityString, t1: identityString, durMin: 1, tl: 0 },
      ],
    });

    expect(session.span?.first).toHaveLength(OVER_ANY_IDENTITY_CAP);
    expect(session.span?.last).toHaveLength(OVER_ANY_IDENTITY_CAP);
    expect(session.markers?.[0]?.t).toHaveLength(OVER_ANY_IDENTITY_CAP);
    // ISS-8051 review (davetho): the marker LABEL truncates rather than being
    // left unbounded — `markers` is count-capped only and the
    // `aggregatePayloadBytes` budget never covers it, so the desktop's
    // `clampMarkerLabel` would otherwise be the only bound anywhere. Still no
    // reject: the sibling `t` on the same marker is untouched at full length.
    expect(session.markers?.[0]?.label).toHaveLength(300);
    expect(session.throttles?.[0]?.t0).toHaveLength(OVER_ANY_IDENTITY_CAP);
    expect(session.throttles?.[0]?.t1).toHaveLength(OVER_ANY_IDENTITY_CAP);
  });

  it("accepts and preserves over-long phase and loopback strings", () => {
    const session = parsedSession({
      phases: [
        {
          key: identityString,
          label: identityString,
          dur: identityString,
          cost: identityString,
          cOut: 0,
          cCache: 0,
          cIn: 0,
        },
      ],
      phaseLoopbacks: [
        {
          from: identityString,
          to: identityString,
          label: identityString,
          depth: 1,
        },
      ],
    });

    expect(session.phases?.[0]?.key).toHaveLength(OVER_ANY_IDENTITY_CAP);
    expect(session.phases?.[0]?.label).toHaveLength(OVER_ANY_IDENTITY_CAP);
    expect(session.phases?.[0]?.dur).toHaveLength(OVER_ANY_IDENTITY_CAP);
    expect(session.phases?.[0]?.cost).toHaveLength(OVER_ANY_IDENTITY_CAP);
    expect(session.phaseLoopbacks?.[0]?.from).toHaveLength(
      OVER_ANY_IDENTITY_CAP
    );
    expect(session.phaseLoopbacks?.[0]?.label).toHaveLength(
      OVER_ANY_IDENTITY_CAP
    );
  });

  it("accepts and preserves over-long trace-source strings", () => {
    const session = parsedSession({
      tracePhaseSources: [
        {
          sourceType: SessionTracePhaseSourceType.Explicit,
          phaseKey: traceString,
          label: traceString,
          startedAt: "2026-05-20T17:00:00.000Z",
        },
      ],
      throttleSources: [
        {
          sourceType: SessionTraceThrottleSourceType.ApiError,
          provider: traceString,
          observedAt: "2026-05-20T17:00:00.000Z",
          limitKind: traceString,
          errorCode: traceString,
        },
      ],
      correctionSources: [
        {
          kind: SessionTraceCorrectionSourceKind.ManualRegression,
          observedAt: "2026-05-20T17:00:00.000Z",
          label: traceString,
          sourceType: traceString,
        },
      ],
    });

    expect(session.tracePhaseSources?.[0]?.phaseKey).toHaveLength(
      OVER_TRACE_SOURCE_CAP
    );
    expect(session.tracePhaseSources?.[0]?.label).toHaveLength(
      OVER_TRACE_SOURCE_CAP
    );
    expect(session.throttleSources?.[0]?.provider).toHaveLength(
      OVER_TRACE_SOURCE_CAP
    );
    expect(session.throttleSources?.[0]?.limitKind).toHaveLength(
      OVER_TRACE_SOURCE_CAP
    );
    expect(session.throttleSources?.[0]?.errorCode).toHaveLength(
      OVER_TRACE_SOURCE_CAP
    );
    expect(session.correctionSources?.[0]?.label).toHaveLength(
      OVER_TRACE_SOURCE_CAP
    );
    expect(session.correctionSources?.[0]?.sourceType).toHaveLength(
      OVER_TRACE_SOURCE_CAP
    );
  });

  it("still rejects a trace-source group over the aggregate byte budget", () => {
    // The opposite state of the assertion above. ISS-8051 removed the per-field
    // string caps and deliberately left this whole-group byte guard in place,
    // so an unbounded field must not have made the group unbounded.
    const huge = "y".repeat(70_000);

    expect(
      parseWithSessionFields({
        tracePhaseSources: [
          {
            sourceType: SessionTracePhaseSourceType.Explicit,
            phaseKey: huge,
            startedAt: "2026-05-20T17:00:00.000Z",
          },
        ],
      }).ok
    ).toBe(false);
  });
});

describe("ISS-8051: non-indexed component strings carry no length cap", () => {
  it("accepts and preserves an over-long name and truncation reason", () => {
    const result = syncedComponentSchema.safeParse({
      externalId: "skill::my-skill",
      componentKind: "skill",
      name: identityString,
      variantsTruncatedReason: identityString,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.name).toHaveLength(OVER_ANY_IDENTITY_CAP);
    expect(result.data.variantsTruncatedReason).toHaveLength(
      OVER_ANY_IDENTITY_CAP
    );
  });

  it("still rejects an externalId that is empty after trim", () => {
    // The opposite state: the length cap is gone, the emptiness rule is not.
    expect(
      syncedComponentSchema.safeParse({
        externalId: "   ",
        componentKind: "skill",
      }).success
    ).toBe(false);
  });

  it("accepts and preserves over-long definition content on the component", () => {
    const result = syncedComponentSchema.safeParse({
      externalId: "skill::my-skill",
      componentKind: "skill",
      content: contentString,
      contentHash: "a".repeat(64),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.content).toHaveLength(OVER_CONTENT_CAP);
  });

  it("accepts and preserves an over-long variant body", () => {
    const result = syncedComponentSchema.safeParse({
      externalId: "skill::my-skill",
      componentKind: "skill",
      variants: [{ contentHash: "a".repeat(64), content: contentString }],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.variants?.[0]?.content).toHaveLength(OVER_CONTENT_CAP);
  });

  it("still rejects a variant whose contentHash is empty after trim", () => {
    // The opposite state on the same subject as the assertion above.
    expect(
      syncedComponentSchema.safeParse({
        externalId: "skill::my-skill",
        componentKind: "skill",
        variants: [{ contentHash: "  ", content: "BODY" }],
      }).success
    ).toBe(false);
  });
});

/**
 * ISS-8201: the component identity fields are btree index keys, and they are
 * ADMITTED at any length.
 *
 * This block is the inversion of the ISS-8051 one it replaces, and the reason
 * is a unit mismatch rather than a change of mind about Postgres. The index
 * tuple limit is 2704 BYTES; the cap that used to sit here counted CHARACTERS.
 * So a 5000-character ASCII identity 400'd the batch and never reached
 * `toComponentIndexKeys`, while a 512-character multibyte one — up to 2048
 * bytes, three of them 6 KB — sailed past the same cap and WAS projected. Two
 * values a producer would call equivalent, two different outcomes, and the
 * ASCII one got a rejected batch with no telemetry to say why.
 *
 * The bound that actually holds is applied at the WRITE
 * (`apps/api/lib/index-key-projection.ts`, ISS-8736), which is where a byte
 * budget can be enforced and counted. Admission here is what lets it run:
 * `__tests__/integration/desktop-component-overlong-identity.integration.test.ts`
 * takes the value the first case below admits, drives it through the real
 * service against a real Postgres, and asserts both the projected row and the
 * `desktop.sync.index_key_projected` emission.
 */
describe("ISS-8201: component index-key fields are admitted at any length", () => {
  it.each([
    ["externalId", { externalId: identityString, componentKind: "skill" }],
    [
      "componentKind",
      { externalId: "skill::x", componentKind: identityString },
    ],
    [
      "componentKey",
      {
        externalId: "skill::x",
        componentKind: "skill",
        componentKey: identityString,
      },
    ],
    [
      "variant contentHash",
      {
        externalId: "skill::x",
        componentKind: "skill",
        variants: [{ contentHash: identityString, content: "BODY" }],
      },
    ],
  ])(
    "admits an over-long %s so the write-side projection can bound it",
    (_field, component) => {
      expect(syncedComponentSchema.safeParse(component).success).toBe(true);
    }
  );

  it("still rejects an identity field that is empty after trim", () => {
    // The opposite state: removing the LENGTH cap is not removing the field's
    // identity requirement, which no projection can reconstruct.
    expect(
      syncedComponentSchema.safeParse({
        externalId: "   ",
        componentKind: "skill",
      }).success
    ).toBe(false);
  });

  it("accepts each index-key field at a realistic length", () => {
    expect(
      syncedComponentSchema.safeParse({
        externalId: "skill::my-skill",
        componentKind: "skill",
        componentKey: "my-skill",
        variants: [{ contentHash: "a".repeat(64), content: "BODY" }],
      }).success
    ).toBe(true);
  });
});
