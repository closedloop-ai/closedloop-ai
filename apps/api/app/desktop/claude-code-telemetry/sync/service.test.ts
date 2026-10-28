import { DesktopClaudeCodeTelemetrySyncAckReason } from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeComputeTarget } from "@/__tests__/support/compute-targets/compute-target.test-fixtures";
import { computeTargetsService } from "@/app/compute-targets/service";
import { desktopClaudeCodeTelemetrySyncService } from "./service";

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: vi.fn() },
}));

// The service hands `withDb` a callback typed for the real Prisma client; this
// suite substitutes a fake client, so the mock declares the callback's client
// as `unknown` rather than claiming the fake is a `TransactionClient`.
const mockWithDb = vi.hoisted(() =>
  vi.fn<(fn: (client: unknown) => unknown) => unknown>()
);

vi.mock("@repo/database", () => ({ withDb: mockWithDb }));

const ORG_ID = "org-1";
const TARGET_ID = "target-1";
const USER_ID = "user-1";
const ARTIFACT_ID = "11111111-2222-4333-8444-555555555555";

type UpsertCall = {
  where: unknown;
  create: Record<string, unknown>;
  update?: Record<string, unknown>;
};

/** A breakdown table's calls, in issue order, with what each one carried. */
type BreakdownRecorder = {
  ops: string[];
  rows: Record<string, unknown>[];
  deletes: Record<string, unknown>[];
};

function breakdownRecorder(): {
  recorder: BreakdownRecorder;
  table: Record<string, unknown>;
} {
  const recorder: BreakdownRecorder = { ops: [], rows: [], deletes: [] };
  const table = {
    upsert: vi.fn((call: UpsertCall) => {
      recorder.ops.push("upsert");
      recorder.rows.push(call.create);
      return Promise.resolve({ id: "row-1" });
    }),
    deleteMany: vi.fn((call: { where: Record<string, unknown> }) => {
      recorder.ops.push("deleteMany");
      recorder.deletes.push(call.where);
      return Promise.resolve({ count: 0 });
    }),
  };
  return { recorder, table };
}

function fakeDb(options: { sessionFound: boolean }) {
  const telemetryUpserts: UpsertCall[] = [];
  const dropUpserts: UpsertCall[] = [];
  const componentRows: Record<string, unknown>[] = [];
  /** Component-table calls in the order they were issued. */
  const componentOps: string[] = [];
  const activeTime = breakdownRecorder();
  const linesOfCode = breakdownRecorder();
  const db = {
    sessionDetail: {
      findUnique: vi.fn(() =>
        Promise.resolve(
          options.sessionFound ? { artifactId: ARTIFACT_ID } : null
        )
      ),
    },
    claudeCodeSessionTelemetry: {
      upsert: vi.fn((call: UpsertCall) => {
        telemetryUpserts.push(call);
        return Promise.resolve();
      }),
    },
    claudeCodeComponentTelemetry: {
      deleteMany: vi.fn(() => {
        componentOps.push("deleteMany");
        return Promise.resolve({ count: 0 });
      }),
      upsert: vi.fn((call: { create: Record<string, unknown> }) => {
        componentOps.push("upsert");
        componentRows.push(call.create);
        return Promise.resolve({ id: "component-1" });
      }),
    },
    claudeCodeSignalDropCounter: {
      upsert: vi.fn((call: UpsertCall) => {
        dropUpserts.push(call);
        return Promise.resolve();
      }),
    },
    claudeCodeActiveTimeTelemetry: activeTime.table,
    claudeCodeLinesOfCodeTelemetry: linesOfCode.table,
  };
  mockWithDb.mockImplementation((fn) => fn(db));
  return {
    db,
    telemetryUpserts,
    dropUpserts,
    componentRows,
    componentOps,
    activeTime: activeTime.recorder,
    linesOfCode: linesOfCode.recorder,
  };
}

/**
 * The payload a current desktop build sends, written as an independent literal
 * rather than derived from the schema, so a contract change has to be reflected
 * here deliberately.
 */
function currentBuildPayload() {
  return {
    protocolVersion: 1,
    session: {
      externalSessionId: "session-abc",
      harness: "claude",
      costEventCount: 12,
      apiRequestCount: 0,
      costEventUsd: "1.250000",
      apiRequestCostUsdMicros: "1250000",
      components: [
        {
          attributionKey: "skill:frankenstein",
          attributionSource: "otel",
          skillName: "frankenstein",
          costEventCount: 12,
          costUsd: "1.250000",
        },
      ],
    },
    dropCounters: [
      {
        harness: "claude",
        reason: "normalizer_unusable",
        droppedCount: "7",
        firstObservedAt: "2026-09-20T00:00:00.000Z",
        lastObservedAt: "2026-09-21T00:00:00.000Z",
      },
    ],
  };
}

function sync(rawBody: unknown) {
  return desktopClaudeCodeTelemetrySyncService.sync({
    clerkUserId: null,
    computeTargetId: TARGET_ID,
    organizationId: ORG_ID,
    rawBody,
    userId: USER_ID,
  });
}

describe("desktopClaudeCodeTelemetrySyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      makeComputeTarget({
        id: TARGET_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
      })
    );
  });

  it("persists the rollup, its components and the drop counters", async () => {
    const { telemetryUpserts, dropUpserts, componentRows, componentOps } =
      fakeDb({ sessionFound: true });

    const result = await sync(currentBuildPayload());

    expect(result.ok).toBe(true);
    expect(telemetryUpserts).toHaveLength(1);
    expect(componentRows[0]).toMatchObject({ skillName: "frankenstein" });
    // The survivors' complement is deleted AFTER the upserts, never before:
    // a delete-first pass leaves a window where the session reports zero
    // components, which a read landing in it would publish as a real zero.
    expect(componentOps).toEqual(["upsert", "deleteMany"]);
    expect(dropUpserts[0]?.create).toMatchObject({
      reason: "normalizer_unusable",
      droppedCount: 7n,
    });
  });

  it("stores an omitted count as null, and a present zero as zero", async () => {
    const { telemetryUpserts } = fakeDb({ sessionFound: true });

    // `llmRequestCount` is omitted (the beta table this machine never fed) while
    // `apiRequestCount` is a measured 0. If the ingest defaulted either to the
    // other, a consumer could no longer tell an unrecorded family from an empty
    // one — the distinction ISS-10717's completeness signal exists to keep.
    await sync(currentBuildPayload());

    expect(telemetryUpserts[0]?.create).toMatchObject({
      apiRequestCount: 0,
      llmRequestCount: null,
    });
  });

  it("answers a newer protocol version retryably, never as a validation failure", async () => {
    fakeDb({ sessionFound: true });

    const result = await sync({
      ...currentBuildPayload(),
      protocolVersion: 99,
    });

    expect(result.ok).toBe(false);
    // ProtocolUnsupported maps to a 501 the desktop reads as "defer, budget
    // intact". ValidationFailed maps to a 400 it reads as permanent, which is
    // what walked a whole corpus into dead letters in ISS-4976 / ISS-7795.
    expect(result.ok ? null : result.error.reason).toBe(
      DesktopClaudeCodeTelemetrySyncAckReason.ProtocolUnsupported
    );
  });

  it("accepts a newer desktop's unknown keys instead of rejecting the payload", async () => {
    const { telemetryUpserts } = fakeDb({ sessionFound: true });
    const payload = currentBuildPayload();

    const result = await sync({
      ...payload,
      unknownEnvelopeField: "from a newer build",
      session: { ...payload.session, unknownSessionField: 1 },
    });

    expect(result.ok).toBe(true);
    expect(telemetryUpserts).toHaveLength(1);
  });

  it("records the drop counters even when the session has not synced yet", async () => {
    const { dropUpserts, telemetryUpserts } = fakeDb({ sessionFound: false });

    const result = await sync(currentBuildPayload());

    expect(result.ok && result.value.accepted).toBe(false);
    expect(result.ok ? result.value.reason : null).toBe(
      DesktopClaudeCodeTelemetrySyncAckReason.SessionNotFound
    );
    expect(telemetryUpserts).toHaveLength(0);
    // The completeness signal must not be lost to a session the metadata lane
    // has not delivered yet, or it would arrive later than the data it
    // qualifies.
    expect(dropUpserts).toHaveLength(1);
  });

  it("accepts a counters-only delivery and never looks for a session", async () => {
    // The gap this closes: an export lost before any signal row is persisted
    // moves a drop counter and dirties no session, so the desktop has nothing to
    // ride the counter on. Refusing the counters-only shape would leave that
    // loss on the machine forever while cloud read the machine as complete.
    const { db, telemetryUpserts, dropUpserts } = fakeDb({
      sessionFound: true,
    });

    const result = await sync({
      protocolVersion: 1,
      dropCounters: currentBuildPayload().dropCounters,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.accepted).toBe(true);
    expect(result.ok && result.value.dropCountersRecorded).toBe(1);
    // No session was named, so none is claimed in the ack.
    expect(result.ok && result.value.externalSessionId).toBeUndefined();
    expect(dropUpserts).toHaveLength(1);
    expect(telemetryUpserts).toHaveLength(0);
    expect(db.sessionDetail.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an envelope that names neither a session nor a counter", async () => {
    const { dropUpserts, telemetryUpserts } = fakeDb({ sessionFound: true });

    const result = await sync({ protocolVersion: 1, dropCounters: [] });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.reason).toBe(
      DesktopClaudeCodeTelemetrySyncAckReason.ValidationFailed
    );
    expect(dropUpserts).toHaveLength(0);
    expect(telemetryUpserts).toHaveLength(0);
  });

  it("skips a drop counter whose window cannot be read", async () => {
    const { dropUpserts } = fakeDb({ sessionFound: true });
    const payload = currentBuildPayload();

    const result = await sync({
      ...payload,
      dropCounters: [
        { ...payload.dropCounters[0], firstObservedAt: "not-a-date" },
      ],
    });

    expect(result.ok).toBe(true);
    // An unreadable window is not a smaller measurement, it is an unusable one.
    expect(dropUpserts).toHaveLength(0);
    expect(result.ok ? result.value.dropCountersRecorded : null).toBe(0);
  });

  it.each([
    ["a word", "not-a-number"],
    ["an exponent form", "1e-8"],
    ["a negative amount", "-1.000000"],
    ["more integer digits than the column holds", "123456789.000000"],
    ["more fractional digits than the column holds", "1.0000001"],
  ])(
    "refuses %s in a cost field as a validation failure, not an ingestion error",
    async (_label, costEventUsd) => {
      fakeDb({ sessionFound: true });

      // These strings land straight in Decimal(14,6). Before the wire contract
      // carried a numeric SHAPE (they were length-capped strings), a value
      // Prisma could not convert threw inside the service, the route answered
      // IngestionFailed 500, and the desktop client read any 5xx as a lane-wide
      // retry — so the same payload returned to the head of an
      // oldest-owed-first queue every tick with nothing charged and the rest of
      // the corpus behind it. A 400 is session-attributable and bounded.
      const payload = currentBuildPayload();
      const result = await sync({
        ...payload,
        session: { ...payload.session, costEventUsd },
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.reason).toBe(
        DesktopClaudeCodeTelemetrySyncAckReason.ValidationFailed
      );
    }
  );

  it("persists the two value-bearing breakdowns and clears only their complement", async () => {
    const { telemetryUpserts, activeTime, linesOfCode } = fakeDb({
      sessionFound: true,
    });
    const payload = currentBuildPayload();

    const result = await sync({
      ...payload,
      session: {
        ...payload.session,
        activeTime: [{ activityType: "user", seconds: "90.000" }],
        linesOfCode: [
          { model: "sonnet", changeType: "added", lineCount: "412" },
        ],
        identity: { appVersion: "1.2.3", terminalType: "iTerm.app" },
      },
    });

    expect(result.ok).toBe(true);
    expect(activeTime.rows[0]).toMatchObject({
      activityType: "user",
      seconds: "90.000",
    });
    expect(linesOfCode.rows[0]).toMatchObject({
      model: "sonnet",
      changeType: "added",
      lineCount: 412n,
    });
    // Same ordering contract the component path has: the complement is deleted
    // AFTER the upserts, never before, so no read can land in a window where the
    // session reports an empty breakdown it actually has rows for.
    expect(activeTime.ops).toEqual(["upsert", "deleteMany"]);
    expect(linesOfCode.ops).toEqual(["upsert", "deleteMany"]);
    // The lines-of-code complement is a PAIR-WISE NOT: a row is kept only when
    // it matches a delivered `(model, changeType)` pair. A flat `notIn` on model
    // alone would delete a legitimately different change type of the same model.
    expect(linesOfCode.deletes[0]).toMatchObject({
      NOT: [{ model: "sonnet", changeType: "added" }],
    });
    expect(telemetryUpserts[0]?.create).toMatchObject({
      activeTimeRecorded: true,
      linesOfCodeRecorded: true,
      identityRecorded: true,
      identityAppVersion: "1.2.3",
    });
  });

  it("skips the complement delete when the producer flagged a breakdown truncated", async () => {
    const { activeTime } = fakeDb({ sessionFound: true });
    const payload = currentBuildPayload();

    // The producer could not send the whole set, so the rows it did NOT send are
    // not absent — deleting the complement here would drop a tail the cloud
    // legitimately holds and nothing would ever restore it.
    const result = await sync({
      ...payload,
      session: {
        ...payload.session,
        activeTime: [{ activityType: "user", seconds: "90.000" }],
        activeTimeTruncated: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(activeTime.ops).toEqual(["upsert"]);
  });

  it("writes no recorded or truncated flag for a family the payload omitted", async () => {
    const { telemetryUpserts, activeTime, linesOfCode } = fakeDb({
      sessionFound: true,
    });

    // An older or downgraded desktop omits these fields because the BUILD cannot
    // report them, not because the machine measured nothing. Writing `false`
    // here on update would flip a recorded breakdown back to unknown and mark a
    // truncated one complete, and `identityRecorded: false` plus five NULLs
    // would delete dimensions a previous delivery stored.
    const result = await sync(currentBuildPayload());

    expect(result.ok).toBe(true);
    const update = telemetryUpserts[0]?.update ?? {};
    for (const column of [
      "activeTimeRecorded",
      "activeTimeTruncated",
      "linesOfCodeRecorded",
      "linesOfCodeTruncated",
      "identityRecorded",
      "identityAppVersion",
    ]) {
      expect(Object.hasOwn(update, column)).toBe(false);
    }
    expect(activeTime.ops).toEqual([]);
    expect(linesOfCode.ops).toEqual([]);
  });

  it("clears a breakdown only for a PRESENT empty array, which is a measurement", async () => {
    const { telemetryUpserts, activeTime } = fakeDb({ sessionFound: true });
    const payload = currentBuildPayload();

    const result = await sync({
      ...payload,
      session: { ...payload.session, activeTime: [] },
    });

    expect(result.ok).toBe(true);
    expect(activeTime.ops).toEqual(["deleteMany"]);
    expect(telemetryUpserts[0]?.update).toMatchObject({
      activeTimeRecorded: true,
    });
  });

  it("refuses a line count past the BIGINT column range as a validation failure", async () => {
    fakeDb({ sessionFound: true });
    const payload = currentBuildPayload();

    // One past `BIGINT`. Length-capped at 40 digits this parsed, reached the
    // upsert, and threw INSIDE the service — a 5xx the desktop reads as a
    // lane-wide retry, so the same payload returns to the head of an
    // oldest-owed-first queue forever. A 400 costs one session instead.
    const result = await sync({
      ...payload,
      session: {
        ...payload.session,
        linesOfCode: [
          {
            model: "sonnet",
            changeType: "added",
            lineCount: "9223372036854775808",
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.reason).toBe(
      DesktopClaudeCodeTelemetrySyncAckReason.ValidationFailed
    );
  });
});
