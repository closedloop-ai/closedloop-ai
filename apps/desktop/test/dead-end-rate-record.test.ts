import assert from "node:assert/strict";
import {
  DeadEndPhase,
  DeadEndReason,
  DeadEndState,
  DeadEndTreatment,
} from "@closedloop-ai/telemetry-contract/app";
import { test, vi } from "vitest";
import {
  emitDeadEndRecord,
  recordDeadEndRate,
} from "../src/main/telemetry/app-otel-runtime-dead-end.js";
import { recordRenderedDeadEnd } from "../src/main/telemetry/dead-end-rate-record.js";
import {
  createDeadEndTelemetryRecorder,
  DEAD_END_TELEMETRY_MAX_RECORDS,
} from "../src/main/telemetry/dead-end-telemetry-recorder.js";

vi.mock("../src/main/telemetry/dead-end-rate-record.js", () => ({
  recordRenderedDeadEnd: vi.fn(),
}));

test("only a rendered dead end becomes a dead_end.rate record (ISS-12039)", () => {
  const recordsByPhase: Record<string, number> = {};
  for (const phase of Object.values(DeadEndPhase)) {
    vi.mocked(recordRenderedDeadEnd).mockClear();
    recordDeadEndRate({
      treatment: DeadEndTreatment.SessionDetailNotFound,
      phase,
      state: DeadEndState.TrueZero,
      reason: DeadEndReason.Absent,
      retryOffered: true,
      retryAttempt: 1,
    });
    recordsByPhase[phase] = vi.mocked(recordRenderedDeadEnd).mock.calls.length;
  }

  assert.deepEqual(recordsByPhase, {
    [DeadEndPhase.Rendered]: 1,
    [DeadEndPhase.RetryAttempted]: 0,
    [DeadEndPhase.RetrySettled]: 0,
  });
});

test("only a Sessions dead end counts toward the Sessions-read rate (ISS-12039)", () => {
  const recordsByTreatment: Record<string, number> = {};
  for (const treatment of [
    DeadEndTreatment.SessionsListEmpty,
    DeadEndTreatment.SessionDetailNotFound,
    DeadEndTreatment.BranchesListEmpty,
    DeadEndTreatment.Unknown,
  ]) {
    vi.mocked(recordRenderedDeadEnd).mockClear();
    recordDeadEndRate({
      treatment,
      phase: DeadEndPhase.Rendered,
      state: DeadEndState.TrueZero,
      reason: DeadEndReason.Absent,
      retryOffered: false,
      retryAttempt: 0,
    });
    recordsByTreatment[treatment] = vi.mocked(
      recordRenderedDeadEnd
    ).mock.calls.length;
  }

  assert.deepEqual(recordsByTreatment, {
    [DeadEndTreatment.SessionsListEmpty]: 1,
    [DeadEndTreatment.SessionDetailNotFound]: 1,
    [DeadEndTreatment.BranchesListEmpty]: 0,
    [DeadEndTreatment.Unknown]: 0,
  });
});

test("the 513th dead end in a process still writes its rate record while its detailed record is capped (ISS-12039)", () => {
  vi.mocked(recordRenderedDeadEnd).mockClear();
  let detailed = 0;
  // The real runtime path behind the recorder, so a rate record written there
  // too would show up as a double count.
  const recorder = createDeadEndTelemetryRecorder({
    emit: (input) => {
      emitDeadEndRecord(input, () => undefined, {});
      detailed += 1;
      return true;
    },
  });

  const taken: boolean[] = [];
  for (let index = 0; index <= DEAD_END_TELEMETRY_MAX_RECORDS; index += 1) {
    taken.push(
      recorder.record({
        treatment: DeadEndTreatment.SessionsListEmpty,
        phase: DeadEndPhase.Rendered,
        state: DeadEndState.TrueZero,
        reason: DeadEndReason.Absent,
        retryOffered: false,
        retryAttempt: 0,
      })
    );
  }

  assert.equal(DEAD_END_TELEMETRY_MAX_RECORDS, 512);
  assert.equal(taken.at(-1), false, "the 513th detailed record is capped");
  assert.equal(detailed, 512);
  assert.equal(vi.mocked(recordRenderedDeadEnd).mock.calls.length, 513);
});

test("a Cloud-mode dead end writes no rate record; a Local or unmarked one writes one (ISS-12039)", () => {
  const recorder = createDeadEndTelemetryRecorder({ emit: () => true });
  const rateRecordsFor = (mode: { readsCloud?: boolean }) => {
    vi.mocked(recordRenderedDeadEnd).mockClear();
    assert.equal(
      recorder.record({
        treatment: DeadEndTreatment.SessionsListUnavailable,
        phase: DeadEndPhase.Rendered,
        state: DeadEndState.Unavailable,
        reason: DeadEndReason.FetchFailed,
        retryOffered: true,
        retryAttempt: 0,
        ...mode,
      }),
      true,
      "the detailed record is still taken"
    );
    return vi.mocked(recordRenderedDeadEnd).mock.calls.length;
  };

  assert.deepEqual(
    {
      cloud: rateRecordsFor({ readsCloud: true }),
      local: rateRecordsFor({ readsCloud: false }),
      absent: rateRecordsFor({}),
    },
    { cloud: 0, local: 1, absent: 1 }
  );
});
