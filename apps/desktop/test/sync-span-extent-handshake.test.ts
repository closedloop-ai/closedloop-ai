/**
 * @file sync-span-extent-handshake.test.ts
 * @description ISS-5850 / PR #5921 review (whitlockk): the desktop must not record
 * the extent-bearing payload revision as DELIVERED against an API that strips
 * `SessionSpan.startMs`/`endMs`.
 *
 * THE FAILURE THIS FILE EXISTS FOR. Desktop and API deploy independently, so a
 * desktop carrying an extent-capable revision will meet an API whose
 * `sessionSpanSchema` predates the pair. That schema is a non-strict `z.object`,
 * so it strips the fields and answers a NORMAL ack — nothing is red anywhere.
 * Stamping the extent-capable revision on the durable cursor at that point burns
 * the one replay the bump exists to buy: the keyset walk is driven by
 * `sessions.updated_at`, so an unchanged session behind the watermark is never
 * re-pushed, and the cursor now says the work is done. Those sessions stay
 * bounds-less forever, and the disclosure they were the reason for never renders
 * on them.
 *
 * BOTH SHAPES, because a version-skew fix asserted only on the happy path is not
 * a version-skew fix: every capability case below is paired with the older or
 * unknown one that must degrade gracefully rather than lie.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  capabilitiesFromHelloAck,
  NO_AGENT_SESSION_SYNC_CAPABILITIES,
  resolveSyncCapabilityDowngrade,
  SyncCapabilityDowngrade,
} from "../src/main/agent-sync/agent-session-sync-capabilities.js";
import {
  buildAgentComponentSyncSourceKey,
  buildAgentSessionSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { parseServerCapabilities } from "../src/main/cloud/cloud-socket-hello-ack.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  AGENT_SESSION_SYNC_INTEGRITY_VERSION,
  AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS,
  AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_SPAN_EXTENT,
  resolveAgentSessionSyncIntegrityVersion,
  sessionSyncIntegrityCursorIsStale,
} from "../src/main/database/sync-cursor-state.js";

const CURSOR_STATE = {
  observedTopUpdatedAt: "2026-08-24T12:00:00.000Z",
  observedIdsAtTopUpdatedAt: ["session-a"],
  deadLetteredIds: [],
};

const CLEARED_CURSOR = {
  observedTopUpdatedAt: null,
  observedIdsAtTopUpdatedAt: [],
  deadLetteredIds: [],
};

/**
 * A server that persists the extent, and one that silently strips it.
 *
 * ISS-7896 and ISS-9864 added two more contract capabilities to this bag; the
 * extent-storing server carries both so these cases keep asking about the
 * EXTENT rung alone.
 */
const EXTENT_STORING_SERVER = {
  spanExtent: true,
  humanTurnTimestamps: true,
  agentTurnTimestamps: true,
  tokenEventOwner: true,
};
const PRE_EXTENT_SERVER = {
  spanExtent: false,
  humanTurnTimestamps: false,
  agentTurnTimestamps: false,
  tokenEventOwner: false,
};

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "span-extent-handshake-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-08-24T12:00:00.000Z",
  });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("the hello ack decides the revision this lane may claim to have delivered", () => {
  assert.equal(
    resolveAgentSessionSyncIntegrityVersion(EXTENT_STORING_SERVER),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION
  );
  assert.equal(
    resolveAgentSessionSyncIntegrityVersion(PRE_EXTENT_SERVER),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_SPAN_EXTENT
  );
  assert.notEqual(
    AGENT_SESSION_SYNC_INTEGRITY_VERSION,
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_SPAN_EXTENT,
    "the two rungs must differ, or the whole handshake is decorative"
  );
});

test("an OLD server's ack leaves the extent replay owed; a capable one settles it", () => {
  const sessionKey = buildAgentSessionSyncSourceKey("target-iss5850");

  // What a desktop on this build stamps after fully syncing against a pre-extent
  // API. That cursor is caught up FOR THAT SERVER...
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_SPAN_EXTENT,
      PRE_EXTENT_SERVER
    ),
    false,
    "an honest pre-extent stamp must not re-walk the corpus on every boot"
  );
  // ...and the moment the API rolls forward, the replay it never got fires.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_SPAN_EXTENT,
      EXTENT_STORING_SERVER
    ),
    true,
    "the deferred replay must fire on the first connection to a capable server"
  );
  // And stops, once the capable server has actually been stamped for.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION,
      EXTENT_STORING_SERVER
    ),
    false,
    "the repair is one-shot, not a re-walk on every tick"
  );
});

test("meeting an older server again does not re-walk a cursor already stamped at the current revision", () => {
  /*
   * A mixed API fleet mid-rollout, or a rollback: the live capability can go
   * DOWN. An equality test would read the higher stamp as stale and re-walk the
   * entire local corpus on every flip — the saturation `sqliteLoadSyncState`'s
   * comment exists to avoid. A stamp records delivery that already happened, and
   * an older peer showing up does not undo it.
   */
  const sessionKey = buildAgentSessionSyncSourceKey("target-iss5850-rollback");

  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION,
      PRE_EXTENT_SERVER
    ),
    false
  );
  // A cursor that predates the column is still stale under either server.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(sessionKey, null, PRE_EXTENT_SERVER),
    true
  );
  // Still scoped to the session lane; the component lane carries no span.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      buildAgentComponentSyncSourceKey("target-iss5850-rollback"),
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_SPAN_EXTENT,
      EXTENT_STORING_SERVER
    ),
    false
  );
});

test("a cursor advanced against a pre-extent server is cleared by a capable one", async () => {
  // The durable half, through the real SQLite source rather than the predicate:
  // this is the sequence a shipped desktop actually walks, and the assertion is
  // the WATERMARK, which is what decides whether the corpus is replayed.
  await withDatabase(async (db) => {
    const sourceKey = buildAgentSessionSyncSourceKey("target-durable-skew");

    await db.syncSource.advanceSyncState?.(
      sourceKey,
      CURSOR_STATE,
      PRE_EXTENT_SERVER
    );
    assert.deepEqual(
      await db.syncSource.loadSyncState?.(sourceKey, PRE_EXTENT_SERVER),
      CURSOR_STATE,
      "the same server must resume, not re-walk"
    );

    assert.deepEqual(
      await db.syncSource.loadSyncState?.(sourceKey, EXTENT_STORING_SERVER),
      CLEARED_CURSOR,
      "a capable server must clear the watermark so the extent replay happens"
    );

    await db.syncSource.advanceSyncState?.(
      sourceKey,
      CURSOR_STATE,
      EXTENT_STORING_SERVER
    );
    assert.deepEqual(
      await db.syncSource.loadSyncState?.(sourceKey, EXTENT_STORING_SERVER),
      CURSOR_STATE,
      "and the repair must be self-limiting once it has actually been delivered"
    );
  });
});

test("a batch whose server stopped storing the extent mid-tick is deferred, not acked", () => {
  /*
   * The residual window the stamp alone cannot close: a batch captured while the
   * capability held, sent after a reconnect to a server that strips the pair.
   * Its ack would dequeue those rows under a watermark this lane may already
   * have stamped at an extent-capable revision. Rows are never dequeued on a
   * skip, so deferring re-prepares them under whatever actually holds.
   */
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

  // ISS-7896 added a second contract dimension to this bag. Every `current`
  // below holds it AT the captured value so each case isolates the EXTENT.
  const stillStoringHumanTurns = {
    ...NO_AGENT_SESSION_SYNC_CAPABILITIES,
    humanTurnTimestamps: true,
    agentTurnTimestamps: true,
  };
  assert.equal(
    resolveSyncCapabilityDowngrade({
      isPendingChunkDrain: false,
      captured,
      current: { ...stillStoringHumanTurns, spanExtent: false },
    }),
    SyncCapabilityDowngrade.SpanExtent
  );
  // Unchanged capability sends normally — the guard must not defer every batch.
  assert.equal(
    resolveSyncCapabilityDowngrade({
      isPendingChunkDrain: false,
      captured,
      current: { ...stillStoringHumanTurns, spanExtent: true },
    }),
    null
  );
  // GAINING it mid-tick costs nothing: the payload already carries the extent,
  // and the stamp is resolved at persist time.
  assert.equal(
    resolveSyncCapabilityDowngrade({
      isPendingChunkDrain: false,
      captured: { ...captured, spanExtent: false },
      current: { ...stillStoringHumanTurns, spanExtent: true },
    }),
    null
  );
});

test("only an explicit true from the server counts as storing the extent", () => {
  // Old shape: an API that never heard of the field. Absence must read as
  // "cannot store it", never as an unstated yes.
  assert.equal(
    capabilitiesFromHelloAck({ agentSessionSync: true }).spanExtent,
    false
  );
  assert.equal(capabilitiesFromHelloAck(undefined).spanExtent, false);
  assert.equal(
    capabilitiesFromHelloAck({ agentSessionSyncSpanExtent: true }).spanExtent,
    true
  );

  // And the parse that feeds it refuses a non-boolean, so a malformed ack
  // degrades to the pre-extent contract rather than throwing or opting in.
  assert.deepEqual(
    parseServerCapabilities({ agentSessionSyncSpanExtent: true }),
    {
      agentSessionSyncSpanExtent: true,
    }
  );
  assert.equal(
    parseServerCapabilities({ agentSessionSyncSpanExtent: "true" }),
    undefined
  );
});

/**
 * ISS-7896 (whitlockk, #6116): the SAME handshake, one rung up, for a server that
 * stores the span extent but caps `metadata.humanTurnTimestamps` at the generic
 * 100-item array bound.
 *
 * This rung's skew failure is worse than the extent's, which is why it needs a
 * rung of its own rather than riding revision 5. A pre-ISS-7896 API does not
 * DROP the key — it stores a truncated copy and acks normally — and the cloud
 * heatmap reads a present array as AUTHORITATIVE over the `$.messages`
 * fallback. So a desktop that stamped the human-turn revision against such an
 * API leaves every high-turn session reporting its first 100 human turns as if
 * measured, permanently.
 */
const HUMAN_TURN_STORING_SERVER = {
  spanExtent: true,
  humanTurnTimestamps: true,
  agentTurnTimestamps: true,
  tokenEventOwner: true,
};
const PRE_HUMAN_TURN_SERVER = {
  spanExtent: true,
  humanTurnTimestamps: false,
  agentTurnTimestamps: false,
  tokenEventOwner: true,
};

test("a pre-ISS-7896 server's ack leaves the human-turn replay owed", () => {
  const sessionKey = buildAgentSessionSyncSourceKey("target-iss7896");

  assert.equal(
    resolveAgentSessionSyncIntegrityVersion(PRE_HUMAN_TURN_SERVER),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS,
    "an API that caps the array must not be stamped as having stored it whole"
  );
  assert.equal(
    resolveAgentSessionSyncIntegrityVersion(HUMAN_TURN_STORING_SERVER),
    AGENT_SESSION_SYNC_INTEGRITY_VERSION
  );
  assert.notEqual(
    AGENT_SESSION_SYNC_INTEGRITY_VERSION,
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS,
    "the two rungs must differ, or the whole handshake is decorative"
  );

  // Caught up FOR THAT SERVER — an honest stamp must not re-walk every boot.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS,
      PRE_HUMAN_TURN_SERVER
    ),
    false
  );
  // ...and the deferred replay fires the moment a capable API answers.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS,
      HUMAN_TURN_STORING_SERVER
    ),
    true,
    "a Desktop-before-API release must self-correct on the first capable connection"
  );
  // One-shot, not a re-walk on every tick.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION,
      HUMAN_TURN_STORING_SERVER
    ),
    false
  );
});

test("every session already behind the watermark is replayed for the new key", () => {
  // The defect the bump exists for: the key is derived at payload-BUILD time and
  // re-deriving does not touch `sessions.updated_at`, so a cursor stamped by any
  // build before this one must read STALE or the correction reaches only
  // sessions that happen to change later — missing exactly the long, high-turn
  // sessions where the 100-cap bites hardest.
  const sessionKey = buildAgentSessionSyncSourceKey("target-iss7896-history");
  for (const stamped of [
    3,
    4,
    AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS,
  ]) {
    assert.equal(
      sessionSyncIntegrityCursorIsStale(
        sessionKey,
        stamped,
        HUMAN_TURN_STORING_SERVER
      ),
      true,
      `a cursor stamped at revision ${stamped} still owes the ISS-7896 replay`
    );
  }
});

test("only an explicit true counts as storing the human-turn timestamps", () => {
  // Absence must read as "caps the array", never as an unstated yes — the whole
  // point of gating the stamp.
  assert.equal(
    capabilitiesFromHelloAck({ agentSessionSync: true }).humanTurnTimestamps,
    false
  );
  assert.equal(capabilitiesFromHelloAck(undefined).humanTurnTimestamps, false);
  assert.equal(
    capabilitiesFromHelloAck({ agentSessionSyncHumanTurnTimestamps: true })
      .humanTurnTimestamps,
    true
  );
  // And the wire parse must not promote a truthy non-true value.
  assert.equal(
    parseServerCapabilities({ agentSessionSyncHumanTurnTimestamps: "yes" })
      ?.agentSessionSyncHumanTurnTimestamps,
    undefined
  );
  assert.equal(
    parseServerCapabilities({ agentSessionSyncHumanTurnTimestamps: true })
      ?.agentSessionSyncHumanTurnTimestamps,
    true
  );
});

test("losing the human-turn capability mid-tick defers the batch", () => {
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
        humanTurnTimestamps: false,
      },
    }),
    SyncCapabilityDowngrade.HumanTurnTimestamps
  );
  // GAINING it mid-tick costs nothing — the key is already on the payload.
  assert.equal(
    resolveSyncCapabilityDowngrade({
      isPendingChunkDrain: false,
      captured: { ...captured, humanTurnTimestamps: false },
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
