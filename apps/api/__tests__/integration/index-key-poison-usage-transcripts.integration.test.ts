/**
 * ISS-8125 — the two tables ISS-8069 (PR #6017) deliberately left alone:
 * `AgentComponentSessionUsage` and `SessionTranscript`. Proved against a real
 * Postgres, for the same reason its sibling suite is: the failure is the
 * ENGINE's (`index row size N exceeds btree version 4 maximum 2704`), so a
 * mocked write accepts every string and stays green through every mutation of
 * the guards under test.
 *
 * NOT wrapped in `autoRollbackTransaction`, deliberately. The harm under test IS
 * partial commit — the session batch gives each session its own transaction, so
 * a sibling has ALREADY COMMITTED when a later session throws — and one outer
 * rollback would erase exactly the boundary the sibling assertions are about.
 * Isolation is per-test organization plus a cascading delete.
 *
 * The fixtures are HIGH-ENTROPY (see `overLimitValue`) and the assertions are
 * against POSTGRES's 2704 and S3's 1024, never against `INDEX_KEY_MAX_BYTES`.
 */

import {
  AgentSessionSyncMode,
  type SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { s3Port } from "@/__tests__/support/desktop/transcripts/service.test-fixtures";
import {
  BTREE_INDEX_TUPLE_MAX_BYTES,
  buildSession,
  buildSessionsPayload,
  createSyncFixture,
  HEALTHY_SESSION_ID,
  legacyStorableValue,
  overLimitValue,
  S3_OBJECT_KEY_MAX_BYTES,
} from "@/__tests__/support/index-key-poison.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { desktopComponentsSyncService } from "@/app/desktop/components/sync/service";
import { backfillOrphanTranscriptsBatch } from "@/app/desktop/transcripts/backfill-service";
import { transcriptSyncService } from "@/app/desktop/transcripts/service";
import { TranscriptRateLimiter } from "@/app/desktop/transcripts/transcript-rate-limit";
import type { TranscriptS3Port } from "@/app/desktop/transcripts/transcript-s3-port";
import type { DesktopAgentComponentsPayload } from "@/lib/desktop-agent-sessions-schema";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const OVER_LIMIT_VALUE = overLimitValue("iss-8125");
const OVER_LIMIT_ALTERNATE = overLimitValue("iss-8125-alternate");

/**
 * ISS-8253: the value a LEGACY row can actually be sitting under — past the
 * projection budget, inside the btree tuple limit. `OVER_LIMIT_VALUE` cannot
 * seed one; the engine refuses that INSERT.
 */
const LEGACY_STORABLE_KEY = legacyStorableValue("iss-8253-legacy");

const HEALTHY_COMPONENT_KIND = "skill";
const HEALTHY_COMPONENT_KEY = "healthy-sibling-skill";
const HEALTHY_BRANCH = "feat/healthy";
const POISON_SESSION_ID = "ext-poison-usage";
const TRANSCRIPT_SHA = "a".repeat(64);
const TRANSCRIPT_NOW = 1_700_000_000_000;

const organizations = createCommittedTestOrganizationTracker();

function createFixture(machineName: string) {
  return organizations
    .create()
    .then((organizationId) => createSyncFixture(organizationId, machineName));
}

function buildUsage(
  overrides: Partial<SyncedComponentUsage>
): SyncedComponentUsage {
  return {
    componentKind: HEALTHY_COMPONENT_KIND,
    componentKey: HEALTHY_COMPONENT_KEY,
    externalComponentId: null,
    harness: "claude-code",
    invocations: 3,
    errorCount: 0,
    firstInvokedAt: null,
    lastInvokedAt: null,
    gitBranch: HEALTHY_BRANCH,
    componentVersionHash: null,
    ...overrides,
  } as SyncedComponentUsage;
}

function readUsageRows(computeTargetId: string) {
  return withDb((db) =>
    db.agentComponentSessionUsage.findMany({
      where: { session: { computeTargetId } },
      select: {
        componentKind: true,
        componentKey: true,
        componentKeyNormalized: true,
        gitBranch: true,
        invocationCount: true,
        session: { select: { externalSessionId: true } },
      },
    })
  );
}

function readTranscripts(computeTargetId: string) {
  return withDb((db) =>
    db.sessionTranscript.findMany({
      where: { computeTargetId },
      select: {
        externalSessionId: true,
        fileKey: true,
        objectStorageKey: true,
        uploadStatus: true,
      },
    })
  );
}

/** Every index-key column this row put into a btree tuple, in bytes. */
function usageKeyByteLengths(row: {
  componentKind: string;
  componentKey: string;
  componentKeyNormalized: string;
  gitBranch: string;
}): number[] {
  return [
    row.componentKind,
    row.componentKey,
    // DERIVED by the database trigger from `component_key`, and carried in its
    // own btree (`agent_component_session_usage_kind_key_norm_idx`). Asserted
    // beside the raw column because a fix that bounds the raw key without the
    // fold following it would leave this one over the limit.
    row.componentKeyNormalized,
    row.gitBranch,
  ].map((value) => Buffer.byteLength(value, "utf8"));
}

function planRequest(externalSessionId: string, fileKey: string) {
  return {
    computeTargetId: "",
    externalSessionId,
    fileKey,
    sourceHarness: "claude_code",
    sourcePathHash: "path-hash",
    planEndOffset: 1000,
    sha256: TRANSCRIPT_SHA,
    crc64nvme: "crc-1",
    sourceMtime: new Date(TRANSCRIPT_NOW).toISOString(),
  };
}

function transcriptDeps(s3: TranscriptS3Port) {
  return {
    s3,
    now: () => TRANSCRIPT_NOW,
    rateLimiter: new TranscriptRateLimiter(),
  };
}

afterEach(async () => {
  await organizations.cleanup();
});

describeIfDb("ISS-8125 — AgentComponentSessionUsage index keys", () => {
  it("persists a usage row whose kind, key and branch all exceed the btree tuple limit, and leaves its batch sibling durable", async () => {
    const fixture = await createFixture("iss-8125-usage");

    // The healthy sibling goes FIRST so its own slice transaction has already
    // COMMITTED by the time the poison session is applied. Without row-level
    // ack the batch rethrows the slice failure, so on the unfixed path this call
    // rejects with the sibling already durable — the partial commit the desktop
    // then re-sends forever.
    await agentSessionsService.upsertSessions(
      {
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        computeTargetId: fixture.computeTargetId,
      },
      buildSessionsPayload([
        buildSession({ components: [buildUsage({})] }),
        buildSession({
          externalSessionId: POISON_SESSION_ID,
          components: [
            buildUsage({
              componentKind: OVER_LIMIT_VALUE,
              componentKey: OVER_LIMIT_ALTERNATE,
              gitBranch: OVER_LIMIT_VALUE,
              invocations: 7,
            }),
          ],
        }),
      ])
    );

    const rows = await readUsageRows(fixture.computeTargetId);
    expect(rows).toHaveLength(2);

    // The sibling is untouched — the assertion the whole ticket turns on. An
    // error-free result on the poison row alone would miss a partial commit
    // entirely.
    const sibling = rows.find(
      (row) => row.session?.externalSessionId === HEALTHY_SESSION_ID
    );
    expect(sibling?.componentKey).toBe(HEALTHY_COMPONENT_KEY);
    expect(sibling?.componentKind).toBe(HEALTHY_COMPONENT_KIND);
    expect(sibling?.gitBranch).toBe(HEALTHY_BRANCH);
    expect(sibling?.invocationCount).toBe(3);

    const poison = rows.find(
      (row) => row.session?.externalSessionId === POISON_SESSION_ID
    );
    expect(poison).toBeDefined();
    expect(poison?.invocationCount).toBe(7);
    const storedKeyBytes = poison ? usageKeyByteLengths(poison) : [];
    expect(storedKeyBytes).toHaveLength(4);
    for (const byteLength of storedKeyBytes) {
      // None landed EMPTY — a bound key still identifies its row — and all four
      // landed small enough for the engine to have indexed them.
      expect(byteLength).toBeGreaterThan(0);
      expect(byteLength).toBeLessThan(BTREE_INDEX_TUPLE_MAX_BYTES);
    }
  });

  it("re-syncing the same over-long usage row updates it instead of minting a second", async () => {
    const fixture = await createFixture("iss-8125-usage-idempotent");
    const context = {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      computeTargetId: fixture.computeTargetId,
    };
    const payload = buildSessionsPayload([
      buildSession({
        components: [
          buildUsage({
            componentKind: OVER_LIMIT_VALUE,
            componentKey: OVER_LIMIT_ALTERNATE,
            gitBranch: OVER_LIMIT_VALUE,
          }),
        ],
      }),
    ]);

    await agentSessionsService.upsertSessions(context, payload);
    await agentSessionsService.upsertSessions(context, payload);

    // The projection is a pure function of the original, so the second delivery
    // hits the same `ON CONFLICT` target. A non-deterministic bound would show
    // up here as two rows for one usage bucket.
    expect(await readUsageRows(fixture.computeTargetId)).toHaveLength(1);
  });

  it("prunes the stale branch bucket of an over-long component key on resync", async () => {
    const fixture = await createFixture("iss-8125-usage-branch-prune");
    const context = {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      computeTargetId: fixture.computeTargetId,
    };

    await agentSessionsService.upsertSessions(
      context,
      buildSessionsPayload([
        buildSession({
          components: [
            buildUsage({
              componentKey: OVER_LIMIT_VALUE,
              gitBranch: "feat/first",
            }),
          ],
        }),
      ])
    );
    await agentSessionsService.upsertSessions(
      context,
      buildSessionsPayload([
        buildSession({
          components: [
            buildUsage({
              componentKey: OVER_LIMIT_VALUE,
              gitBranch: "feat/second",
            }),
          ],
        }),
      ])
    );

    // The payload is authoritative for every branch bucket of a (kind, key) it
    // reports, so the first branch's bucket must be GONE. This is the half of
    // the fix that does not throw when it is wrong: a prune predicate built from
    // the raw key matches no stored row, the stale bucket survives, and detail
    // and token-trend — which sum ALL rows per (kind, key) — double-count it
    // forever.
    const rows = await readUsageRows(fixture.computeTargetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gitBranch).toBe("feat/second");
  });

  it("resolves the inventory FK for a usage row whose external component id is over-long", async () => {
    const fixture = await createFixture("iss-8125-usage-fk");
    const overLongExternalId = `skill::${OVER_LIMIT_VALUE}`;

    await desktopComponentsSyncService.sync({
      clerkUserId: null,
      computeTargetId: fixture.computeTargetId,
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      payload: {
        schemaVersion: 1,
        batchId: "3f6c1a90-2b48-4d6e-9c31-7a4e2f8b5d60",
        syncMode: AgentSessionSyncMode.Incremental,
        componentCount: 1,
        components: [
          {
            externalId: overLongExternalId,
            componentKind: HEALTHY_COMPONENT_KIND,
            harness: "claude-code",
            name: "Over-long skill",
            componentKey: HEALTHY_COMPONENT_KEY,
            version: null,
            description: null,
            sourceUrl: null,
            installPath: ".claude/skills/x/SKILL.md",
            packId: null,
            scope: null,
            projectPath: null,
            metadata: null,
            content: "# x",
            contentHash: "c".repeat(64),
          },
        ],
      } as DesktopAgentComponentsPayload,
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        computeTargetId: fixture.computeTargetId,
      },
      buildSessionsPayload([
        buildSession({
          components: [buildUsage({ externalComponentId: overLongExternalId })],
        }),
      ])
    );

    // `AgentComponent` stores its identity projected (ISS-8069), so the usage
    // lane has to look it up the same way. A raw lookup silently resolves to
    // NULL — the usage row lands, orphaned from the inventory row that owns it,
    // and no error is ever raised.
    const linked = await withDb((db) =>
      db.agentComponentSessionUsage.findFirst({
        where: { session: { computeTargetId: fixture.computeTargetId } },
        select: { agentComponentId: true },
      })
    );
    expect(linked?.agentComponentId).not.toBeNull();
  });

  it("replaces a legacy RAW usage bucket instead of leaving it beside the projected one", async () => {
    // ISS-8253 (review, codex on component-usage.ts) — the half of this that
    // does not throw. A usage row written before ISS-8125 projected the column
    // is stored under its RAW key, which the tuple accepted; the projected
    // `ON CONFLICT` target misses it, so the resync inserts a SECOND bucket and
    // detail + token-trend — which sum ALL rows per (kind, key) — double-count
    // that component forever.
    //
    // The legacy row is written with raw SQL on purpose: the production writer
    // now projects, so there is no supported path that produces this row, and a
    // fixture built through the writer would prove nothing.
    const fixture = await createFixture("iss-8253-usage-legacy-raw");
    const context = {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      computeTargetId: fixture.computeTargetId,
    };
    await agentSessionsService.upsertSessions(
      context,
      buildSessionsPayload([buildSession({ components: [buildUsage({})] })])
    );
    const session = await withDb((db) =>
      db.sessionDetail.findFirstOrThrow({
        where: { computeTargetId: fixture.computeTargetId },
        select: { artifactId: true },
      })
    );
    await withDb(
      (db) => db.$executeRaw`
        INSERT INTO agent_component_session_usage (
          id, agent_session_id, component_kind, component_key, git_branch,
          invocation_count, error_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${session.artifactId}::uuid, ${HEALTHY_COMPONENT_KIND},
          ${LEGACY_STORABLE_KEY}, ${HEALTHY_BRANCH}, 11, 0, NOW(), NOW()
        )
      `
    );

    await agentSessionsService.upsertSessions(
      context,
      buildSessionsPayload([
        buildSession({
          components: [buildUsage({ componentKey: LEGACY_STORABLE_KEY })],
        }),
      ])
    );

    const rows = await readUsageRows(fixture.computeTargetId);
    const buckets = rows.filter(
      (row) => row.componentKey !== HEALTHY_COMPONENT_KEY
    );
    // ONE bucket for that component, carrying the resynced count — not the
    // legacy 11 beside a projected 3.
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.componentKey).not.toBe(LEGACY_STORABLE_KEY);
    expect(buckets[0]?.invocationCount).toBe(3);
    // The unrelated healthy bucket is untouched: the prune only ever reaches a
    // group the payload itself reports.
    expect(
      rows.filter((row) => row.componentKey === HEALTHY_COMPONENT_KEY)
    ).toHaveLength(1);
  });

  it("keeps two DIFFERENT over-long component keys on two different rows", async () => {
    const fixture = await createFixture("iss-8125-usage-distinct");

    // The failure a plain truncation would produce: these two keys differ only
    // past the point any prefix-only bound would keep, so folding them together
    // would silently merge two components' usage into one row.
    await agentSessionsService.upsertSessions(
      {
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        computeTargetId: fixture.computeTargetId,
      },
      buildSessionsPayload([
        buildSession({
          components: [
            buildUsage({ componentKey: OVER_LIMIT_VALUE, invocations: 1 }),
            buildUsage({ componentKey: OVER_LIMIT_ALTERNATE, invocations: 2 }),
          ],
        }),
      ])
    );

    const rows = await readUsageRows(fixture.computeTargetId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.componentKey)).size).toBe(2);
  });
});

describeIfDb("ISS-8125 — SessionTranscript index keys", () => {
  it("plans a transcript whose session id and file key both exceed the btree tuple limit, and leaves the already-planned sibling file durable", async () => {
    const fixture = await createFixture("iss-8125-transcripts");
    const auth = {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      clerkUserId: null,
    };

    // The healthy file is planned FIRST and its transaction commits. The
    // transcript lane is per-file rather than batched, so this is not the same
    // partial-commit shape as the session batch above; the assertion still
    // matters, because on the unfixed path the poison plan throws inside
    // `runTranscriptTx` and degrades to a 503, which the desktop classifies as a
    // LANE-WIDE outage (ISS-7097) and backs the whole transcript lane off on.
    const healthy = await transcriptSyncService.planSync({
      ...auth,
      request: {
        ...planRequest(HEALTHY_SESSION_ID, "main"),
        computeTargetId: fixture.computeTargetId,
      },
      deps: transcriptDeps(s3Port()),
    });
    expect(healthy.ok ? null : healthy.error).toBeNull();

    const poison = await transcriptSyncService.planSync({
      ...auth,
      request: {
        ...planRequest(
          `ext-poison-${OVER_LIMIT_VALUE}`,
          `subagent:${OVER_LIMIT_ALTERNATE}`
        ),
        computeTargetId: fixture.computeTargetId,
      },
      deps: transcriptDeps(s3Port()),
    });
    expect(poison.ok ? null : poison.error).toBeNull();

    const rows = await readTranscripts(fixture.computeTargetId);
    expect(rows).toHaveLength(2);

    const sibling = rows.find(
      (row) => row.externalSessionId === HEALTHY_SESSION_ID
    );
    expect(sibling?.fileKey).toBe("main");
    expect(sibling?.uploadStatus).toBe("uploading");

    const poisonRow = rows.find(
      (row) => row.externalSessionId !== HEALTHY_SESSION_ID
    );
    expect(poisonRow).toBeDefined();
    for (const value of [
      poisonRow?.externalSessionId ?? "",
      poisonRow?.fileKey ?? "",
    ]) {
      expect(value.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(value, "utf8")).toBeLessThan(
        BTREE_INDEX_TUPLE_MAX_BYTES
      );
    }
    // `objectStorageKey` is DERIVED from the two columns above, so it must be
    // minted from the SAME projected identity the columns hold rather than from
    // the raw wire pair. Asserted as identity agreement, not as a byte budget:
    // the raw value must be absent from the key, and both stored columns must
    // appear in it verbatim.
    expect(poisonRow?.objectStorageKey).not.toContain(OVER_LIMIT_VALUE);
    expect(poisonRow?.objectStorageKey).not.toContain(OVER_LIMIT_ALTERNATE);
    expect(poisonRow?.objectStorageKey).toContain(
      poisonRow?.externalSessionId ?? ""
    );
    // ISS-8125 (review, whitlockk): the derived key must fit S3 too, not just the
    // btree tuple. `defaultS3Port` passes this string straight through, so a key
    // over the 1024-byte limit is a request the API accepts and S3 then rejects
    // — the row lands and the bytes never do. A per-string budget of 512 built
    // 1105 bytes here, so `fileKey` gives way to `TRANSCRIPT_FILE_KEY_MAX_BYTES`
    // — solved from THIS limit — while `externalSessionId` keeps the shared
    // budget its cross-table joins need. Asserted against S3's own number, never
    // against the constant under test, so a regression in the budget fails here
    // instead of moving with the bug.
    expect(
      Buffer.byteLength(poisonRow?.objectStorageKey ?? "", "utf8")
    ).toBeLessThanOrEqual(S3_OBJECT_KEY_MAX_BYTES);
    // The subagent namespace survives the bound: a projected file key that lost
    // its prefix would reshape the S3 key into the main-transcript namespace.
    expect(poisonRow?.fileKey.startsWith("subagent:")).toBe(true);
  });

  it("re-planning the same over-long transcript identity resolves to the same row", async () => {
    const fixture = await createFixture("iss-8125-transcripts-idempotent");
    const request = {
      ...planRequest(`ext-poison-${OVER_LIMIT_VALUE}`, "main"),
      computeTargetId: fixture.computeTargetId,
    };
    const auth = {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      clerkUserId: null,
    };

    expect(
      (
        await transcriptSyncService.planSync({
          ...auth,
          request,
          deps: transcriptDeps(s3Port()),
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await transcriptSyncService.planSync({
          ...auth,
          request,
          deps: transcriptDeps(s3Port()),
        })
      ).ok
    ).toBe(true);

    expect(await readTranscripts(fixture.computeTargetId)).toHaveLength(1);
  });

  it("re-links an orphaned over-long transcript to the session that arrived after it", async () => {
    // ISS-8125 (operator review) — the landmine a projected transcript column
    // introduces. `SessionTranscript` and `SessionDetail` carry the SAME session
    // identity, and the orphan backfill is the one reader that has only the
    // stored transcript value to go on: it cannot recover the raw id, so the two
    // columns must agree byte-for-byte and the stored value must not be
    // re-projected (`projectIndexKey` is not idempotent — ISS-8254).
    //
    // Driven end to end because both halves are needed to fail: a transcript-
    // local budget puts the columns on different strings, and a re-projection
    // lands on a third. Either one leaves the row orphaned forever while the run
    // reports it as "awaiting session metadata".
    const fixture = await createFixture("iss-8125-transcripts-orphan-relink");
    const sessionId = `ext-orphan-${OVER_LIMIT_VALUE}`;

    // The transcript is planned BEFORE any session metadata exists, so
    // `resolveSessionDetailId` finds nothing and the row lands orphaned — the
    // exact population this backfill exists for.
    const planned = await transcriptSyncService.planSync({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      clerkUserId: null,
      request: {
        ...planRequest(sessionId, "main"),
        computeTargetId: fixture.computeTargetId,
      },
      deps: transcriptDeps(s3Port()),
    });
    expect(planned.ok ? null : planned.error).toBeNull();
    const orphan = await withDb((db) =>
      db.sessionTranscript.findFirst({
        where: { computeTargetId: fixture.computeTargetId },
        select: { id: true, sessionDetailId: true, externalSessionId: true },
      })
    );
    expect(orphan?.sessionDetailId).toBeNull();

    await agentSessionsService.upsertSessions(
      {
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        computeTargetId: fixture.computeTargetId,
      },
      buildSessionsPayload([buildSession({ externalSessionId: sessionId })])
    );
    const detail = await withDb((db) =>
      db.sessionDetail.findFirst({
        where: { computeTargetId: fixture.computeTargetId },
        select: { artifactId: true, externalSessionId: true },
      })
    );
    // One identity, one stored key. This is what makes the join expressible at
    // all: the backfill has no route from one budget's projection to another's.
    expect(orphan?.externalSessionId).toBe(detail?.externalSessionId);

    await withDb((db) => backfillOrphanTranscriptsBatch(db));

    // Asserted on the ROW, not on the batch's `linked` tally: the scan is not
    // org-scoped, so a sibling suite's orphan could inflate the count.
    const relinked = await withDb((db) =>
      db.sessionTranscript.findUnique({
        where: { id: orphan?.id ?? "" },
        select: { sessionDetailId: true },
      })
    );
    expect(relinked?.sessionDetailId).toBe(detail?.artifactId);
  });
});
