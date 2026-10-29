/**
 * ISS-12552: a token event's owner (`agentExternalId`) reaches the cloud only
 * when the connected server advertised `agentSessionSyncTokenEventOwner`. An
 * older server rejects an owner that differs from the one it stored, and every
 * event it holds was stored without one, so sending owners to it would fail the
 * resync of every session it already has.
 */
import assert from "node:assert/strict";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { OPERATION_EVIDENCE_EXTRACTOR_VERSION } from "@repo/api/src/types/operation-claims";
import { PARENT_AGENT_EXTERNAL_ID } from "@repo/api/src/types/token-event-agent-owner";
import { test } from "vitest";
import {
  capabilitiesFromHelloAck,
  captureAgentSessionSyncCapabilities,
  NO_AGENT_SESSION_SYNC_CAPABILITIES,
  resolveSyncCapabilityDowngrade,
  resolveSyncContractCapabilities,
  SyncCapabilityDowngrade,
} from "../src/main/agent-sync/agent-session-sync-capabilities.js";
import { identitySyncPayloadSizer } from "../src/main/agent-sync/agent-session-sync-compression.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { buildAgentSessionSyncBatch } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  accumulatePreparedPayloads,
  type PendingChunks,
  type PreparedPayloadAccumulator,
  resolvePendingChunkTransition,
} from "../src/main/agent-sync/agent-session-sync-pending-chunks.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type {
  AgentSessionSyncProgress,
  AgentSessionSyncServiceOptions,
} from "../src/main/agent-sync/agent-session-sync-service-options.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  AGENT_SESSION_SYNC_INTEGRITY_VERSION,
  AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER,
  resolveAgentSessionSyncIntegrityVersion,
  sessionSyncIntegrityCursorIsStale,
  syncStateContractStamps,
} from "../src/main/database/sync-cursor-state.js";
import { PARSE_POLICY_BASE } from "../src/main/parse-policy/parse-policy.js";
import { pumpSyncDrainTurn } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";
import { withParsePolicy } from "./support/attribution-parse-policy.js";

const COMPUTE_TARGET = "token-event-owner-target";
const MAX_SETTLE_TURNS = 400;
const SUBAGENT_ID = "agent-a1";
const OVERSIZED_TOKEN_EVENTS = 4000;

function sessionWithOwnedTokenEvents(): SyncedAgentSession {
  return {
    ...makeSyncedSession("owned", "2026-10-19T12:00:00.000Z"),
    tokenEvents: [
      tokenEvent("event-parent", PARENT_AGENT_EXTERNAL_ID),
      tokenEvent("event-subagent", SUBAGENT_ID),
    ],
    // Evidence a stored claims row still carries, as one left from an on
    // period would.
    operationEvidence: {
      extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
      digest: "0".repeat(64),
      coverage: {
        harness: "claude",
        evidencePathSupported: true,
        closedloopMcpCalls: 0,
        shellCallsWithOperationIds: 0,
        directApiShellCommands: 0,
        unsupportedToolNames: {},
        claimsDroppedByCap: 0,
      },
      claims: [],
    },
  };
}

function tokenEvent(externalEventId: string, agentExternalId: string) {
  return {
    externalEventId,
    agentExternalId,
    model: "claude-opus-5-5",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    createdAt: "2026-10-19T12:00:00.000Z",
  };
}

async function sentTokenEvents(
  ownersAccepted: boolean
): Promise<SyncedAgentSession["tokenEvents"]> {
  return (await sentSession(ownersAccepted)).tokenEvents;
}

async function sentSession(
  ownersAccepted: boolean
): Promise<SyncedAgentSession> {
  const sent: SyncedAgentSession[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => new FakeSyncSource([sessionWithOwnedTokenEvents()]),
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    isSyncTokenEventOwnerSupported: () => ownersAccepted,
    sendBatch: (batch) => {
      sent.push(...batch.sessions);
      return Promise.resolve({ accepted: true });
    },
  });
  service.start();
  try {
    await settle(service);
  } finally {
    service.stop();
  }
  const [session] = sent;
  if (!session) {
    throw new Error("the session was never sent");
  }
  return session;
}

async function settle(service: AgentSessionSyncService): Promise<void> {
  const settled = (progress: AgentSessionSyncProgress) =>
    progress.caughtUp &&
    progress.pendingBackfillSessions === 0 &&
    progress.pendingIncrementalSessions === 0;
  for (let turn = 0; turn < MAX_SETTLE_TURNS; turn += 1) {
    if (settled(service.getSyncProgress())) {
      return;
    }
    await pumpSyncDrainTurn();
  }
  throw new Error(`sync never settled after ${MAX_SETTLE_TURNS} turns`);
}

test("omits token-event owners for a server that never advertised them", async () => {
  const events = await sentTokenEvents(false);

  assert.equal(events?.length, 2);
  for (const event of events ?? []) {
    assert.equal("agentExternalId" in event, false);
  }
});

test("sends token-event owners to a server that advertised them", async () => {
  const events = await sentTokenEvents(true);

  assert.deepEqual(
    events?.map((event) => event.agentExternalId),
    [PARENT_AGENT_EXTERNAL_ID, SUBAGENT_ID]
  );
});

test("omits every owner, the parent marker included, with the attribution policy off", async () => {
  const events = await withParsePolicy(PARSE_POLICY_BASE, () =>
    sentTokenEvents(true)
  );

  assert.equal(events?.length, 2);
  for (const event of events ?? []) {
    assert.equal("agentExternalId" in event, false);
  }
});

test("sends no operation evidence with the attribution policy off, even evidence still stored", async () => {
  const off = await withParsePolicy(PARSE_POLICY_BASE, () => sentSession(true));
  const on = await sentSession(true);

  assert.equal("operationEvidence" in off, false);
  assert.equal(on.operationEvidence?.digest, "0".repeat(64));
});

test("captures owners as supported only under the attribution policy", async () => {
  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    isSyncTokenEventOwnerSupported: () => true,
    sendBatch: () => Promise.resolve({ accepted: true }),
  };
  assert.equal(
    captureAgentSessionSyncCapabilities(options).tokenEventOwner,
    true
  );
  assert.equal(
    await withParsePolicy(PARSE_POLICY_BASE, () =>
      captureAgentSessionSyncCapabilities(options)
    ).then((captured) => captured.tokenEventOwner),
    false
  );
});

test("reads the owner capability from the hello ack", () => {
  assert.equal(
    capabilitiesFromHelloAck({ agentSessionSyncTokenEventOwner: true })
      .tokenEventOwner,
    true
  );
  assert.equal(capabilitiesFromHelloAck({}).tokenEventOwner, false);
  assert.equal(capabilitiesFromHelloAck(undefined).tokenEventOwner, false);
});

test("defers a batch built with owners when the server stops accepting them", () => {
  const withOwners = {
    ...NO_AGENT_SESSION_SYNC_CAPABILITIES,
    tokenEventOwner: true,
  };

  assert.equal(
    resolveSyncCapabilityDowngrade({
      isPendingChunkDrain: false,
      captured: withOwners,
      current: NO_AGENT_SESSION_SYNC_CAPABILITIES,
    }),
    SyncCapabilityDowngrade.TokenEventOwner
  );
  assert.equal(
    resolveSyncCapabilityDowngrade({
      isPendingChunkDrain: false,
      captured: NO_AGENT_SESSION_SYNC_CAPABILITIES,
      current: withOwners,
    }),
    null
  );
});

test("replays once on the first server that accepts owners, after one that did not", () => {
  const sessionKey = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
  const withoutOwners = {
    spanExtent: true,
    humanTurnTimestamps: true,
    agentTurnTimestamps: true,
    tokenEventOwner: false,
  };
  const withOwners = { ...withoutOwners, tokenEventOwner: true };

  assert.equal(
    resolveAgentSessionSyncIntegrityVersion(withoutOwners),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER
  );
  assert.equal(
    resolveAgentSessionSyncIntegrityVersion(withOwners),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION
  );
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER,
      withoutOwners
    ),
    false
  );
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER,
      withOwners
    ),
    true
  );
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION,
      withOwners
    ),
    false
  );
});

test("keeps a Desktop that is off on the integrity rung below owners, and re-walks once per flip to on", async () => {
  const sessionKey = buildAgentSessionSyncSourceKey(COMPUTE_TARGET, false);
  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    isSyncSpanExtentSupported: () => true,
    isSyncHumanTurnTimestampsSupported: () => true,
    isSyncAgentTurnTimestampsSupported: () => true,
    isSyncTokenEventOwnerSupported: () => true,
    sendBatch: () => Promise.resolve({ accepted: true }),
  };
  const offContract = await withParsePolicy(PARSE_POLICY_BASE, () =>
    resolveSyncContractCapabilities(options)
  );
  const onContract = resolveSyncContractCapabilities(options);

  // Off: a cursor stamped at main's top rung is current, so no re-walk.
  assert.equal(
    resolveAgentSessionSyncIntegrityVersion(offContract),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER
  );
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER,
      offContract
    ),
    false
  );
  // The flip to on raises the rung once; the re-walk stamps it and is spent.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER,
      onContract
    ),
    true
  );
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      syncStateContractStamps(onContract).syncIntegrityVersion,
      onContract
    ),
    false
  );
});

test("discards a chunk tail carrying owners once the server no longer accepts them", () => {
  const tail = ownedTail();

  assert.deepEqual(
    resolvePendingChunkTransition(
      tail,
      true,
      true,
      true,
      undefined,
      undefined,
      true,
      /* tokenEventOwnerSupported */ false
    ),
    { kind: "discard-downgrade", sessionId: tail.sessionId, chunkCount: 1 }
  );
});

test("keeps sending a chunk tail carrying owners while the server accepts them", () => {
  const transition = resolvePendingChunkTransition(
    ownedTail(),
    true,
    true,
    true,
    undefined,
    undefined,
    true,
    /* tokenEventOwnerSupported */ true
  );

  assert.equal(transition.kind, "send");
});

test("pins whether a sequestered chunk tail carries owners", () => {
  for (const tokenEventOwnerIncluded of [true, false]) {
    const session = sessionWithOwnedTokenEvents();
    const acc: PreparedPayloadAccumulator = {
      sessions: [],
      syncIds: [],
      accumulatedBytes: 0,
      pendingChunks: null,
    };
    accumulatePreparedPayloads(
      acc,
      [
        {
          kind: "chunked",
          sessionId: session.externalSessionId,
          firstChunk: session,
          remainingChunks: [session],
          payloadBytes: 0,
          firstChunkBytes: 0,
          chunkCount: 2,
        },
      ],
      {
        syncMode: AgentSessionSyncMode.Incremental,
        sendCompress: false,
        activityChunked: false,
        tokenEventOwnerIncluded,
        sizer: identitySyncPayloadSizer,
        byteCap: Number.MAX_SAFE_INTEGER,
        buildBatch: (sessions) =>
          buildAgentSessionSyncBatch({
            batchId: "batch",
            syncMode: AgentSessionSyncMode.Incremental,
            sessions,
            compress: false,
            dataSyncLevel: undefined,
          }),
        deadLetter: () => undefined,
        logChunking: () => undefined,
      }
    );

    assert.equal(
      acc.pendingChunks?.tokenEventOwnerIncluded,
      tokenEventOwnerIncluded
    );
  }
});

function ownedTail(): PendingChunks {
  return {
    sessionId: "owned",
    syncMode: AgentSessionSyncMode.Incremental,
    chunks: [sessionWithOwnedTokenEvents()],
    compress: false,
    activityChunked: false,
    tokenEventOwnerIncluded: true,
  };
}

test("drops a chunk tail with owners when the server stops accepting them mid-drain", async () => {
  let ownersAccepted = true;
  const sends: SyncedAgentSession[][] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => new FakeSyncSource([oversizedOwnedSession()]),
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    isSyncTokenEventOwnerSupported: () => ownersAccepted,
    sendBatch: (batch) => {
      sends.push(batch.sessions);
      // The first chunk lands; the server then reconnects without owners.
      ownersAccepted = false;
      return Promise.resolve({ accepted: true });
    },
  });
  service.start();
  try {
    // The discard re-prepares on the next tick; nudge one rather than wait
    // out the poll, and fail loudly if the re-send never comes.
    for (let nudge = 0; sends.length < 2; nudge += 1) {
      if (nudge >= MAX_SETTLE_TURNS) {
        throw new Error(
          `no re-send after the downgrade (sends=${sends.length})`
        );
      }
      service.refresh();
      await pumpSyncDrainTurn();
    }
  } finally {
    service.stop();
  }

  const [first, ...later] = sends;
  assert.ok(
    first?.[0]?.tokenEvents?.some((event) => "agentExternalId" in event)
  );
  assert.ok(later.length > 0);
  for (const sessions of later) {
    for (const event of sessions.flatMap(
      (session) => session.tokenEvents ?? []
    )) {
      assert.equal("agentExternalId" in event, false);
    }
  }
});

/** Enough token events that the session must be chunked across requests. */
function oversizedOwnedSession(): SyncedAgentSession {
  return {
    ...makeSyncedSession("owned", "2026-10-19T12:00:00.000Z"),
    tokenEvents: Array.from({ length: OVERSIZED_TOKEN_EVENTS }, (_, index) =>
      tokenEvent(
        `event-${index}`,
        index % 2 === 0 ? PARENT_AGENT_EXTERNAL_ID : SUBAGENT_ID
      )
    ),
  };
}
