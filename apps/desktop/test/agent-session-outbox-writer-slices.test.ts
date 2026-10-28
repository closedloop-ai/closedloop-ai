/**
 * @file agent-session-outbox-writer-slices.test.ts
 * @description Focused coverage for the consumer-shaped slices exported by the
 * session outbox writers.
 */

import assert from "node:assert/strict";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { test } from "vitest";
import {
  createOutboxWriters,
  type OutboxWriteTarget,
} from "../src/main/agent-sync/agent-session-outbox-writers.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";

test("ISS-8617: fold writer slice forwards the permanent attempt count", () => {
  const calls: Array<{
    sourceKey: string;
    id: string;
    attemptCount: number;
    nextAttemptAt: string;
    reason: string;
    laneStalledSince: string | null;
    permanentAttemptCount: number | null | undefined;
  }> = [];
  const source: AgentSessionSyncSource = {
    listAllSessionCursorRows: () => [],
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [],
    recordOutboxRetry: (
      sourceKey,
      id,
      attemptCount,
      nextAttemptAt,
      reason,
      laneStalledSince,
      permanentAttemptCount
    ) => {
      calls.push({
        sourceKey,
        id,
        attemptCount,
        nextAttemptAt,
        reason,
        laneStalledSince,
        permanentAttemptCount,
      });
    },
  };
  const target: OutboxWriteTarget = {
    sourceKey: "agent_sessions:target-slices",
    source,
  };
  const writers = createOutboxWriters(() => target);

  writers.slices.folds.recordOutboxRetry(
    "sess-1",
    2,
    Date.parse("2026-07-18T00:05:00.000Z"),
    SyncReason.AckOmitted,
    null,
    2
  );

  assert.deepEqual(calls, [
    {
      sourceKey: "agent_sessions:target-slices",
      id: "sess-1",
      attemptCount: 2,
      nextAttemptAt: "2026-07-18T00:05:00.000Z",
      reason: SyncReason.AckOmitted,
      laneStalledSince: null,
      permanentAttemptCount: 2,
    },
  ]);
});

test("ISS-8617: stall writer slice preserves the stored permanent attempt count", async () => {
  const calls: Array<{
    sourceKey: string;
    id: string;
    attemptCount: number;
    nextAttemptAt: string;
    reason: string;
    laneStalledSince: string | null;
    permanentAttemptCount: number | null | undefined;
  }> = [];
  const source: AgentSessionSyncSource = {
    listAllSessionCursorRows: () => [],
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [],
    recordOutboxRetry: (
      sourceKey,
      id,
      attemptCount,
      nextAttemptAt,
      reason,
      laneStalledSince,
      permanentAttemptCount
    ) => {
      calls.push({
        sourceKey,
        id,
        attemptCount,
        nextAttemptAt,
        reason,
        laneStalledSince,
        permanentAttemptCount,
      });
    },
  };
  const target: OutboxWriteTarget = {
    sourceKey: "agent_sessions:target-slices",
    source,
  };
  const writers = createOutboxWriters(() => target);

  await writers.slices.folds.recordOutboxStall({
    id: "sess-1",
    attemptCount: 2,
    nextAttemptAtMs: Date.parse("2026-07-18T00:05:00.000Z"),
    reason: SyncReason.IngestionFailed,
    laneStalledSince: "2026-07-18T00:00:00.000Z",
  });

  assert.deepEqual(calls, [
    {
      sourceKey: "agent_sessions:target-slices",
      id: "sess-1",
      attemptCount: 2,
      nextAttemptAt: "2026-07-18T00:05:00.000Z",
      reason: SyncReason.IngestionFailed,
      laneStalledSince: "2026-07-18T00:00:00.000Z",
      permanentAttemptCount: undefined,
    },
  ]);
});
