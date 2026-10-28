import assert from "node:assert/strict";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { DeadEndRateRecordSchema } from "@closedloop-ai/telemetry-contract/ipc";
import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import { beforeEach, test, vi } from "vitest";
import { instrumentIpcPerf } from "../src/main/dashboard/agent-dashboard-ipc-perf.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { DesktopIpcOperation } from "../src/main/telemetry/app-otel-runtime-ipc.js";
import { recordIpcCall } from "../src/main/telemetry/dead-end-rate-record.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import { DesktopReadCancelledError } from "../src/shared/read-cancellation-contract.js";

vi.mock("../src/main/telemetry/dead-end-rate-record.js", () => ({
  recordIpcCall: vi.fn(),
}));

const db = {
  sessions: { count: () => Promise.resolve(1) },
} as unknown as SqliteAgentDatabase;

const USER_REQUEST = { limit: 25, readInitiator: ReadInitiator.User };
const BACKGROUND_REQUEST = {
  limit: 25,
  readInitiator: ReadInitiator.Background,
};

beforeEach(() => {
  vi.mocked(recordIpcCall).mockClear();
});

function listCall(request: unknown, sample = 0.99) {
  return instrumentIpcPerf(
    DesktopIpcOperation.List,
    () => undefined,
    (_db, _request: unknown) => [],
    { random: () => sample }
  )(db, request);
}

test("records a user-initiated read whether the head sampler keeps it or not (ISS-12039)", async () => {
  const emitted: unknown[] = [];
  const call = (sample: number) =>
    instrumentIpcPerf(
      DesktopIpcOperation.List,
      (input) => emitted.push(input),
      (_db, _request: unknown) => [],
      { random: () => sample }
    )(db, USER_REQUEST);

  await call(0.99);
  await call(0.05);

  assert.equal(emitted.length, 1);
  assert.deepEqual(vi.mocked(recordIpcCall).mock.calls, [
    [DesktopIpcOperation.List],
    [DesktopIpcOperation.List],
  ]);
});

test("records no poll, no old-shape request and no unknown initiator", async () => {
  await listCall(BACKGROUND_REQUEST);
  await listCall({ limit: 25 });
  await listCall(undefined);
  await listCall({ limit: 25, readInitiator: "prefetch" });
  await listCall(USER_REQUEST);

  assert.deepEqual(vi.mocked(recordIpcCall).mock.calls, [
    [DesktopIpcOperation.List],
  ]);
});

test("reads the detail initiator off its options argument", async () => {
  const detail = (options?: unknown) =>
    instrumentIpcPerf(
      DesktopIpcOperation.Detail,
      () => undefined,
      (_db, _id: unknown, _options?: unknown) => null,
      { random: () => 0.99 }
    )(db, "session-1", options);

  await detail();
  await detail({ readInitiator: ReadInitiator.Background });
  await detail({ readInitiator: ReadInitiator.User });

  assert.deepEqual(vi.mocked(recordIpcCall).mock.calls, [
    [DesktopIpcOperation.Detail],
  ]);
});

test("records a failed user read, not an attempt the re-drive will run again", async () => {
  const fail = (error: Error) =>
    instrumentIpcPerf(
      DesktopIpcOperation.Usage,
      () => undefined,
      (_db, _request: unknown) => {
        throw error;
      },
      { random: () => 0.99 }
    )(db, USER_REQUEST);

  await assert.rejects(fail(new Error("handler failed")));
  await assert.rejects(
    fail(new DbHostExitError(0, true, "db-host exited (code: 0)"))
  );

  assert.deepEqual(vi.mocked(recordIpcCall).mock.calls, [
    [DesktopIpcOperation.Usage],
  ]);
});

test("records no user read the renderer cancelled, and emits no span for it", async () => {
  const emitted: unknown[] = [];
  const fail = (error: Error) =>
    instrumentIpcPerf(
      DesktopIpcOperation.PageData,
      (input) => emitted.push(input),
      (_db, _request: unknown) => {
        throw error;
      },
      { random: () => 0.99 }
    )(db, USER_REQUEST);

  await assert.rejects(fail(new DesktopReadCancelledError()));
  await assert.rejects(fail(new Error("handler failed")));

  // Only the real failure: one errored span, one rate record.
  assert.equal(emitted.length, 1);
  assert.deepEqual(vi.mocked(recordIpcCall).mock.calls, [
    [DesktopIpcOperation.PageData],
  ]);
});

test("every desktop IPC operation is a value the contract accepts", () => {
  for (const operation of Object.values(DesktopIpcOperation)) {
    assert.equal(
      DeadEndRateRecordSchema.safeParse({
        [TelemetryAttribute.IpcOperation]: operation,
      }).success,
      true,
      operation
    );
  }
});
