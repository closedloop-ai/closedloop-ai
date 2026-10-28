import { createHash } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { createTestUser } from "@/__tests__/utils/db-helpers";

/**
 * Shared fixtures for the index-key poison-batch integration suites (ISS-8069's
 * `index-key-poison-batch.integration.test.ts` and ISS-8125's
 * `index-key-poison-batch-usage-transcripts.integration.test.ts`).
 *
 * Extracted rather than copied: the over-limit generator below is the one piece
 * of these suites that is easy to get subtly, silently wrong, and a second copy
 * is a second chance to get it wrong.
 */

/**
 * Postgres's own limit, quoted rather than imported from the code under test:
 * `index row size N exceeds btree version 4 maximum 2704 for index "..."`. This
 * is the number the production failure is stated in, so it is the number the
 * assertions use. Sizing an expectation from `INDEX_KEY_MAX_BYTES` would move
 * the test with the bug instead of catching it.
 */
export const BTREE_INDEX_TUPLE_MAX_BYTES = 2704;

/**
 * S3's own object-key limit. `SessionTranscript.objectStorageKey` is DERIVED
 * from the same two strings the index tuple holds, so a fix that bounds only the
 * columns trades a Postgres throw for an S3 one.
 */
export const S3_OBJECT_KEY_MAX_BYTES = 1024;

/**
 * A deterministic HIGH-ENTROPY value past the btree limit.
 *
 * The entropy is load-bearing and the ISS-8069 suite was briefly wrong without
 * it. An index tuple cannot be TOASTed out of line but it CAN be compressed
 * inline, so `"q".repeat(4096)` is accepted by the engine — PGLZ folds it to
 * nothing and no limit is ever reached. Re-measured for ISS-8125 against this
 * suite's own Postgres 16, inserting straight into
 * `agent_component_session_usage`: `"q".repeat(4096)` clears
 * `idx_acsu_session_kind_key_branch` and fails later on the foreign key, while
 * the hash chain below raises the production error, `index row size 4136 exceeds
 * btree version 4 maximum 2704`.
 *
 * So a low-entropy fixture makes a suite of this class a false green: it would
 * pass on the unfixed code for the wrong reason. Chained sha256 hex is
 * reproducible across runs and machines and does not compress.
 */
export function overLimitValue(seed: string): string {
  let digest = seed;
  let out = "";
  while (out.length < 4096) {
    digest = createHash("sha256").update(digest).digest("hex");
    out += digest;
  }
  return out.slice(0, 4096);
}

/**
 * A value in the AT-RISK BAND — the only population a legacy-row fixture may be
 * built from, and getting this wrong is a hard failure rather than a false
 * green, which is why it lives here beside `overLimitValue`.
 *
 * The band is `(INDEX_KEY_MAX_BYTES, 2704]`: past the projection budget, so
 * ISS-8125 re-keys it, but small enough that a whole index tuple still fits, so
 * a row carrying it COULD already have been written before this repo projected
 * the column. Nothing above 2704 can be a legacy row — the engine refused the
 * write, which is the defect ISS-8125 exists to fix. Measured: a raw INSERT of
 * `overLimitValue()` into `agent_component_session_usage` raises `index row size
 * 4152 exceeds btree version 4 maximum 2704`, so it cannot seed one.
 *
 * 600 bytes: comfortably past the 512-byte budget, and leaving the rest of the
 * tuple two kilobytes of room. High-entropy for the same reason its parent is —
 * a compressible prefix would not be a faithful stand-in.
 */
export function legacyStorableValue(seed: string): string {
  return overLimitValue(seed).slice(0, 600);
}

/** The compute target + user every poison-batch case syncs through. */
export async function createSyncFixture(
  organizationId: string,
  machineName: string
): Promise<{
  organizationId: string;
  userId: string;
  computeTargetId: string;
}> {
  const user = await createTestUser(organizationId);
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName,
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  return { organizationId, userId: user.id, computeTargetId: target.id };
}

export const SESSION_STARTED_AT = new Date("2026-08-24T10:00:00.000Z");
export const SESSION_UPDATED_AT = new Date("2026-08-24T11:00:00.000Z");
export const HEALTHY_SESSION_ID = "ext-healthy-sibling";
export const HEALTHY_HARNESS = "claude-code";

export function buildSession(
  overrides: Partial<SyncedAgentSession>
): SyncedAgentSession {
  return {
    externalSessionId: HEALTHY_SESSION_ID,
    name: "index-key poison session",
    status: "active",
    harness: HEALTHY_HARNESS,
    cwd: "/tmp/worktree",
    model: "claude-opus",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    artifactRefs: [],
    ...overrides,
  } as SyncedAgentSession;
}

export function buildSessionsPayload(
  sessions: SyncedAgentSession[]
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "8b1f0c72-5f4e-4a1d-9b7e-0f5a1c2d3e4c",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}
