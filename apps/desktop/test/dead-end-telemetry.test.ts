/**
 * @file dead-end-telemetry.test.ts
 * @description ISS-7249 coverage for desktop dead-end treatment telemetry. Pins
 * the properties the issue is actually about:
 *
 *   1. a dead-end record arrives THROUGH THE RELAY — the assertions decode the
 *      real OTLP protobuf the runtime shipped to the transport, not an
 *      in-process spy, and the runtime is the real `createDesktopOtelRuntime`.
 *      An event that only reaches a logger nobody monitors has not been counted;
 *   2. the five no-data states survive the trip as FIVE DISTINCT values. A
 *      single `dead_end` counter would reproduce, in telemetry, exactly the
 *      collapse this ticket exists to undo;
 *   3. no session id, name, transcript text, or path can ride one of these
 *      records — a property of the payload's construction, not of a sanitizer;
 *   4. the vocabularies in the contract and in the renderer's Zod-free shared
 *      module are EXACTLY equal, so the duplication the renderer bundle forces
 *      cannot drift into a silently-dropped record;
 *   5. the production IPC handler really invokes the recorder — a wiring
 *      assertion, so deleting the call site cannot leave this suite green.
 *
 * Plus the boundary rules: a malformed or unknown-keyed IPC payload is dropped
 * rather than thrown, an out-of-range retry count is clamped rather than
 * forwarded, and emission is capped so a wedged renderer cannot flood the relay.
 */
import assert from "node:assert/strict";
import {
  DEAD_END_RETRY_ATTEMPT_MAX,
  DeadEndPhase,
  DeadEndReason,
  DeadEndRetryOutcome,
  DeadEndState,
  DeadEndTreatment,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import { afterEach, test } from "vitest";
import {
  DeadEndTelemetryIpcChannel,
  registerDeadEndTelemetryIpcHandlers,
} from "../src/main/ipc/dead-end-telemetry-ipc.js";
import {
  asOtlpRecordArray,
  decodeOtlpAttributes,
} from "../src/main/otlp/decode-utilities.js";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../src/main/otlp/proto-descriptor.js";
import {
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../src/main/telemetry/app-otel-runtime.js";
import { buildDeadEndRecord } from "../src/main/telemetry/app-otel-runtime-dead-end.js";
import {
  createDeadEndTelemetryRecorder,
  DEAD_END_RENDERER_VALUE_SETS,
} from "../src/main/telemetry/dead-end-telemetry-recorder.js";
import type { DesktopTelemetryTransport } from "../src/main/telemetry/relay-telemetry-transport.js";
import type {
  DeadEndRenderedTelemetryPayload,
  DeadEndSettledTelemetryPayload,
} from "../src/shared/dead-end-telemetry-contract.js";

/**
 * The exact five no-data states, spelled out here rather than derived from
 * either declaration, so a silent edit to EITHER fails this test rather than
 * both moving together into a shape nobody reviewed. This literal list is the
 * distinction the ticket is about; if it ever shrinks, that is the defect.
 */
const EXPECTED_STATES = [
  "loading",
  "unavailable",
  "not_applicable",
  "unknown",
  "true_zero",
];

/** The sender gate’s refusal, as a module-level literal (useTopLevelRegex). */
const UNTRUSTED_SENDER_ERROR = /untrusted sender/;

/** The exact why-set, spelled out for the same reason. */
const EXPECTED_REASONS = [
  "not_yet_synced",
  "absent",
  "fetch_failed",
  "permission_denied",
  "loading_threshold_exceeded",
  "filtered_out",
  "unclassified",
];

type StubTransport = DesktopTelemetryTransport & {
  shipments: Array<{ signal: KeylessTelemetrySignal; body: Uint8Array }>;
};

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  // The OTel global registries are process-wide; a runtime left registered
  // would have the next test's records land in the previous test's exporters.
  trace.disable();
  metrics.disable();
  logs.disable();
});

test("every dead-end state reaches the relay as a distinct value", async () => {
  // The acceptance criterion, driven end to end: the recorder is fed the exact
  // payloads the renderer sends, the REAL runtime builds and ships them, and the
  // assertions read the decoded OTLP protobuf off the keyless relay transport.
  const { runtime, transport } = await startRelayRuntime();
  const recorder = createDeadEndTelemetryRecorder({
    emit: (input) => runtime.emitDeadEndEvent(input),
  });

  for (const [state, reason] of [
    [DeadEndState.Loading, DeadEndReason.LoadingThresholdExceeded],
    [DeadEndState.Unavailable, DeadEndReason.FetchFailed],
    [DeadEndState.NotApplicable, DeadEndReason.FilteredOut],
    [DeadEndState.Unknown, DeadEndReason.Unclassified],
    [DeadEndState.TrueZero, DeadEndReason.Absent],
  ] as const) {
    assert.equal(recorder.record(payload({ state, reason })), true);
  }
  await runtime.flush();

  const records = decodeRelayDeadEndRecords(transport);
  const shippedStates = records.map(
    (record) => record[TelemetryAttribute.DeadEndState]
  );
  // Five in, five DIFFERENT out. A producer or a schema that folded any two of
  // them — a still-syncing list onto a genuinely empty one, a 500 onto a 404 —
  // shrinks this set, and that fold is the defect ISS-7249 names.
  assert.deepEqual(shippedStates, EXPECTED_STATES);
  assert.equal(new Set(shippedStates).size, 5);
  assert.deepEqual(
    records.map((record) => record[TelemetryAttribute.DeadEndReason]),
    [
      DeadEndReason.LoadingThresholdExceeded,
      DeadEndReason.FetchFailed,
      DeadEndReason.FilteredOut,
      DeadEndReason.Unclassified,
      DeadEndReason.Absent,
    ]
  );
});

test("a retry attempt and its outcome both reach the relay", async () => {
  // "A retry affordance that never succeeds is worse than an honest error" is
  // only checkable if BOTH halves ship — the press and what it settled into.
  const { runtime, transport } = await startRelayRuntime();
  const recorder = createDeadEndTelemetryRecorder({
    emit: (input) => runtime.emitDeadEndEvent(input),
  });

  recorder.record(
    payload({ phase: DeadEndPhase.RetryAttempted, retryAttempt: 1 })
  );
  recorder.record(
    settledPayload({
      retryAttempt: 1,
      retryOutcome: DeadEndRetryOutcome.StillDeadEnd,
    })
  );
  recorder.record(
    settledPayload({
      retryAttempt: 2,
      retryOutcome: DeadEndRetryOutcome.Recovered,
    })
  );
  await runtime.flush();

  const records = decodeRelayDeadEndRecords(transport);
  assert.deepEqual(
    records.map((record) => [
      record[TelemetryAttribute.DeadEndPhase],
      record[TelemetryAttribute.DeadEndRetryAttempt],
      record[TelemetryAttribute.DeadEndRetryOutcome],
    ]),
    [
      [DeadEndPhase.RetryAttempted, 1, undefined],
      [DeadEndPhase.RetrySettled, 1, DeadEndRetryOutcome.StillDeadEnd],
      [DeadEndPhase.RetrySettled, 2, DeadEndRetryOutcome.Recovered],
    ]
  );
});

test("the retry outcome is omitted on a record that is not a settled retry", () => {
  // Presence IS the statement that a retry finished, so a `rendered` record that
  // carried one would make an un-retried dead end look like a resolved retry.
  const record = buildDeadEndRecord({
    ...deadEndInput(),
    phase: DeadEndPhase.Rendered,
    retryOutcome: DeadEndRetryOutcome.Recovered,
  });

  assert.equal(
    TelemetryAttribute.DeadEndRetryOutcome in record.attributes,
    false
  );
});

test("the IPC boundary rejects the two phase/outcome combinations that cannot reconcile", () => {
  /*
   * ISS-7249 (whitlockk review). The flat schema this replaced accepted BOTH of
   * these, and the runtime then papered over each in a different direction: a
   * settled record with no outcome shipped incomplete, and an outcome on a
   * `rendered` record was silently dropped. Either way an analyst counting
   * `retry_attempted` against `retry_settled` gets a funnel that does not
   * reconcile, with nothing in the data saying why. They are now rejections at
   * the boundary, which the recorder reports as not taken.
   */
  const emitted: unknown[] = [];
  const recorder = createDeadEndTelemetryRecorder({
    emit: (input) => {
      emitted.push(input);
      return true;
    },
  });

  assert.equal(
    recorder.record({ ...deadEndInput(), phase: DeadEndPhase.RetrySettled }),
    false,
    "a settled retry with no outcome must not be emitted incomplete"
  );
  for (const phase of [DeadEndPhase.Rendered, DeadEndPhase.RetryAttempted]) {
    assert.equal(
      recorder.record({
        ...deadEndInput(),
        phase,
        retryOutcome: DeadEndRetryOutcome.Recovered,
      }),
      false,
      `an outcome on ${phase} must be rejected, not silently dropped`
    );
  }
  assert.deepEqual(emitted, []);

  // Positive control: both coherent shapes still pass, so the rejections above
  // are the discriminator working and not a schema that takes nothing.
  assert.equal(recorder.record(payload({})), true);
  assert.equal(
    recorder.record(
      settledPayload({ retryOutcome: DeadEndRetryOutcome.Recovered })
    ),
    true
  );
  assert.equal(emitted.length, 2);
});

test("a status is carried when one was received and omitted when none was", () => {
  // A request the client abandoned received no status. Reporting `0` for it
  // would state something about the server that never happened — the confident
  // wrong number this ticket is about, one layer down.
  assert.equal(
    buildDeadEndRecord({ ...deadEndInput(), httpStatus: 503 }).attributes[
      TelemetryAttribute.HttpResponseStatusCode
    ],
    503
  );
  for (const httpStatus of [undefined, 0, 42, 600, Number.NaN]) {
    assert.equal(
      TelemetryAttribute.HttpResponseStatusCode in
        buildDeadEndRecord({ ...deadEndInput(), httpStatus }).attributes,
      false,
      `status ${String(httpStatus)} must not be reported as a response`
    );
  }
});

test("the retry count is clamped at both ends rather than forwarded", () => {
  // `Math.min` alone does not prevent negatives, and an unbounded count from a
  // wedged renderer is a cardinality leak the contract would reject outright —
  // taking the whole record with it.
  for (const [retryAttempt, expected] of [
    [-1, 0],
    [0, 0],
    [3, 3],
    [DEAD_END_RETRY_ATTEMPT_MAX + 100, DEAD_END_RETRY_ATTEMPT_MAX],
    [Number.NaN, 0],
  ] as const) {
    assert.equal(
      buildDeadEndRecord({ ...deadEndInput(), retryAttempt }).attributes[
        TelemetryAttribute.DeadEndRetryAttempt
      ],
      expected
    );
  }
});

test("no session id, name, transcript text, or path can ride a dead-end record", () => {
  // The record is a privacy boundary by CONSTRUCTION. Each of these is a value a
  // careless producer might reach for; none of them has a field to travel in,
  // and the boundary parse rejects the whole payload rather than stripping it.
  const recorder = createDeadEndTelemetryRecorder({
    emit: () => {
      assert.fail("a payload carrying user content must never be emitted");
    },
  });
  const smuggled: unknown[] = [
    { ...deadEndInput(), sessionId: "ses_01H8XABCDEF" },
    { ...deadEndInput(), sessionName: "Refactor the billing service" },
    { ...deadEndInput(), transcriptPath: "/Users/example/.claude/projects" },
    { ...deadEndInput(), url: "https://app.closedloop.ai/acme/sessions/ses_1" },
    { ...deadEndInput(), treatment: "ses_01H8XABCDEF" },
    { ...deadEndInput(), reason: "Refactor the billing service" },
    { ...deadEndInput(), state: "/Users/example/Library/Application Support" },
  ];

  for (const candidate of smuggled) {
    assert.equal(
      recorder.record(candidate),
      false,
      `payload must be rejected: ${JSON.stringify(candidate)}`
    );
  }

  // Positive control: the same recorder DOES take a well-formed record, so the
  // rejections above are the boundary working and not a recorder that is inert.
  let emitted = 0;
  const workingRecorder = createDeadEndTelemetryRecorder({
    emit: () => {
      emitted += 1;
      return true;
    },
  });
  assert.equal(workingRecorder.record(payload({})), true);
  assert.equal(emitted, 1);
});

test("a malformed payload is dropped without burning the emission cap", () => {
  let emitted = 0;
  const recorder = createDeadEndTelemetryRecorder({
    emit: () => {
      emitted += 1;
      return true;
    },
    maxRecords: 2,
  });

  // A tally incremented before its precondition held would report rejected
  // payloads as emitted records and spend the cap on them.
  for (const bad of [
    null,
    undefined,
    "rendered",
    7,
    {},
    { phase: "rendered" },
  ]) {
    assert.equal(recorder.record(bad), false);
  }
  assert.equal(recorder.record(payload({})), true);
  assert.equal(recorder.record(payload({})), true);
  assert.equal(recorder.record(payload({})), false, "cap must hold");
  assert.equal(emitted, 2);
});

test("a record the runtime silently drops is reported as not taken", async () => {
  /*
   * review cid 3821326107. `emitDeadEndEvent` no-ops when the runtime is not
   * Started — no throw, no signal — so `record()` returning a flat `true` made a
   * dropped record indistinguishable from a delivered one, and the IPC handler
   * answered the renderer `{ ok: true }` over it. The handler's own comment says
   * `ok` means the record was TAKEN, so that was the confident wrong value the
   * rest of this file exists to prevent.
   *
   * Driven through the REAL runtime, unstarted, which is the production shape:
   * a record emitted during startup, or after `start()` failed.
   */
  const transport = createStubTransport();
  const unstartedRuntime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_dead_end",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = unstartedRuntime;
  const recorder = createDeadEndTelemetryRecorder({
    emit: (input) => unstartedRuntime.emitDeadEndEvent(input),
    maxRecords: 2,
  });

  // Well-formed payload, so the parse is not what rejects it.
  assert.equal(recorder.record(payload({})), false);
  assert.equal(recorder.record(payload({})), false);
  assert.equal(recorder.record(payload({})), false);
  assert.equal(transport.shipments.length, 0);

  // The cap is intact: a record that never shipped is not an emitted record, so
  // dropping three did not spend the two the runtime will take once started.
  await unstartedRuntime.start();
  assert.equal(recorder.record(payload({})), true);
  assert.equal(recorder.record(payload({})), true);
  assert.equal(recorder.record(payload({})), false, "cap must hold");
});

test("the contract and the renderer's Zod-free copies name exactly the same values", () => {
  // The renderer must not import a Zod-bearing module to send five enums, so the
  // values are declared twice. This is the guard that stops the two declarations
  // drifting into a silently-rejected record.
  for (const [name, [rendererSet, contractSet]] of Object.entries(
    DEAD_END_RENDERER_VALUE_SETS
  )) {
    assert.deepEqual(
      new Set(Object.values(rendererSet)),
      new Set(Object.values(contractSet)),
      `${name} vocabularies must be exactly equal`
    );
  }
  // And the two sets the whole ticket rests on are the literal lists above, not
  // whatever the declarations currently happen to say.
  assert.deepEqual(
    Object.values(DeadEndState).toSorted(),
    EXPECTED_STATES.toSorted()
  );
  assert.deepEqual(
    Object.values(DeadEndReason).toSorted(),
    EXPECTED_REASONS.toSorted()
  );
});

test("the production IPC handler invokes the recorder behind a trusted-sender gate", () => {
  // A wiring assertion: deleting the call site in the handler must not leave
  // this suite green.
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  const recorded: unknown[] = [];
  registerDeadEndTelemetryIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: (sender) => sender === "trusted",
      recordDeadEndTelemetry: (value) => {
        recorded.push(value);
        return true;
      },
    }
  );

  const handler = handlers.get(DeadEndTelemetryIpcChannel.RecordDeadEnd);
  assert.ok(handler, "the dead-end channel must be registered");

  assert.throws(
    () => handler({ sender: "hostile" }, payload({})),
    UNTRUSTED_SENDER_ERROR
  );
  assert.deepEqual(recorded, []);

  assert.deepEqual(handler({ sender: "trusted" }, payload({})), { ok: true });
  assert.deepEqual(recorded, [payload({})]);
});

test("the handler reports a rejected record as not taken, never a flat ok", () => {
  // A rejected payload, an absent recorder, and a recorded event are three
  // different outcomes. Collapsing them into `ok: true` is what makes a dropped
  // signal look delivered — the failure mode this whole ticket describes.
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  registerDeadEndTelemetryIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    { isTrustedSender: () => true }
  );

  const handler = handlers.get(DeadEndTelemetryIpcChannel.RecordDeadEnd);
  assert.deepEqual(handler?.({ sender: "trusted" }, payload({})), {
    ok: false,
  });
});

function deadEndInput() {
  return {
    treatment: DeadEndTreatment.SessionsListUnavailable,
    phase: DeadEndPhase.Rendered,
    state: DeadEndState.Unavailable,
    reason: DeadEndReason.FetchFailed,
    retryOffered: true,
    retryAttempt: 0,
  };
}

/**
 * A `rendered` / `retry_attempted` record. It cannot carry a `retryOutcome`,
 * which is now the contract rather than a convention the runtime silently
 * enforced by dropping the field (ISS-7249, whitlockk review).
 */
function payload(
  overrides: Partial<Omit<DeadEndRenderedTelemetryPayload, "retryOutcome">> = {}
): DeadEndRenderedTelemetryPayload {
  return { ...deadEndInput(), ...overrides };
}

/** A settled retry, where the outcome is the whole point of the record. */
function settledPayload(
  overrides: Partial<Omit<DeadEndSettledTelemetryPayload, "phase">> & {
    retryOutcome: DeadEndRetryOutcome;
  }
): DeadEndSettledTelemetryPayload {
  return {
    ...deadEndInput(),
    ...overrides,
    phase: DeadEndPhase.RetrySettled,
  };
}

function createStubTransport(): StubTransport {
  const shipments: Array<{
    signal: KeylessTelemetrySignal;
    body: Uint8Array;
  }> = [];
  return {
    shipments,
    start() {},
    stop() {},
    flush() {
      return Promise.resolve();
    },
    export(signal, body) {
      shipments.push({ signal, body: Uint8Array.from(body) });
      return Promise.resolve(true);
    },
  };
}

/**
 * Decode the attributes of every dead-end log record the runtime actually
 * shipped over the relay, identified by the `dead_end.phase` discriminator.
 *
 * The record's event NAME is deliberately not read here: the desktop's own OTLP
 * descriptor does not carry the LogRecord `event_name` field, exactly as the
 * import-health and onboarding suites document.
 */
function decodeRelayDeadEndRecords(
  transport: StubTransport
): Record<string, unknown>[] {
  const logRequestType = getOtlpRequestType(OtlpExportKind.Logs);
  const decoded: Record<string, unknown>[] = [];
  for (const shipment of transport.shipments) {
    if (shipment.signal !== KeylessTelemetrySignal.Logs) {
      continue;
    }
    const request = logRequestType.toObject(
      logRequestType.decode(shipment.body),
      { bytes: String, longs: String }
    ) as { resourceLogs?: unknown };
    for (const resourceLog of asOtlpRecordArray(request.resourceLogs)) {
      for (const scopeLog of asOtlpRecordArray(resourceLog.scopeLogs)) {
        for (const record of asOtlpRecordArray(scopeLog.logRecords)) {
          const attributes = decodeOtlpAttributes(
            asOtlpRecordArray(record.attributes)
          );
          if (attributes[TelemetryAttribute.DeadEndTreatment] === undefined) {
            continue;
          }
          decoded.push(attributes);
        }
      }
    }
  }
  return decoded;
}

async function startRelayRuntime(): Promise<{
  runtime: DesktopOtelRuntime;
  transport: StubTransport;
}> {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_dead_end",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();
  return { runtime, transport };
}
