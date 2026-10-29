/**
 * @file invocation-sync-fixtures.ts
 * @description Shared fixtures for the invocation-sync suites — the on-disk agent
 * database and the skill-bearing session that materializes exactly one invocation
 * generation.
 *
 * Extracted (ISS-5789) so the materialization suite and the promotion-step suite
 * build their corpus from ONE definition rather than a copy each. Both suites
 * assert on generation identity and outbox rows, so a drifted fixture would make
 * two suites disagree about the same protocol.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import {
  AgentComponentInvocationSyncService,
  type AgentComponentInvocationSyncSource,
} from "../../src/main/agent-sync/agent-component-invocation-sync-service.js";
import {
  classifyInvocationSyncOutboxIntegrity,
  type InvocationSyncOutboxIntegrityResult,
} from "../../src/main/database/invocation-sync-outbox-integrity.js";
import { openSqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import type { StoreIntegrityIssue } from "../../src/main/telemetry/telemetry-protocol.js";
import { makeSession } from "../normalized-session-test-utils.js";

export const NOW = "2026-07-22T17:00:00.000Z";
export const SKILL_CONTENT_V1 = "---\nname: review\n---\nReview carefully.\n";
export const SKILL_CONTENT_V2 =
  "---\nname: review\n---\nReview adversarially.\n";

export type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

/** A temp directory holding one isolated agent database. */
export function makeInvocationSyncDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export function openDb(
  dir: string,
  log?: (message: string) => void
): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
    ...(log ? { log } : {}),
  });
}

/**
 * A session whose only components are `review` skill invocations, one per entry in
 * `contents`. Each skill is paired with the `Skill` tool use that carries it, which
 * is what makes the session substantive to the sync boundary.
 */
export function skillSession(
  sessionId: string,
  contents: readonly string[]
): ReturnType<typeof makeSession> {
  const skills = contents.map((content, index) => {
    const providerToolUseId = `toolu_skill_${index}`;
    const timestamp = `2026-07-22T17:00:0${index}.000Z`;
    const definitionSnapshot = {
      kind: "skill" as const,
      rawName: "review",
      normalizedName: "review",
      content,
      capturedAt: timestamp,
    };
    return {
      name: "review",
      rawName: "review",
      normalizedName: "review",
      timestamp,
      providerToolUseId,
      definitionSnapshot,
    };
  });
  return makeSession({
    sessionId,
    startedAt: NOW,
    endedAt: "2026-07-22T17:05:00.000Z",
    skills,
    toolUses: skills.map((skill) => ({
      name: "Skill",
      kind: "harness" as const,
      timestamp: skill.timestamp,
      id: skill.providerToolUseId,
      providerToolUseId: skill.providerToolUseId,
      skillName: skill.name,
      definitionSnapshot: skill.definitionSnapshot,
    })),
  });
}

/** The delivery-queue rows for one session under one target, oldest column set. */
export function deliveryRows(
  db: Db,
  targetSourceKey: string,
  sessionId: string
): Promise<
  {
    external_generation_id: string;
    status: string;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }[]
> {
  return db.prisma.client.$queryRawUnsafe(
    `SELECT external_generation_id, status, last_error, created_at, updated_at
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND external_session_id = $2
      ORDER BY part_index`,
    targetSourceKey,
    sessionId
  );
}

/**
 * The real service over the real store, answering every send with
 * `session_missing` — the ack that exposes both the corrupt row's unusable age
 * (ISS-6209) and the spent retry horizon of a part whose parent never arrived
 * (ISS-5855).
 *
 * The clock is pinned to {@link NOW}, so a case decides which of those it is
 * driving by aging the row's `created_at`, never by moving the clock.
 */
export function sessionMissingService(
  db: Db,
  computeTargetId: string
): AgentComponentInvocationSyncService {
  return new AgentComponentInvocationSyncService({
    isReady: () => true,
    getSource: () => realInvocationSyncSource(db),
    getComputeTargetId: () => computeTargetId,
    sendPart: (pending) =>
      Promise.resolve({
        kind: "ack" as const,
        ack: {
          accepted: false as const,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
        },
      }),
    now: () => new Date(NOW),
  });
}

/**
 * The on-disk sync source narrowed to the lane's contract. The store declares these
 * methods optional, so a missing one is turned into a named failure here rather than
 * surfacing as an unrelated `TypeError` deep inside the service, where it would read
 * like a production fault instead of a fixture gap.
 *
 * A plain `throw` rather than an `assert` because this runs outside a `test()` body,
 * where Biome's `noAssertionsInTests` (correctly) refuses one.
 */
export function realInvocationSyncSource(
  db: Db
): AgentComponentInvocationSyncSource {
  const prepare = db.syncSource.prepareInvocationSyncTarget;
  const load = db.syncSource.loadReadyInvocationSyncParts;
  const retry = db.syncSource.recordInvocationSyncRetry;
  const clear = db.syncSource.clearAcknowledgedInvocationSyncPart;
  const deadLetter = db.syncSource.deadLetterInvocationSyncPart;
  const recover = db.syncSource.recoverInvocationSyncDeadLetters;
  if (!(prepare && load && retry && clear && deadLetter && recover)) {
    throw new Error(
      "the on-disk sync source does not implement the invocation lane contract"
    );
  }
  return {
    prepareInvocationSyncTarget: prepare,
    loadReadyInvocationSyncParts: load,
    recoverInvocationSyncDeadLetters: recover,
    recordInvocationSyncRetry: retry,
    clearAcknowledgedInvocationSyncPart: clear,
    deadLetterInvocationSyncPart: deadLetter,
  };
}

/** Run the production classifier over a scan result. */
export function collectInvocationSyncOutboxIssues(
  result: InvocationSyncOutboxIntegrityResult
): StoreIntegrityIssue[] {
  const issues: StoreIntegrityIssue[] = [];
  classifyInvocationSyncOutboxIntegrity(result, issues);
  return issues;
}
