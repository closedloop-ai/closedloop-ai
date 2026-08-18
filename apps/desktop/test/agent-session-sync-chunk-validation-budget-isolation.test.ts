/**
 * @file agent-session-sync-chunk-validation-budget-isolation.test.ts
 * @description ISS-5090 follow-up coverage for the chunk-validation re-drive
 * allowance (`MAX_CHUNK_ENVELOPE_DEAD_LETTERS`) — the two properties the
 * classification suite does not pin:
 *
 *   - MIXED FAILURE: the allowance is spent by the chunk-validation class ALONE.
 *     It originally read the shared progressive-escalation counter, which every
 *     dead-letter class bumps, so three unrelated ack-timeout recovery cycles
 *     made the FIRST chunk-envelope rejection terminal — a valid oversized
 *     session parked because an unrelated outage happened to precede it.
 *   - RESTART: the allowance is PROCESS-SCOPED, and that boundary is documented
 *     rather than silently assumed. A cold restart re-derives the count from zero
 *     (there is no durable read of dead-lettered outbox rows today), so the
 *     second process re-grants the allowance — but its re-drive must stay BOUNDED
 *     and go terminal again, never degrade into unbounded retry across restarts
 *     (sync/AGENTS.md invariant 5).
 *
 * Both drive the REAL `AgentSessionSyncService` over the REAL payload preparer,
 * and both restart the lane against the SAME `FakeSyncSource` so the durable
 * cursor + outbox survive exactly as they do on disk.
 *
 * DETERMINISM (FEA-2399 / desktop AGENTS.md): the clock is pinned and stepped
 * explicitly, every drive loop is bounded, and exhausting a bound THROWS rather
 * than falling through onto a stale-state assertion.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEAD_LETTER_RETRY_MAX_MS,
  MAX_CHUNK_ENVELOPE_DEAD_LETTERS,
  VALIDATION_FAILED_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  CHUNK_VALIDATION_EXHAUSTED_REASON,
  CHUNK_VALIDATION_FAILED_REASON,
} from "../src/main/agent-sync/agent-session-sync-validation-failure.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { pumpSyncDrainTurn } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "chunk-validation-budget-target";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
const OVERSIZED_ID = "session-oversized";
const OUTBOX_KEY = `${SOURCE_KEY}\0${OVERSIZED_ID}`;
/**
 * Enough events that the real preparer splits the session across parts, so the
 * chunk markers this suite classifies on are genuine preparer output (mirrors
 * the sibling classification suite).
 */
const OVERSIZED_EVENT_COUNT = 6000;
/** Bounded step budget for every drive loop; exhausting it is a real failure. */
const MAX_DRIVE_STEPS = 160;
/** One step past the LONGEST window the lane can impose. */
const FULL_WINDOW_STEP_MS =
  DEAD_LETTER_RETRY_MAX_MS + VALIDATION_FAILED_BACKOFF_MS + 1;

function buildOversizedSession(): SyncedAgentSession {
  return makeSyncedSession(
    OVERSIZED_ID,
    "2026-06-08T13:00:00.000Z",
    Array.from({ length: OVERSIZED_EVENT_COUNT }, (_, i) => ({
      externalEventId: `evt-${i}`,
      eventType: "ToolUse",
      toolName: "Read",
      createdAt: "2026-06-08T12:30:00.000Z",
    }))
  );
}

/**
 * Pin `Date.now` to a virtual clock for `body`, restoring the real clock even if
 * `body` throws. Only the clock is mocked — ticks are driven explicitly.
 */
async function withPinnedClock(
  body: (clock: { advance: (ms: number) => void }) => Promise<void>
): Promise<void> {
  const realNow = Date.now;
  let virtualNow = realNow();
  Date.now = () => virtualNow;
  try {
    await body({
      advance: (ms) => {
        virtualNow += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

test("ISS-5090: unrelated dead-letter classes do not spend the chunk-validation re-drive allowance", async () => {
  // The reviewer's mixed-failure case. Burn EXACTLY `MAX_CHUNK_ENVELOPE_DEAD_LETTERS`
  // ack-timeout dead-letter/recovery cycles first — a wholly unrelated class that
  // also bumps the shared progressive-escalation counter — then flip the server to
  // reject the multi-part envelope. The FIRST chunk rejection must still be
  // classified RECOVERABLE. Reading the shared counter made it terminal on
  // rejection one, which is exactly the strand this pins.
  const source = new FakeSyncSource([buildOversizedSession()]);
  let rejectAsTimeout = true;
  let timeoutDeadLetterCycles = 0;
  let chunkReason: string | undefined;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: () =>
      Promise.resolve({
        accepted: false as const,
        reason: rejectAsTimeout
          ? DesktopAgentSessionsAckReason.AckTimeout
          : DesktopAgentSessionsAckReason.ValidationFailed,
      }),
  });

  await withPinnedClock(async ({ advance }) => {
    service.start();
    let wasDeadLettered = false;
    for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
      await pumpSyncDrainTurn();
      const isDeadLettered = service.getSyncProgress().deadLetteredSessions > 0;
      if (rejectAsTimeout && isDeadLettered && !wasDeadLettered) {
        timeoutDeadLetterCycles += 1;
        // Hand the chunk class a counter that a shared budget would already
        // consider spent.
        if (timeoutDeadLetterCycles >= MAX_CHUNK_ENVELOPE_DEAD_LETTERS) {
          rejectAsTimeout = false;
        }
      }
      wasDeadLettered = isDeadLettered;
      const reason = source.outbox.get(OUTBOX_KEY)?.reason;
      if (
        !rejectAsTimeout &&
        (reason === CHUNK_VALIDATION_FAILED_REASON ||
          reason === CHUNK_VALIDATION_EXHAUSTED_REASON)
      ) {
        chunkReason = reason;
        return;
      }
      advance(FULL_WINDOW_STEP_MS);
      service.refresh();
    }
  });
  service.stop();

  assert.equal(
    timeoutDeadLetterCycles,
    MAX_CHUNK_ENVELOPE_DEAD_LETTERS,
    "the unrelated ack-timeout class must have burned a full allowance's worth of dead-letter cycles first"
  );
  assert.equal(
    chunkReason,
    CHUNK_VALIDATION_FAILED_REASON,
    "the FIRST chunk-envelope rejection after unrelated dead-letters must still be re-drivable — the allowance belongs to the chunk class alone"
  );
});

test("ISS-5090: the chunk-validation allowance is process-scoped, and a restart's re-drive is still bounded", async () => {
  // Documented lifetime boundary. The count lives only in memory (there is no
  // durable read of dead-lettered outbox rows — their `last_error` records the
  // class, but no `AgentSessionSyncSource` method exposes it), so a cold restart
  // DOES re-grant the allowance. What must never regress is the bound: the second
  // process spends one capped allowance and goes terminal again rather than
  // re-driving a permanently-invalid row forever.
  const source = new FakeSyncSource([buildOversizedSession()]);
  const alwaysReject = () =>
    Promise.resolve({
      accepted: false as const,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });

  async function runProcess(): Promise<{ sends: number; reason?: string }> {
    let sends = 0;
    const service = new AgentSessionSyncService({
      isHttpReady: () => true,
      getSource: () => source,
      getSyncComputeTargetId: () => COMPUTE_TARGET,
      sendBatch: () => {
        sends += 1;
        return alwaysReject();
      },
    });
    let terminalReason: string | undefined;
    await withPinnedClock(async ({ advance }) => {
      service.start();
      for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
        await pumpSyncDrainTurn();
        if (
          source.outbox.get(OUTBOX_KEY)?.reason ===
          CHUNK_VALIDATION_EXHAUSTED_REASON
        ) {
          terminalReason = CHUNK_VALIDATION_EXHAUSTED_REASON;
          return;
        }
        advance(FULL_WINDOW_STEP_MS);
        service.refresh();
      }
    });
    service.stop();
    if (terminalReason === undefined) {
      throw new Error(
        `the chunk-envelope class never went terminal after ${sends} rejected sends — the re-drive is unbounded`
      );
    }
    return { sends, reason: terminalReason };
  }

  const first = await runProcess();
  assert.equal(first.reason, CHUNK_VALIDATION_EXHAUSTED_REASON);

  // Restart: same durable cursor + outbox, brand-new in-memory lane state.
  const second = await runProcess();
  assert.equal(
    second.reason,
    CHUNK_VALIDATION_EXHAUSTED_REASON,
    "after a restart the re-granted allowance must still be spent down to a terminal dead-letter"
  );
  assert.ok(
    second.sends <= first.sends,
    `the restarted process must not exceed the first process's bounded budget (first ${first.sends}, second ${second.sends})`
  );
});
