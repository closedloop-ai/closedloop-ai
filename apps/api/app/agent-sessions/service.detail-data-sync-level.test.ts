import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionDetailRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "./service";
import { resetDataSyncLevelCorruptBudget } from "./service/data-sync-level-integrity";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/**
 * ISS-7516 — the READ side of the recording machine's data-sync level.
 *
 * The column is a nullable TEXT and the wire field is an optional enum, so the
 * hazard is entirely in the gap between those two types. Every case here is
 * about a value the column can hold that the contract cannot, and about the one
 * distinction the client depends on: a level that was REPORTED versus one that
 * was not. Collapsing those makes the transcript panel pick its copy from a
 * value nobody sent.
 */

function installDetail(recordOverrides: Record<string, unknown> = {}) {
  installDb({
    sessionDetail: {
      findFirst: vi
        .fn()
        .mockResolvedValue(buildSessionDetailRecord(recordOverrides)),
    },
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  });
}

function findDetail() {
  return agentSessionsService.findSessionDetail({
    id: "session-1",
    organizationId: "org-1",
  });
}

const CORRUPT_EVENT_WIRE_NAME = "agent_session_data_sync_level_corrupt";

function corruptWarnCalls() {
  return vi
    .mocked(log.warn)
    .mock.calls.filter(([event]) => event === CORRUPT_EVENT_WIRE_NAME);
}

describe("findSessionDetail — recording machine's data sync level", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The emitter is throttled to one line per org per window and every spec
    // here reads as `org-1`, so without this the second corrupt case would be
    // suppressed and its assertion would be measuring the budget, not the read.
    resetDataSyncLevelCorruptBudget();
  });

  it.each([
    DataSyncLevel.Off,
    DataSyncLevel.Metadata,
    DataSyncLevel.Redacted,
    DataSyncLevel.Full,
  ])("serves the stored level %s verbatim", async (level) => {
    installDetail({ dataSyncLevel: level });

    const result = await findDetail();

    expect(result?.dataSyncLevel).toBe(level);
  });

  it("omits the field entirely when the column is NULL", async () => {
    // Every row written before this shipped, and every batch from a desktop
    // build that does not send a level. The key must be ABSENT rather than
    // `null` — the cross-repo rule for optional wire fields, and the thing the
    // client's three-valued fold branches on.
    installDetail({ dataSyncLevel: null });

    const result = await findDetail();

    expect(result?.dataSyncLevel).toBeUndefined();
    expect(result === null ? {} : result).not.toHaveProperty("dataSyncLevel");
  });

  it("drops a value that is not a level, rather than serving it", async () => {
    // The column is TEXT, so a corrupt or hand-written row can hold anything.
    // Passing it through would let bad data choose the copy a user reads; the
    // read side narrows instead, and an unrecognized value degrades to the same
    // "cannot say" as an absent one.
    installDetail({ dataSyncLevel: "metadata-only" });

    const result = await findDetail();

    expect(result?.dataSyncLevel).toBeUndefined();
  });

  it("does not accept the legacy observability-tier spelling from the column", async () => {
    // `local` is a `SyncObservabilityTier` value; the `DataSyncLevel` for it is
    // `off`. Serving it would put a second vocabulary on the wire.
    installDetail({ dataSyncLevel: "local" });

    const result = await findDetail();

    expect(result?.dataSyncLevel).toBeUndefined();
    // POSITIVE SIBLING, same field, same assertion style: proves the three
    // negative cases above are discriminating and not a detail read that
    // returns `undefined` for this field no matter what.
    installDetail({ dataSyncLevel: DataSyncLevel.Off });
    expect((await findDetail())?.dataSyncLevel).toBe(DataSyncLevel.Off);
  });

  it("reports a corrupt stored level, naming the row and the bad value", async () => {
    installDetail({ dataSyncLevel: "metadata-only" });

    await findDetail();

    expect(corruptWarnCalls()).toHaveLength(1);
    expect(corruptWarnCalls()[0]?.[1]).toMatchObject({
      organizationId: "org-1",
      sessionId: "session-1",
      storedValueSample: "metadata-only",
      storedValueLength: "metadata-only".length,
    });
  });

  it("stays silent for a NULL column, so absence keeps meaning 'older client'", async () => {
    // The distinction the finding is about. A pre-upgrade desktop legitimately
    // reports no level; treating that as an anomaly would bury the real signal
    // under the entire un-upgraded fleet. Paired with the corrupt case above,
    // this is what makes the two separable server-side even though the WIRE
    // answer is deliberately identical.
    installDetail({ dataSyncLevel: null });

    await findDetail();

    expect(corruptWarnCalls()).toHaveLength(0);
  });

  it("stays silent, and does not throw, when the column is absent entirely", async () => {
    // Not the same shape as NULL. A row that never set the column reads as
    // `null`, but a record projected by a `select` that omits the field hands
    // over `undefined` — which a `!== null` guard classifies as corrupt and then
    // dereferences. That threw a TypeError out of a detail read that has nothing
    // to do with sync levels, so the absent case is pinned in BOTH shapes.
    installDetail({ dataSyncLevel: undefined });

    const result = await findDetail();

    expect(result?.dataSyncLevel).toBeUndefined();
    expect(corruptWarnCalls()).toHaveLength(0);
  });

  it.each([
    DataSyncLevel.Off,
    DataSyncLevel.Metadata,
    DataSyncLevel.Redacted,
    DataSyncLevel.Full,
  ])("stays silent for the recognized level %s", async (level) => {
    installDetail({ dataSyncLevel: level });

    await findDetail();

    expect(corruptWarnCalls()).toHaveLength(0);
  });

  it("clips an oversized corrupt value and says how long it really was", async () => {
    // The column is unbounded untrusted TEXT, so one bad row must not be able to
    // bloat a log line. The length travels alongside the clipped sample so a
    // truncated sample cannot be misread as the whole value.
    const stored = "x".repeat(300);
    installDetail({ dataSyncLevel: stored });

    await findDetail();

    const payload = corruptWarnCalls()[0]?.[1] as
      | { storedValueSample: string; storedValueLength: number }
      | undefined;
    expect(payload?.storedValueSample).toHaveLength(64);
    expect(payload?.storedValueLength).toBe(300);
  });

  it("throttles a repeated corrupt read to one line per org per window", async () => {
    // A corrupt column never self-heals, so it is re-read on every detail
    // request and the branch fan-out hydrates many sessions per request.
    installDetail({ dataSyncLevel: "metadata-only" });

    await findDetail();
    await findDetail();
    await findDetail();

    expect(corruptWarnCalls()).toHaveLength(1);
  });
});
