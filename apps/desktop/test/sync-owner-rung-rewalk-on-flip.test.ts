/**
 * @file sync-owner-rung-rewalk-on-flip.test.ts
 * @description ISS-12552: a running session lane spends the
 * one owner-carrying re-walk a flip to on owes.
 *
 * The lane compares its durable cursor's integrity stamp against the owner
 * rung only when it hydrates, and a running lane hydrates once per identity.
 * A session synced while the attribution policy was off went without its
 * operation evidence and token-event owners, and nothing in it changes when
 * the organization is turned on, so only that re-walk can carry them up.
 *
 * Composed the way `app.ts` composes the lanes, over the real SQLite source
 * and the real controller, with the network the only fake: every request is
 * intercepted at `fetch`. The payload preparer is the in-process one the
 * service falls back to, because the worker entry is a built artifact.
 */
import "./support/attribution-parse-policy.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OperationReceiptOutcome } from "@repo/api/src/types/attribution-evidence";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { ToolResultState } from "@repo/api/src/types/operation-claims";
import { PARENT_AGENT_EXTERNAL_ID } from "@repo/api/src/types/token-event-agent-owner";
import { afterEach, beforeEach, test } from "vitest";
import { inProcessAgentSessionPayloadPreparer } from "../src/main/agent-sync/agent-session-payload-preparation.js";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import {
  type AgentSessionSyncSource,
  buildAgentSessionSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { createDesktopSyncLanes } from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  AGENT_SESSION_SYNC_INTEGRITY_VERSION,
  AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER,
} from "../src/main/database/sync-cursor-state.js";
import { beginAttributionOwnersRebuild } from "../src/main/parse-policy/attribution-owners-derived.js";
import { createParsePolicyController } from "../src/main/parse-policy/parse-policy-resolver.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { pumpSyncDrainTurn } from "./agent-session-sync-service-fixtures.js";
import { fakeDesktopSyncLaneDeps } from "./fake-desktop-sync-lane-deps.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "iss12552-owner-rung-rewalk";
const ORGANIZATION = "org-owner-rung";
const COMPUTE_TARGET = "owner-rung-target";
const SUBAGENT_ID = "agent-lane";
const OPERATION_ID = "clop_01a14224-9b59-77ba-b518-16aaa9880991";
const SYNC_PATH = "/desktop/agent-sessions/sync";
/** How many drain turns to pump before declaring the lane wedged. */
const DRAIN_TURNS = 400;

const originalFetch = globalThis.fetch;
let dir: string;
let db: SqliteAgentDatabase;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "iss12552-owner-rung-"));
  db = await openTestDb(dir);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

test("re-sends an unchanged session with its evidence and owners once a flip to on derives owners", async () => {
  // Imported under the attribution policy, so its claims and owners are
  // stored; nothing below re-imports or rebuilds it.
  await db.importer.importSession(sessionWithClaims(), "claude");
  const policy = startPolicyController(null);
  const lane = composeLane(db.syncSource);
  lane.service.start();
  try {
    await pumpUntil(
      () => lane.posted().length > 0 && lane.service.getSyncProgress().caughtUp,
      "the off-policy sync"
    );
    const [offSend] = lane.posted();
    assert.equal(offSend?.externalSessionId, SESSION_ID);
    assert.equal("operationEvidence" in (offSend ?? {}), false);
    assert.equal(
      await storedIntegrityStamp(),
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER
    );

    policy.answer(true);
    await pumpUntil(
      () => lane.posted().some((session) => session.operationEvidence),
      "the owner-carrying re-send after the flip to on"
    );

    const onSend = lane.posted().find((session) => session.operationEvidence);
    assert.equal(onSend?.externalSessionId, SESSION_ID);
    assert.deepEqual(
      onSend?.operationEvidence?.claims.flatMap((claim) => claim.operationIds),
      [OPERATION_ID]
    );
    assert.deepEqual(
      onSend?.tokenEvents?.map((event) => event.agentExternalId),
      [PARENT_AGENT_EXTERNAL_ID, SUBAGENT_ID]
    );
    await pumpUntil(
      () => lane.service.getSyncProgress().caughtUp,
      "the re-walk to settle"
    );
    assert.equal(
      await storedIntegrityStamp(),
      AGENT_SESSION_SYNC_INTEGRITY_VERSION
    );
  } finally {
    lane.service.stop();
    policy.dispose();
  }
});

test("a flip to off forces no re-hydration and no re-send", async () => {
  await db.importer.importSession(sessionWithClaims(), "claude");
  const policy = startPolicyController(ORGANIZATION);
  const source = countingCursorLoads(db.syncSource);
  const lane = composeLane(source.source);
  lane.service.start();
  try {
    await pumpUntil(
      () => lane.posted().length > 0 && lane.service.getSyncProgress().caughtUp,
      "the on-policy sync"
    );
    assert.equal(
      await storedIntegrityStamp(),
      AGENT_SESSION_SYNC_INTEGRITY_VERSION
    );
    const postedBeforeFlip = lane.posted().length;
    assert.equal(source.loads(), 1);

    policy.answer(false);
    lane.service.refresh();
    await pumpUntil(
      () => lane.service.getSyncProgress().caughtUp,
      "the lane to settle after the flip to off"
    );

    assert.equal(source.loads(), 1, "the cursor was re-read");
    assert.equal(lane.posted().length, postedBeforeFlip);
  } finally {
    lane.service.stop();
    policy.dispose();
  }
});

/**
 * The production controller over a fake verdict. A settled flip runs what the
 * post-boot maintenance rerun runs around the rebuild, with nothing for the
 * rebuild to change: the session is already derived as it would be.
 */
function startPolicyController(initialOnFor: string | null) {
  let persisted = initialOnFor;
  let verdict = initialOnFor !== null;
  let listener: (() => void) | null = null;
  const controller = createParsePolicyController({
    readPersisted: () => persisted,
    persist: (onFor) => {
      persisted = onFor;
    },
    readOrganization: () => ORGANIZATION,
    readVerdict: () => verdict,
    readOverride: () => undefined,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    onFlip: () => {
      beginAttributionOwnersRebuild()();
    },
    holdMs: 0,
  });
  controller.start();
  return {
    answer(on: boolean) {
      verdict = on;
      listener?.();
    },
    dispose: () => controller.dispose(),
  };
}

function composeLane(source: AgentSessionSyncSource): {
  service: AgentSessionSyncService;
  posted: () => SyncedAgentSession[];
} {
  const batches: AgentSessionSyncBatch[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === SYNC_PATH) {
      batches.push(JSON.parse(String(init?.body)) as AgentSessionSyncBatch);
      return Promise.resolve(
        Response.json({ success: true, data: { synced: true } })
      );
    }
    return Promise.resolve(Response.json({ success: true, data: {} }));
  }) as typeof fetch;
  const account = { organizationId: ORGANIZATION, userId: "user-1" };
  const lanes = createDesktopSyncLanes(
    fakeDesktopSyncLaneDeps({
      desktopSessionManager: {
        getAccessToken: () => Promise.resolve("session-token"),
        getAccountAdmission: () => ({ ...account, generation: 1 }),
        getIdentity: () => account,
        invalidateAccessToken: () => undefined,
      },
      getDataSyncLevel: () => DataSyncLevel.Full,
      getSyncComputeTargetId: () => COMPUTE_TARGET,
      isHttpAgentSessionSyncReady: () => true,
      isSyncSpanExtentSupported: () => true,
      isSyncHumanTurnTimestampsSupported: () => true,
      isSyncAgentTurnTimestampsSupported: () => true,
      isSyncTokenEventOwnerSupported: () => true,
      getSyncSource: () => source,
      preparePayloads: inProcessAgentSessionPayloadPreparer,
    })
  );
  return {
    service: lanes.agentSessionSync,
    posted: () => batches.flatMap((batch) => batch.sessions),
  };
}

/**
 * The real source, counting how often the session lane loads its durable
 * cursor. The component lane loads its own through the same method.
 */
function countingCursorLoads(source: AgentSessionSyncSource): {
  source: AgentSessionSyncSource;
  loads: () => number;
} {
  const sessionKey = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
  let loads = 0;
  const counted = new Proxy(source, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === "loadSyncState" && typeof value === "function") {
        return (...args: unknown[]) => {
          if (args[0] === sessionKey) {
            loads += 1;
          }
          return Reflect.apply(value, target, args);
        };
      }
      return value;
    },
  });
  return { source: counted, loads: () => loads };
}

async function pumpUntil(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < DRAIN_TURNS; turn += 1) {
    if (done()) {
      return;
    }
    await pumpSyncDrainTurn();
  }
  throw new Error(`${what} never happened after ${DRAIN_TURNS} turns`);
}

async function storedIntegrityStamp(): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { sync_integrity_version: number | bigint | null }[]
  >(
    "SELECT sync_integrity_version FROM sync_state WHERE source_key = $1",
    buildAgentSessionSyncSourceKey(COMPUTE_TARGET)
  );
  if (rows.length !== 1) {
    throw new Error(`expected one session cursor row, found ${rows.length}`);
  }
  const stamp = rows[0]?.sync_integrity_version;
  return stamp === null || stamp === undefined ? null : Number(stamp);
}

function sessionWithClaims(): NormalizedSession {
  return makePopulatedSession({
    sessionId: SESSION_ID,
    toolUses: [
      {
        name: "mcp__closedloop__create-document-version",
        id: "toolu_write",
        timestamp: "2026-06-07T10:00:20.000Z",
        resultTimestamp: "2026-06-07T10:00:21.000Z",
        input: { documentId: "PLN-2191", content: "next" },
        output: "{}",
        resultState: ToolResultState.Present,
        closedloopResultFacts: {
          isError: false,
          operationReceipt: {
            operationId: OPERATION_ID,
            outcome: OperationReceiptOutcome.Committed,
          },
          nestedSlugs: [],
        },
      },
    ],
    tokenSeries: [
      {
        timestamp: "2026-06-07T10:00:30.000Z",
        model: "claude-sonnet-4-5",
        input: 60,
        output: 30,
        cacheRead: 6,
        cacheWrite: 3,
      },
      {
        timestamp: "2026-06-07T10:00:40.000Z",
        model: "claude-sonnet-4-5",
        input: 40,
        output: 20,
        cacheRead: 4,
        cacheWrite: 2,
        subagentId: SUBAGENT_ID,
      },
    ],
  });
}
