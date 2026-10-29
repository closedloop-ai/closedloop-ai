/**
 * @file agent-session-sync-lane-wide-transport-throw.test.ts
 * @description ISS-10602: the mixed-failure fixture for the thrown-send fold,
 * driven through the whole session lane. One pass carries BOTH shapes the fold
 * must tell apart: a row whose own payload prep fails (charged to that row) and
 * a send that fails at the network (the lane's, charging nobody). A lane that
 * let the transport throw decide for the whole pass would either forgive the
 * failing row or charge the healthy one, and only a fixture holding both in the
 * same pass can see either mistake.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { MAX_CONSECUTIVE_TRANSPORT_ERRORS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type { AgentSessionPayloadPreparer } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { AgentSessionSyncTransportError } from "../src/main/agent-sync/agent-session-sync-service-helpers.js";
import {
  PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const HEALTHY_SESSION_ID = "iss10602-healthy";
const STUCK_SESSION_ID = "iss10602-stuck-prep";

test("ISS-10602: in one pass, a row's own prep failure is charged while the send's network throw defers the lane", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession(HEALTHY_SESSION_ID, "2026-09-27T12:01:00.000Z"),
    makeSyncedSession(STUCK_SESSION_ID, "2026-09-27T12:02:00.000Z"),
  ]);
  const preparePayloads: AgentSessionPayloadPreparer = (sessions) => {
    if (
      sessions.some((session) => session.externalSessionId === STUCK_SESSION_ID)
    ) {
      return Promise.reject(
        new Error("agent-session payload worker timed out after 30000ms")
      );
    }
    return Promise.resolve(
      sessions.map((session) => ({
        kind: "session",
        session,
        payloadBytes: Buffer.byteLength(JSON.stringify(session)),
      }))
    );
  };
  let networkUp = false;
  let sendAttempts = 0;
  const acceptedSessionIds: string[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    preparePayloads,
    sendBatch: (batch) => {
      sendAttempts += 1;
      if (!networkUp) {
        return Promise.reject(
          new AgentSessionSyncTransportError("fetch failed", {
            cause: new TypeError("fetch failed"),
          })
        );
      }
      for (const session of batch.sessions) {
        acceptedSessionIds.push(session.externalSessionId);
      }
      return Promise.resolve({ accepted: true });
    },
  });

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    try {
      await service.whenSessionSyncSettled();
      for (
        let round = 2;
        round <= MAX_CONSECUTIVE_TRANSPORT_ERRORS;
        round += 1
      ) {
        service.refresh();
        await service.whenSessionSyncSettled();
        assert.equal(
          sendAttempts,
          round - 1,
          "with the clock held, the lane gate holds the next send"
        );
        advance(PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS);
        service.refresh();
        await service.whenSessionSyncSettled();
        assert.equal(
          sendAttempts,
          round,
          "one elapsed rung buys exactly one more send"
        );
      }
      assert.equal(
        service.getSyncProgress().deadLetteredSessions,
        1,
        "the stuck row spent its own budget, and the healthy row's network throws spent none"
      );

      networkUp = true;
      advance(PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS);
      service.refresh();
      await service.whenSessionSyncSettled();
      assert.deepEqual(
        acceptedSessionIds,
        [HEALTHY_SESSION_ID],
        "the row the dropped connection held syncs once the network returns"
      );
    } finally {
      service.stop();
    }
  });
});
