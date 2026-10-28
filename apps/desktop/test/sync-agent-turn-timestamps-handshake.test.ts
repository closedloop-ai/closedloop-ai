/**
 * @file sync-agent-turn-timestamps-handshake.test.ts
 * @description ISS-9864 — the SAME handshake sync-span-extent-handshake.test.ts
 * pins for the extent (ISS-5850) and the human-turn key (ISS-7896), one rung up,
 * for a server that stores both of those but caps `metadata.agentTurnTimestamps`
 * at the generic 100-item array bound. Split out because that file is already
 * past the 500-line smell.
 *
 * The skew failure is the human key's, on the agent half: a pre-ISS-9864 API
 * does not DROP the key — it stores a truncated copy and acks normally — and
 * the cloud heatmap reads a present array as AUTHORITATIVE over the `$.messages`
 * fallback on a session that synced no token events. A desktop that stamped
 * the agent-turn revision against such an API would leave every long
 * token-event-less session reporting its first 100 agent turns as if measured,
 * permanently, because the keyset cursor walks `sessions.updated_at` and nothing
 * re-pushes an unchanged row.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  capabilitiesFromHelloAck,
  NO_AGENT_SESSION_SYNC_CAPABILITIES,
  resolveSyncCapabilityDowngrade,
  SyncCapabilityDowngrade,
} from "../src/main/agent-sync/agent-session-sync-capabilities.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { parseServerCapabilities } from "../src/main/cloud/cloud-socket-hello-ack.js";
import {
  AGENT_SESSION_SYNC_INTEGRITY_VERSION,
  AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_AGENT_TURN_TIMESTAMPS,
  AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS,
  AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_SPAN_EXTENT,
  resolveAgentSessionSyncIntegrityVersion,
  sessionSyncIntegrityCursorIsStale,
} from "../src/main/database/sync-cursor-state.js";

const AGENT_TURN_STORING_SERVER = {
  spanExtent: true,
  humanTurnTimestamps: true,
  agentTurnTimestamps: true,
  tokenEventOwner: true,
};
const PRE_AGENT_TURN_SERVER = {
  spanExtent: true,
  humanTurnTimestamps: true,
  agentTurnTimestamps: false,
  tokenEventOwner: true,
};

test("a pre-ISS-9864 server's ack leaves the agent-turn replay owed", () => {
  const sessionKey = buildAgentSessionSyncSourceKey("target-iss9864");

  assert.equal(
    resolveAgentSessionSyncIntegrityVersion(PRE_AGENT_TURN_SERVER),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_AGENT_TURN_TIMESTAMPS,
    "an API that caps the array must not be stamped as having stored it whole"
  );
  assert.equal(
    resolveAgentSessionSyncIntegrityVersion(AGENT_TURN_STORING_SERVER),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION
  );
  assert.notEqual(
    AGENT_SESSION_SYNC_INTEGRITY_VERSION,
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_AGENT_TURN_TIMESTAMPS,
    "the two rungs must differ, or the whole handshake is decorative"
  );
  // The rung sits strictly above the human one, so a server that stores the
  // human key and not this one resolves to the human-key revision, not below.
  assert.equal(
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_AGENT_TURN_TIMESTAMPS,
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS + 1
  );

  // Caught up FOR THAT SERVER — an honest stamp must not re-walk every boot.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_AGENT_TURN_TIMESTAMPS,
      PRE_AGENT_TURN_SERVER
    ),
    false
  );
  // ...and the deferred replay fires the moment a capable API answers.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_AGENT_TURN_TIMESTAMPS,
      AGENT_TURN_STORING_SERVER
    ),
    true,
    "a Desktop-before-API release must self-correct on the first capable connection"
  );
  // One-shot, not a re-walk on every tick.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION,
      AGENT_TURN_STORING_SERVER
    ),
    false
  );
});

test("the lower rungs still resolve as before beneath the new one", () => {
  // Adding a rung must not reorder the existing ones: no extent → 3 regardless
  // of the higher flags; extent but no human key → 5 regardless of the agent
  // flag. A server that advertises the agent flag WITHOUT the human one is a
  // contract this build does not recognise, and it stays on the human rung.
  assert.equal(
    resolveAgentSessionSyncIntegrityVersion({
      spanExtent: false,
      humanTurnTimestamps: true,
      agentTurnTimestamps: true,
      tokenEventOwner: true,
    }),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_SPAN_EXTENT
  );
  assert.equal(
    resolveAgentSessionSyncIntegrityVersion({
      spanExtent: true,
      humanTurnTimestamps: false,
      agentTurnTimestamps: true,
      tokenEventOwner: true,
    }),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS
  );
});

test("every session already behind the watermark is replayed for the new key", () => {
  // The key is derived at payload-BUILD time and re-deriving does not touch
  // `sessions.updated_at`, so a cursor stamped by any build before this one must
  // read STALE or the correction reaches only sessions that happen to change
  // later — missing exactly the long, token-event-less sessions the 100-cap
  // bit hardest.
  const sessionKey = buildAgentSessionSyncSourceKey("target-iss9864-history");
  for (const stamped of [
    3,
    4,
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS,
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_AGENT_TURN_TIMESTAMPS,
  ]) {
    assert.equal(
      sessionSyncIntegrityCursorIsStale(
        sessionKey,
        stamped,
        AGENT_TURN_STORING_SERVER
      ),
      true,
      `a cursor stamped at revision ${stamped} still owes the ISS-9864 replay`
    );
  }
});

test("only an explicit true counts as storing the agent-turn timestamps", () => {
  // Absence must read as "caps the array", never as an unstated yes.
  assert.equal(
    capabilitiesFromHelloAck({ agentSessionSync: true }).agentTurnTimestamps,
    false
  );
  assert.equal(capabilitiesFromHelloAck(undefined).agentTurnTimestamps, false);
  assert.equal(
    capabilitiesFromHelloAck({ agentSessionSyncHumanTurnTimestamps: true })
      .agentTurnTimestamps,
    false,
    "the human flag does not imply the agent one"
  );
  assert.equal(
    capabilitiesFromHelloAck({ agentSessionSyncAgentTurnTimestamps: true })
      .agentTurnTimestamps,
    true
  );
  // And the wire parse must not promote a truthy non-true value.
  assert.equal(
    parseServerCapabilities({ agentSessionSyncAgentTurnTimestamps: "yes" })
      ?.agentSessionSyncAgentTurnTimestamps,
    undefined
  );
  assert.equal(
    parseServerCapabilities({ agentSessionSyncAgentTurnTimestamps: true })
      ?.agentSessionSyncAgentTurnTimestamps,
    true
  );
});

test("losing the agent-turn capability mid-tick defers the batch", () => {
  const captured = {
    compression: false,
    activityChunking: false,
    prRefChunking: false,
    monitoredActivity: false,
    spanExtent: true,
    humanTurnTimestamps: true,
    agentTurnTimestamps: true,
    tokenEventOwner: false,
  };
  assert.equal(
    resolveSyncCapabilityDowngrade({
      isPendingChunkDrain: false,
      captured,
      current: {
        ...NO_AGENT_SESSION_SYNC_CAPABILITIES,
        spanExtent: true,
        humanTurnTimestamps: true,
        agentTurnTimestamps: false,
      },
    }),
    SyncCapabilityDowngrade.AgentTurnTimestamps
  );
  // GAINING it mid-tick costs nothing — the key is already on the payload.
  assert.equal(
    resolveSyncCapabilityDowngrade({
      isPendingChunkDrain: false,
      captured: { ...captured, agentTurnTimestamps: false },
      current: {
        ...NO_AGENT_SESSION_SYNC_CAPABILITIES,
        spanExtent: true,
        humanTurnTimestamps: true,
        agentTurnTimestamps: true,
      },
    }),
    null
  );
});
