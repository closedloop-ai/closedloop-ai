/**
 * ISS-8641 / ISS-8714: the metadata a DEGRADED resync actually writes.
 *
 * These drive the REAL `upsertSessions` → `upsertSessionSlice` path (the DB-less
 * harness `service.upsert-watermark.test.ts` established) and assert the blob
 * handed to `sessionDetail.upsert`. A unit test of `mergeDegradedMetadata` proves
 * the merge; only this proves the slice CALLS it and writes the result, which is
 * the wiring `upsert-session-slice.ts` previously had no seam for.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { WEB_SEARCH_COST_PER_REQUEST_USD } from "@repo/cost/harness-cost-parity";
import { SESSION_WEB_SEARCH_REQUESTS_METADATA_PATH } from "@repo/cost/session-web-search-cost";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistedSessionDetail } from "@/__tests__/support/agent-sessions/service.test-harness";

const mocks = vi.hoisted(() => ({
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
  generateSlug: vi.fn().mockResolvedValue("SES-0002"),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    SESSION: "SESSION",
  },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  Prisma: { DbNull: mocks.dbNull },
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: mocks.generateSlug,
}));

vi.mock("./service/session-ingest-metadata-activity", () => ({
  writeSessionArtifactMetadata: vi.fn().mockResolvedValue(null),
  captureCommittedSessionMetadata: vi.fn(),
}));

import { agentSessionsService } from "./service";

const SESSION_STARTED_AT = new Date("2026-08-24T09:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-08-24T09:30:00.000Z");
const PERSISTED_ARTIFACT_ID = "artifact-degraded-metadata-1";
const COMPUTE_TARGET_ID = "target-degraded-1";
const ORG_ID = "org-degraded-1";
const USER_ID = "user-degraded-1";
const EXTERNAL_SESSION_ID = "ext-sess-degraded-1";

/**
 * The three keys every case below reasons about. `entrypoint` is what this pass
 * still carries, `usageExtras` is what the degrade WITHHELD, and
 * `permissionMode` is the one the user DELETED — the case merge-instead-of-
 * replace can get wrong, and the reason the wire carries a key LIST rather than
 * a degradation flag.
 */
const KEPT_KEY = "entrypoint";
const WITHHELD_KEY = "usageExtras";
const DELETED_KEY = "permissionMode";

const STORED_WITHHELD_VALUE = { webSearchRequests: 7 };

/**
 * The web-search request count, at the canonical path
 * `sessionWebSearchCostUsd` reads. Spelled from the exported path constant
 * rather than retyped, so a fixture built to police the cost cannot quietly
 * stop naming the field the production reader looks at.
 */
const WEB_SEARCH_USAGE_EXTRAS = {
  [SESSION_WEB_SEARCH_REQUESTS_METADATA_PATH[1]]: 4,
};
const WEB_SEARCH_KEY = SESSION_WEB_SEARCH_REQUESTS_METADATA_PATH[0];

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "Degraded Metadata Session",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/project",
    model: "claude-sonnet-4",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    metadata: { [KEPT_KEY]: "cli" },
    ...overrides,
  };
}

function buildPayload(sessions: SyncedAgentSession[]) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-degraded-1",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function buildContext() {
  return {
    organizationId: ORG_ID,
    userId: USER_ID,
    computeTargetId: COMPUTE_TARGET_ID,
  };
}

/**
 * Transaction mock whose `sessionDetail.findUnique` answers BOTH lookups the
 * slice now makes: the wide `(computeTargetId, externalSessionId)` row read, and
 * the `metadata`-only read the merge performs under that SAME unique. Keeping
 * them in one mock is what lets a case assert that the second one did not happen.
 *
 * DISCRIMINATED ON `select`, not on `where`, because the two reads deliberately
 * share a `where` now (review: chatgpt-codex-connector — the merge read used to
 * be a bare `artifactId` primary-key lookup carrying no tenant predicate). The
 * wide row read never selects `metadata`; that is the whole reason the merge
 * needs a second read at all, so the column is an exact discriminator.
 */
function installDb(storedMetadata: Record<string, unknown> | null) {
  const detailFindUnique = vi.fn(
    (args: {
      where: {
        computeTargetId_externalSessionId?: {
          computeTargetId: string;
          externalSessionId: string;
        };
      };
      select: Record<string, unknown>;
    }) => {
      if (args.select.metadata === true) {
        return Promise.resolve({ metadata: storedMetadata });
      }
      if (storedMetadata === null) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        artifactId: PERSISTED_ARTIFACT_ID,
        agents: [],
        dataRevision: null,
        pendingChunkRevision: null,
        pendingChunkTotal: null,
        pendingChunkReceived: null,
        sessionStartedAt: SESSION_STARTED_AT,
        sessionUpdatedAt: SESSION_UPDATED_AT,
        sessionEndedAt: null,
        artifact: { status: null },
      });
    }
  );
  const detailUpsert = vi
    .fn()
    .mockResolvedValue(persistedSessionDetail(PERSISTED_ARTIFACT_ID));

  const db = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([{ toolUseCount: 0n, errorCount: 0n }]),
    organization: {
      findUnique: vi.fn().mockResolvedValue({ settings: null }),
    },
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sessionDetail: {
      findUnique: detailFindUnique,
      upsert: detailUpsert,
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _max: { eventCreatedAt: null } }),
    },
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };

  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );

  return { detailFindUnique, detailUpsert };
}

/** The `metadata` the update arm of the upsert actually wrote. */
function writtenMetadata(
  detailUpsert: ReturnType<typeof vi.fn>
): Record<string, unknown> {
  return detailUpsert.mock.calls[0][0].update.metadata;
}

/**
 * The `findUnique` calls that are the merge's `metadata` read, isolated from the
 * slice's own wide row read. Selected on `select.metadata`, the one field the
 * wide read deliberately never asks for — the two now share a `where`.
 */
function metadataReads(
  detailFindUnique: ReturnType<typeof vi.fn>
): { where: Record<string, unknown>; select: Record<string, unknown> }[][] {
  return detailFindUnique.mock.calls.filter(
    (call) => call[0].select.metadata === true
  );
}

describe("upsertSessionSlice — degraded metadata (ISS-8641 / ISS-8714)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reinstates the keys the payload declares it withheld", async () => {
    const { detailUpsert } = installDb({
      [KEPT_KEY]: "cli",
      [WITHHELD_KEY]: STORED_WITHHELD_VALUE,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({ metadataWithheldKeys: [WITHHELD_KEY] }),
      ])
    );

    expect(writtenMetadata(detailUpsert)).toEqual({
      [KEPT_KEY]: "cli",
      [WITHHELD_KEY]: STORED_WITHHELD_VALUE,
    });
  });

  it("still deletes a stored key the payload did NOT declare withheld", async () => {
    // THE CASE MERGE CAN GET WRONG, and the only reason the wire carries a key
    // list instead of a flag. `permissionMode` is on the stored row, absent from
    // this payload, and NOT named as withheld — that is a user deletion, and a
    // receiver that preserved every absent key would resurrect it. A whole-object
    // match, so a merge that reinstated it fails here rather than passing on a
    // containment assertion.
    const { detailUpsert } = installDb({
      [KEPT_KEY]: "cli",
      [WITHHELD_KEY]: STORED_WITHHELD_VALUE,
      [DELETED_KEY]: "acceptEdits",
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({ metadataWithheldKeys: [WITHHELD_KEY] }),
      ])
    );

    const written = writtenMetadata(detailUpsert);
    expect(written).toEqual({
      [KEPT_KEY]: "cli",
      [WITHHELD_KEY]: STORED_WITHHELD_VALUE,
    });
    // Stated separately as well: the whole-object match above would also be
    // satisfied by a merge that dropped BOTH, so this pins that the deletion is
    // what was honoured and not a merge that simply failed.
    expect(WITHHELD_KEY in written).toBe(true);
    expect(DELETED_KEY in written).toBe(false);
  });

  it("keeps today's wholesale replace for an unstamped payload from an older build", async () => {
    // ISS-8641's cross-repo criterion. An already-installed desktop cannot send
    // the field at all, and its payload must behave exactly as it does on main —
    // including deleting the stored key, which is the pre-existing defect and NOT
    // something this change may silently alter for a peer that made no claim.
    const { detailFindUnique, detailUpsert } = installDb({
      [KEPT_KEY]: "cli",
      [WITHHELD_KEY]: STORED_WITHHELD_VALUE,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession()])
    );

    expect(writtenMetadata(detailUpsert)).toEqual({ [KEPT_KEY]: "cli" });
    // And it costs no extra read: the `metadata` lookup is reached only by a
    // payload that actually declared a degrade, which is what keeps every healthy
    // sync off this path.
    expect(metadataReads(detailFindUnique)).toHaveLength(0);
  });

  it("scopes the merge's metadata read by the tenant key, not by a bare row id", async () => {
    // ISS-6748's rule applied to this read (review: chatgpt-codex-connector). It
    // used to be `findUnique({ where: { artifactId } })` — no tenant predicate at
    // all, relying on the id's provenance from an earlier query. `SessionDetail`
    // carries no `organizationId` column, so `computeTargetId` IS its tenant
    // predicate; this asserts the read enforces it rather than inheriting it, and
    // that it is the SAME unique the upsert writes under, so the merge cannot
    // preserve a blob from a row other than the one being overwritten.
    const { detailFindUnique, detailUpsert } = installDb({
      [KEPT_KEY]: "cli",
      [WITHHELD_KEY]: STORED_WITHHELD_VALUE,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({ metadataWithheldKeys: [WITHHELD_KEY] }),
      ])
    );

    const reads = metadataReads(detailFindUnique);
    expect(reads).toHaveLength(1);
    expect(reads[0][0].where).toEqual({
      computeTargetId_externalSessionId: {
        computeTargetId: COMPUTE_TARGET_ID,
        externalSessionId: EXTERNAL_SESSION_ID,
      },
    });
    // The read is only worth scoping because its result is written. Pinned here
    // so a merge that silently stopped reading would fail this case too.
    expect(writtenMetadata(detailUpsert)).toEqual({
      [KEPT_KEY]: "cli",
      [WITHHELD_KEY]: STORED_WITHHELD_VALUE,
    });
  });

  it("writes the degraded blob unchanged on a first delivery, with no stored row to merge", async () => {
    // The create arm. There is nothing to preserve, so the degrade is genuinely
    // lossy here — ISS-7997's accepted trade — and the merge must not invent a
    // value or refuse the write.
    const { detailUpsert } = installDb(null);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({ metadataWithheldKeys: [WITHHELD_KEY] }),
      ])
    );

    expect(writtenMetadata(detailUpsert)).toEqual({ [KEPT_KEY]: "cli" });
  });

  it("lets an incoming key win over the stored copy even when the payload also lists it", async () => {
    // A producer that contradicts itself is not a reason to prefer the older
    // value. Without this, a self-contradicting payload would silently roll a
    // key BACKWARD — a fresher value replaced by the one already on the row.
    const { detailUpsert } = installDb({
      [KEPT_KEY]: "stale-stored-value",
      [WITHHELD_KEY]: STORED_WITHHELD_VALUE,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({
          metadataWithheldKeys: [KEPT_KEY, WITHHELD_KEY],
        }),
      ])
    );

    expect(writtenMetadata(detailUpsert)).toEqual({
      [KEPT_KEY]: "cli",
      [WITHHELD_KEY]: STORED_WITHHELD_VALUE,
    });
  });

  it("keeps the web-search line item in estimatedCost across a degraded resync", async () => {
    // The cost consequence of the merge (review: review-soul).
    // `resolveTokenRollupColumns` prices `estimatedCost` from the blob this slice
    // PERSISTS, and `sessionWebSearchCostUsd` reads `usageExtras` out of it — so
    // before this change a degraded resync deleted the key and the web-search
    // line item silently vanished from the dollar figure, reintroducing the
    // systematically-low cost ISS-7821 fixed. Reinstating it restores the item.
    const { detailUpsert } = installDb({
      [KEPT_KEY]: "cli",
      [WEB_SEARCH_KEY]: WEB_SEARCH_USAGE_EXTRAS,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({ metadataWithheldKeys: [WEB_SEARCH_KEY] }),
      ])
    );

    // The blob keeps the key...
    expect(writtenMetadata(detailUpsert)).toEqual({
      [KEPT_KEY]: "cli",
      [WEB_SEARCH_KEY]: WEB_SEARCH_USAGE_EXTRAS,
    });
    // ...and the DOLLAR FIGURE priced beside it still carries the line item.
    // Asserted separately because the blob surviving does not by itself prove the
    // cost was computed from the merged blob rather than the incoming one.
    expect(detailUpsert.mock.calls[0][0].update.estimatedCost).toBeCloseTo(
      WEB_SEARCH_USAGE_EXTRAS[SESSION_WEB_SEARCH_REQUESTS_METADATA_PATH[1]] *
        WEB_SEARCH_COST_PER_REQUEST_USD,
      6
    );
  });

  it("does not error when the stored metadata is not an object", async () => {
    // A row written before the compaction contract, or by a non-desktop caller,
    // can hold a non-object. It has no top-level keys to preserve; the safe
    // answer is today's replace, never a throw that fails the whole session.
    const { detailUpsert } = installDb(
      "not-an-object" as unknown as Record<string, unknown>
    );

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({ metadataWithheldKeys: [WITHHELD_KEY] }),
      ])
    );

    expect(writtenMetadata(detailUpsert)).toEqual({ [KEPT_KEY]: "cli" });
  });
});
