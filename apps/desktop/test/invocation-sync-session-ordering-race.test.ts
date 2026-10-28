/**
 * @file invocation-sync-session-ordering-race.test.ts
 * @description ISS-10912 — an invocation part that reaches the cloud before its
 * parent session, through the real lane over a real store: the raced part is
 * retried to acceptance, a part whose parent never arrives reaches a terminal
 * state, and the live harness's tally counts the retries as deferred, not
 * rejected. It runs on the PR lane; the live harness runs only in the scheduled
 * candidate cut.
 *
 * The cloud is the only fake. Each send goes through the production batch mapper
 * into the harness tally, the tee `desktop-sync-lane-composition.ts` makes.
 */
import { rm } from "node:fs/promises";
import { SyncLane } from "@closedloop-ai/telemetry-contract/sync";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { afterEach, describe, expect, it } from "vitest";
import {
  type LiveSyncObservations,
  tallySyncBatch,
} from "../scripts/live-sync-harness-report.js";
import {
  AgentComponentInvocationSyncLocalError,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { AgentComponentInvocationSyncService } from "../src/main/agent-sync/agent-component-invocation-sync-service.js";
import {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  SESSION_MISSING_MAX_RETRY_AGE_MS,
} from "../src/main/agent-sync/invocation-sync-rejection-policy.js";
import { invocationPartBatchEvent } from "../src/main/agent-sync/sync-lane-cloud-health.js";
import type { AgentComponentInvocationSyncClientResult } from "../src/main/dashboard/desktop-agent-component-invocations-client.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  type Db,
  deliveryRows,
  makeInvocationSyncDir,
  openDb,
  realInvocationSyncSource,
  SKILL_CONTENT_V1,
  skillSession,
} from "./helpers/invocation-sync-fixtures.js";

const RACED_SESSION_ID = "session-raced-parent";
const ORPHAN_SESSION_ID = "session-orphan-parent";
const COMPUTE_TARGET_ID = "target-ordering-race";
const TARGET_SOURCE_KEY =
  buildAgentComponentInvocationSyncSourceKey(COMPUTE_TARGET_ID);

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("ISS-10912 a part that outran its parent session", () => {
  it("is retried to acceptance, while a part whose parent never lands is abandoned at the horizon", async () => {
    const dir = await makeInvocationSyncDir("aci-ordering-race-");
    const db = await openDb(dir);
    cleanup = async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    };
    await importSkillSession(db, RACED_SESSION_ID);
    await importSkillSession(db, ORPHAN_SESSION_ID);

    const cloud = new SessionGatedCloud();
    const observations: LiveSyncObservations = {
      lanes: new Map(),
      syncFailures: [],
      rejectedDetails: [],
    };
    // Real time, not the fixture's July `NOW`: promotion stamps `created_at` from
    // the wall clock, and the horizon is measured from that stamp.
    const startMs = Date.now();
    let clockMs = startMs;
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => realInvocationSyncSource(db),
      getComputeTargetId: () => COMPUTE_TARGET_ID,
      sendPart: (part) => {
        const result = cloud.answer(part);
        tallySyncBatch(observations, invocationPartBatchEvent(result));
        return Promise.resolve(result);
      },
      now: () => new Date(clockMs),
    });

    await service.syncOnce();

    expect(await statuses(db)).toEqual({
      raced: [OutboxStatus.Pending],
      orphan: [OutboxStatus.Pending],
    });

    cloud.land(RACED_SESSION_ID);
    clockMs = startMs + RETRY_BASE_MS + 1000;
    await service.syncOnce();

    expect(await statuses(db)).toEqual({
      raced: [],
      orphan: [OutboxStatus.Pending],
    });
    expect(cloud.accepted).toEqual([RACED_SESSION_ID]);

    clockMs = startMs + SESSION_MISSING_MAX_RETRY_AGE_MS + RETRY_MAX_MS;
    await service.syncOnce();

    const orphanRows = await deliveryRows(
      db,
      TARGET_SOURCE_KEY,
      ORPHAN_SESSION_ID
    );
    expect(orphanRows.map((row) => [row.status, row.last_error])).toEqual([
      [
        OutboxStatus.DeadLettered,
        AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted,
      ],
    ]);
    expect(service.deadLetteredPartCount).toBe(1);
    expect(observations.lanes.get(SyncLane.InvocationParts)).toEqual({
      lane: SyncLane.InvocationParts,
      accepted: 1,
      rejected: 0,
      deferred: 4,
      deadLettered: 0,
      reasons: [],
    });
  });
});

/**
 * The cloud's half of the race: `ingestPartInTx` answers `session_missing` until
 * the parent session row exists, which here is until the case lands it.
 */
class SessionGatedCloud {
  readonly accepted: string[] = [];
  private readonly landed = new Set<string>();

  land(sessionId: string): void {
    this.landed.add(sessionId);
  }

  answer(
    part: AgentComponentInvocationSyncPart
  ): AgentComponentInvocationSyncClientResult {
    const identity = {
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      externalGenerationId: part.externalGenerationId,
      partIndex: part.partIndex,
      partHash: part.partHash,
    };
    if (!this.landed.has(part.externalSessionId)) {
      return {
        kind: "ack",
        ack: {
          ...identity,
          accepted: false,
          reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
        },
      };
    }
    this.accepted.push(part.externalSessionId);
    return {
      kind: "ack",
      ack: {
        ...identity,
        accepted: true,
        state: AgentComponentInvocationSyncAckState.Activated,
      },
    };
  }
}

async function importSkillSession(db: Db, sessionId: string): Promise<void> {
  await db.importer.importSession(
    skillSession(sessionId, [SKILL_CONTENT_V1]),
    "claude"
  );
}

async function statuses(
  db: Db
): Promise<{ raced: string[]; orphan: string[] }> {
  const raced = await deliveryRows(db, TARGET_SOURCE_KEY, RACED_SESSION_ID);
  const orphan = await deliveryRows(db, TARGET_SOURCE_KEY, ORPHAN_SESSION_ID);
  return {
    raced: raced.map((row) => row.status),
    orphan: orphan.map((row) => row.status),
  };
}
