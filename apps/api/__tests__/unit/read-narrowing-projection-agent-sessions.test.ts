import type { AgentComponentInvocationSyncPart } from "@repo/api/src/types/agent-component-invocation";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ensureDefinitionVersion: vi.fn(),
  recordDefinitionSourceOccurrence: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  });
  return {
    Prisma: { sql },
    SourceAccessState: { accessible: "accessible" },
    SourceOccurrenceType: {
      local: "local",
      repository: "repository",
      pack: "pack",
    },
    withDb: mocks.withDb,
  };
});

vi.mock("@repo/aws/transcript-storage", () => ({
  getSignedTranscriptDownloadUrl: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/app/definition-registry/service", () => ({
  ensureDefinitionVersion: mocks.ensureDefinitionVersion,
  recordDefinitionSourceOccurrence: mocks.recordDefinitionSourceOccurrence,
}));

import {
  buildItem,
  buildPart,
  COMPUTE_TARGET_ID,
  installStatefulDb,
  ORGANIZATION_ID,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import {
  createModelDouble,
  type Row,
} from "@/__tests__/support/read-narrowing-projection.test-db";
import { agentComponentInvocationsService } from "@/app/agent-sessions/service/component-invocations";
import { readSessionUsageRollup } from "@/app/agent-sessions/service/session-usage-reads";
import { transcriptReadService } from "@/app/agent-sessions/transcript-read-service";
import { mockWithDbAll } from "../utils/db-helpers";

/**
 * ISS-9189 — the agent-session reads narrowed in this change, characterized
 * through {@link createModelDouble} so the `select` is actually APPLIED and a
 * wrong-or-absent one becomes an observable output change rather than a silent
 * superset the mappers happen to name their way out of.
 */

const ORG_ID = "org-1";
const SESSION_ARTIFACT_ID = "artifact-1";
const NOW = new Date("2026-09-04T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureDefinitionVersion.mockResolvedValue("definition-version-1");
  mocks.recordDefinitionSourceOccurrence.mockResolvedValue(
    "source-occurrence-1"
  );
});

describe("session usage rollup read", () => {
  it("hands the rollup view exactly the columns it maps", async () => {
    const agentSessionUsageRollup = createModelDouble([
      {
        artifactId: SESSION_ARTIFACT_ID,
        // The rollup carries no organizationId column — the read scopes through
        // the session -> artifact join, so the fixture embeds that related row.
        session: { artifact: { organizationId: ORG_ID } },
        startedAt: NOW,
        startedDay: "2026-09-04",
        status: "inactive",
        harness: "claude_code",
        isHuman: false,
        humanTurns: 2,
        agentTurns: 7,
        eventCount: 41,
        toolInvocations: 12,
        errorEvents: 1,
        inputTokens: 1000n,
        outputTokens: 2000n,
        cacheReadTokens: 3000n,
        cacheWriteTokens: 4000n,
        estimatedCost: 1.5,
        runtimeMs: 90_000n,
        rollupUpdatedAt: NOW,
        lastSyncedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    mockWithDbAll({ agentSessionUsageRollup });

    const view = await readSessionUsageRollup({
      organizationId: ORG_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
    });

    // Exact: `artifactId` is the caller's own input and `lastSyncedAt`,
    // `createdAt`, `updatedAt` are cloud bookkeeping the view never exposes, so
    // an absent select would hand all four to a consumer that asked for none.
    expect(agentSessionUsageRollup.returnedColumns).toEqual([
      [
        "startedAt",
        "startedDay",
        "status",
        "harness",
        "isHuman",
        "humanTurns",
        "agentTurns",
        "eventCount",
        "toolInvocations",
        "errorEvents",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "estimatedCost",
        "runtimeMs",
        "rollupUpdatedAt",
      ],
    ]);
    expect(view?.runtimeMs).toBe(90_000);
    expect(view?.estimatedCostUsd).toBe(1.5);
  });
});

describe("transcript descriptor read", () => {
  it("keeps the upload machinery out of the descriptor response", async () => {
    const sessionDetail = createModelDouble([
      {
        artifactId: SESSION_ARTIFACT_ID,
        artifact: { organizationId: ORG_ID },
        computeTargetId: "target-1",
        externalSessionId: "ext-1",
      },
    ]);
    const sessionTranscript = createModelDouble([transcriptRow()]);
    mockWithDbAll({ sessionDetail, sessionTranscript });

    const response = await transcriptReadService.findTranscriptAccess({
      id: SESSION_ARTIFACT_ID,
      organizationId: ORG_ID,
      deps: { mintDownloadUrl: () => Promise.resolve("https://signed") },
    });

    // Guard first: with no read at all the exclusion below is vacuously true.
    expect(sessionTranscript.returnedColumns).toHaveLength(1);
    for (const column of [
      "pendingUploadId",
      "pendingUploadStartedAt",
      "syncedByteOffset",
      "sourcePathHash",
      "crc64nvme",
      "sourceMtime",
      "sessionDetailId",
      "organizationId",
      "computeTargetId",
      "externalSessionId",
    ]) {
      expect(sessionTranscript.returnedColumns.flat()).not.toContain(column);
    }
    // `storedEtag` and `objectStorageKey` are the two columns the descriptor
    // never echoes but the URL mint depends on, so only a behavioural
    // assertion catches them leaving the select.
    expect(response?.files[0]?.url).toBe("https://signed");
    expect(response?.files[0]?.byteSize).toBe(2048);
  });

  it("addresses the mint with the narrowed object key and etag", async () => {
    const sessionDetail = createModelDouble([
      {
        artifactId: SESSION_ARTIFACT_ID,
        artifact: { organizationId: ORG_ID },
        computeTargetId: "target-1",
        externalSessionId: "ext-1",
      },
    ]);
    const sessionTranscript = createModelDouble([transcriptRow()]);
    mockWithDbAll({ sessionDetail, sessionTranscript });
    const mintDownloadUrl = vi.fn(() => Promise.resolve("https://signed"));

    await transcriptReadService.findTranscriptAccess({
      id: SESSION_ARTIFACT_ID,
      organizationId: ORG_ID,
      deps: { mintDownloadUrl },
    });

    expect(mintDownloadUrl).toHaveBeenCalledWith(
      "org-1/target-1/ext-1.jsonl",
      "etag-main"
    );
  });
});

describe("staged invocation part ledger read", () => {
  it("re-checks an already-persisted part from the ledger columns alone", async () => {
    const { db, parts } = installStatefulDb(mocks.withDb.tx);
    // Project the ledger read the way Postgres does. The stateful store's own
    // `findUnique` ignores `select`, which is exactly the mock that cannot
    // characterize a narrowing; the rest of its model set stays as-is.
    const ledgerDouble = createModelDouble(parts as unknown as Row[]);
    db.agentComponentInvocationPart.findUnique =
      ledgerDouble.findUnique as (typeof db.agentComponentInvocationPart)["findUnique"];
    const part = buildPart({
      allItems: [buildItem({ externalInvocationId: "invocation-1" })],
      partCount: 2,
    });

    await ingest(part);
    const replay = await ingest(part);

    // The first ingest creates the part and matches nothing, so the single
    // recorded projection is the replay's ledger re-check. `id`,
    // `generationId`, `partIndex` and `receivedAt` are never read by
    // `partLedgerMatches`, so an absent select would return all of them.
    expect(ledgerDouble.returnedColumns).toEqual([
      ["partHash", "itemCount", "payloadBytes"],
    ]);
    // A replay must be accepted, not counted as a conflicting part: dropping
    // any of the three columns makes the stored side `undefined`, the ledger
    // comparison fail, and this become a `part_conflict` rejection.
    expect(replay.ok).toBe(true);
    expect(db.agentComponentInvocationPart.create).toHaveBeenCalledTimes(1);
  });
});

function ingest(part: AgentComponentInvocationSyncPart) {
  return agentComponentInvocationsService.ingestPart({
    organizationId: ORGANIZATION_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    part,
  });
}

function transcriptRow(overrides: Row = {}): Row {
  return {
    id: "transcript-1",
    organizationId: ORG_ID,
    computeTargetId: "target-1",
    externalSessionId: "ext-1",
    sessionDetailId: SESSION_ARTIFACT_ID,
    sourceHarness: "claude_code",
    fileKey: "main",
    objectStorageKey: "org-1/target-1/ext-1.jsonl",
    uploadStatus: TranscriptUploadStatus.Uploaded,
    permanentFailureReason: null,
    rawSha256: "a".repeat(64),
    crc64nvme: "crc-1",
    rawByteSize: 2048n,
    storedEtag: "etag-main",
    syncedByteOffset: 2048n,
    sourceMtime: NOW,
    sourcePathHash: "path-hash",
    pendingUploadId: null,
    pendingUploadStartedAt: null,
    firstSeenAt: NOW,
    lastObservedAt: NOW,
    uploadedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
