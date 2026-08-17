/**
 * @file import-health-telemetry.test.ts
 * @description ISS-5103 (PRD-611 gap 5) coverage for the desktop import-health
 * counters. Pins the three acceptance properties:
 *
 *   1. a fault-injected import failure produces the tagged counter THROUGH THE
 *      RELAY — the assertions decode the real OTLP protobuf the runtime shipped
 *      to the transport, not an in-process spy;
 *   2. the local success path emits nothing (a healthy install is silent, which
 *      is what makes the count-of-breaches monitor shape valid);
 *   3. the `import.group_label` cardinality set is closed and asserted EXACTLY —
 *      by value, and structurally against the write-core call sites via the
 *      TypeScript AST (never a raw-text scan of the source).
 *
 * Plus the boundary rules the counters have to honor: emission is best-effort
 * (a throwing sentinel sample or emit seam never reaches the import pipeline),
 * each tally increments only inside the branch whose precondition held, the
 * sentinel is reported even when no import result is ever observed (the wedged
 * case, where `importSessionBounded` resolves a synthetic result ABOVE this
 * decorator), a merely mid-import session is never counted as stuck, a result
 * arriving after dispose cannot resurrect the tracker, and shutdown drains the
 * tally rather than dropping it.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ImportGroupLabel,
  ImportHealthEvent,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import ts from "typescript6";
import type {
  Harness,
  NormalizedSession,
} from "../src/main/collectors/types.js";
import type {
  Importer,
  ImportResult,
} from "../src/main/dashboard/agent-dashboard-db-types.js";
import { WriteQueueCancelOutcome } from "../src/main/database/write-queue.js";
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
import type { DesktopImportHealthEventInput } from "../src/main/telemetry/app-otel-runtime-import-health.js";
import {
  createImportHealthTracker,
  installImportHealthTracking,
} from "../src/main/telemetry/import-health-telemetry.js";
import type { DesktopTelemetryTransport } from "../src/main/telemetry/relay-telemetry-transport.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRITE_CORE_PATH = path.join(
  TEST_DIR,
  "..",
  "src",
  "main",
  "database",
  "write-core.ts"
);

/**
 * The exact `import.group_label` value set, spelled out here rather than derived
 * from the contract so a silent edit to the contract fails this test. Order is
 * the write-core execution order, with the version-skew fallback last.
 */
const EXPECTED_GROUP_LABELS = [
  "events",
  "token_usage",
  "token_events",
  "activity_segments",
  "link_snapshot_before",
  "artifact_links",
  "pull_requests",
  "segment_work_item_refs",
  "component_invocations",
  "link_snapshot_after",
  "sync_watermark",
  "analytics_rollup",
  "revision_seal",
  "unknown",
];

/**
 * `runGroup` is called directly with a literal label at most call sites; the two
 * link-fingerprint groups go through the `snapshotLinks(label)` wrapper, which
 * forwards its own literal argument. Both are collected so the guard sees every
 * label write-core can actually produce.
 */
const LABEL_CALLEE_NAMES = new Set(["runGroup", "snapshotLinks"]);

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

type StubTransport = DesktopTelemetryTransport & {
  shipments: Array<{ signal: KeylessTelemetrySignal; body: Uint8Array }>;
};

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
 * Decode the attributes of every log record the runtime actually shipped over
 * the relay, keeping only the import-health ones (identified by the
 * `import.event` discriminator). The record's event name is deliberately not
 * read here: the desktop's own OTLP descriptor does not carry the LogRecord
 * `event_name` field, so the names are pinned on the local-buffer path instead.
 */
function decodeRelayImportRecords(
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
          if (attributes[TelemetryAttribute.ImportEvent] === undefined) {
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
    getAppInstallationId: () => "install_import_health",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();
  return { runtime, transport };
}

/** A stand-in session — the tracker never reads its fields, only the result. */
const SESSION = { sessionId: "session-1" } as unknown as NormalizedSession;
const HARNESS = "claude" as Harness;

function importerReturning(...results: ImportResult[]): Importer {
  const queue = [...results];
  return {
    importSession: () =>
      Promise.resolve(queue.shift() ?? { skipped: true, reactivated: false }),
  };
}

/**
 * A sentinel snapshot source returning the same ids every call, so a second tick
 * sees every id as a survivor.
 */
function stablePendingIds(
  ...ids: string[]
): (limit: number) => Promise<string[]> {
  return (limit: number) => Promise.resolve(ids.slice(0, Math.max(1, limit)));
}

/** A tick cadence long enough that only explicit `flushNow()` calls fire. */
const NO_AUTOMATIC_TICK_MS = 600_000;

test("a fault-injected import failure ships the tagged counter through the relay", async () => {
  const { runtime, transport } = await startRelayRuntime();
  const tracker = createImportHealthTracker({
    emitImportHealth: (input: DesktopImportHealthEventInput) =>
      runtime.emitImportHealthEvent(input),
    listPendingRevisionSessionIds: stablePendingIds(
      "stuck-1",
      "stuck-2",
      "stuck-3",
      "stuck-4"
    ),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // Two sessions fail the SAME group (the FK-787 shape) and one also fails a
  // second group, so the per-label tally is not merely "1".
  const wrapped = tracker.wrapImporter(
    importerReturning(
      {
        skipped: false,
        reactivated: false,
        incomplete: true,
        failedGroups: [ImportGroupLabel.ComponentInvocations],
      },
      {
        skipped: false,
        reactivated: false,
        incomplete: true,
        failedGroups: [
          ImportGroupLabel.ComponentInvocations,
          ImportGroupLabel.Events,
        ],
      }
    )
  );

  const first = await wrapped.importSession(SESSION, HARNESS);
  await wrapped.importSession(SESSION, HARNESS);
  // The decorator is transparent: the caller still sees the real result.
  assert.equal(first.incomplete, true);

  // Tick one drains the failure tally and takes the baseline sentinel snapshot.
  await tracker.flushNow();
  // Tick two sees the same ids still pending — now they are provably stuck.
  await tracker.flushNow();
  // shutdown() flushes the log batch processor through the OTLP exporter and
  // the relay transport, which is the path the monitor will actually read.
  await runtime.shutdown();
  activeRuntime = null;

  const records = decodeRelayImportRecords(transport);
  const groupFailures = records
    .filter(
      (attributes) =>
        attributes[TelemetryAttribute.ImportEvent] ===
        ImportHealthEvent.GroupFailed
    )
    .map((attributes) => ({
      label: attributes[TelemetryAttribute.ImportGroupLabel],
      count: attributes[TelemetryAttribute.ImportGroupFailedCount],
    }));

  assert.deepEqual(
    groupFailures.sort((a, b) =>
      String(a.label).localeCompare(String(b.label))
    ),
    [
      { label: ImportGroupLabel.ComponentInvocations, count: 2 },
      { label: ImportGroupLabel.Events, count: 1 },
    ]
  );

  const passRecords = records
    .filter(
      (attributes) =>
        attributes[TelemetryAttribute.ImportEvent] === ImportHealthEvent.Pass
    )
    .map((attributes) => ({
      incomplete: attributes[TelemetryAttribute.ImportSessionsIncomplete],
      pending: attributes[TelemetryAttribute.ImportSessionsPendingRevision],
    }));

  // The first tick cannot yet prove anything is stuck (nothing to compare
  // against), so it reports the two incomplete imports and zero survivors. The
  // second tick reports the four ids that outlived a full tick.
  assert.deepEqual(passRecords, [
    { incomplete: 2, pending: 0 },
    { incomplete: 0, pending: 4 },
  ]);

  // The record carries counts and the emit envelope's schema stamp only — no
  // session id, path, or free text can ride along (the `.strict()` app schema is
  // the enforcement; this is the proof, asserted on the wire).
  const passAttributes = records.find(
    (attributes) =>
      attributes[TelemetryAttribute.ImportEvent] === ImportHealthEvent.Pass
  );
  assert.deepEqual(
    Object.keys(passAttributes ?? {}).sort(),
    [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.ImportSessionsIncomplete,
      TelemetryAttribute.ImportSessionsPendingRevision,
      TelemetryEmitMetadataKey.SchemaName,
    ].sort()
  );
});

test("a session that is merely mid-import is never counted as stuck", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  // The sentinel holds a different session on each tick — the shape a healthy
  // backfill produces, since the revision-only heal path parks every row at the
  // sentinel for the duration of its own import without touching `updated_at`.
  const snapshots = [
    ["importing-now"],
    ["importing-next"],
    ["importing-later"],
  ];
  let call = 0;
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () =>
      Promise.resolve(snapshots[call++] ?? []),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  await tracker.flushNow();
  await tracker.flushNow();
  await tracker.flushNow();

  // No id survived a full tick, so nothing is reported — even though every tick
  // saw a row sitting at the sentinel.
  assert.deepEqual(emitted, []);
  tracker.dispose();
});

test("the sentinel is reported even when no import result is ever observed", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: stablePendingIds("wedged-1", "wedged-2"),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // No importer is ever wrapped and no result ever arrives — the wedged-DB case,
  // where `importSessionBounded` resolves a synthetic timeout result ABOVE this
  // decorator and our own await never returns. The tick is what makes the stuck
  // backlog visible anyway.
  await tracker.flushNow();
  await tracker.flushNow();

  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.Pass,
      sessionsIncomplete: 0,
      sessionsPendingRevision: 2,
    },
  ]);
  tracker.dispose();
});

test("import-health records carry their distinct event names on the local path", async () => {
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_import_health_local",
    isPackaged: false,
  });
  activeRuntime = runtime;
  await runtime.start();

  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => runtime.emitImportHealthEvent(input),
    listPendingRevisionSessionIds: stablePendingIds("stuck-1"),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const wrapped = tracker.wrapImporter(
    importerReturning({
      skipped: false,
      reactivated: false,
      incomplete: true,
      failedGroups: [ImportGroupLabel.ComponentInvocations],
    })
  );
  await wrapped.importSession(SESSION, HARNESS);
  await tracker.flushNow();
  await runtime.shutdown();
  activeRuntime = null;

  const importRecords = runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.attributes?.[TelemetryAttribute.ImportEvent] !== undefined
    );

  assert.deepEqual(
    importRecords.map((record) => record.name),
    ["import.group_failed", "import.health"]
  );
  for (const record of importRecords) {
    assert.equal(
      record.instrumentationScope?.name,
      "closedloop-desktop-import-health"
    );
  }
});

test("the local success path emits nothing at all", async () => {
  const { runtime, transport } = await startRelayRuntime();
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => {
      emitted.push(input);
      runtime.emitImportHealthEvent(input);
    },
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  const wrapped = tracker.wrapImporter(
    importerReturning(
      { skipped: false, reactivated: false },
      { skipped: true, reactivated: false }
    )
  );
  await wrapped.importSession(SESSION, HARNESS);
  await wrapped.importSession(SESSION, HARNESS);
  await tracker.flushNow();
  await tracker.flushNow();
  await runtime.shutdown();
  activeRuntime = null;

  // No failed group, nothing incomplete, nothing stuck → no record is emitted,
  // so a healthy fleet contributes zero to the monitor's window.
  assert.deepEqual(emitted, []);
  assert.deepEqual(decodeRelayImportRecords(transport), []);
  assert.deepEqual(runtime.getBufferedRecords(), []);
});

test("counters increment only in the branch whose precondition held", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  const wrapped = tracker.wrapImporter(
    importerReturning(
      { skipped: true, reactivated: false },
      // `failed` (halted before durable handling) is NOT `incomplete`: it must
      // not inflate the incomplete tally.
      { skipped: false, reactivated: false, failed: true },
      { skipped: false, reactivated: false, incomplete: true }
    )
  );
  await wrapped.importSession(SESSION, HARNESS);
  await wrapped.importSession(SESSION, HARNESS);
  await wrapped.importSession(SESSION, HARNESS);
  await tracker.flushNow();

  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.Pass,
      sessionsIncomplete: 1,
      sessionsPendingRevision: 0,
    },
  ]);
  tracker.dispose();
});

test("an unrecognized write-core label degrades to the closed set's unknown bucket", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  const wrapped = tracker.wrapImporter(
    importerReturning({
      skipped: false,
      reactivated: false,
      incomplete: true,
      // A group a newer write-core added before this contract learned it.
      failedGroups: ["a_group_the_contract_has_not_learned_yet"],
    })
  );
  await wrapped.importSession(SESSION, HARNESS);
  await tracker.flushNow();

  assert.deepEqual(
    emitted.filter((input) => input.kind === ImportHealthEvent.GroupFailed),
    [
      {
        kind: ImportHealthEvent.GroupFailed,
        groupLabel: ImportGroupLabel.Unknown,
        count: 1,
      },
    ]
  );
  tracker.dispose();
});

test("a throwing sentinel sample or emit seam never reaches the import pipeline", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const logged: string[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => {
      emitted.push(input);
      if (input.kind === ImportHealthEvent.GroupFailed) {
        throw new Error("emit seam exploded");
      }
    },
    listPendingRevisionSessionIds: () =>
      Promise.reject(new Error("sentinel sample exploded")),
    log: (message) => logged.push(message),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  const wrapped = tracker.wrapImporter(
    importerReturning({
      skipped: false,
      reactivated: false,
      incomplete: true,
      failedGroups: [ImportGroupLabel.Events],
    })
  );

  // The import result is returned intact despite the telemetry faults.
  const result = await wrapped.importSession(SESSION, HARNESS);
  assert.deepEqual(result, {
    skipped: false,
    reactivated: false,
    incomplete: true,
    failedGroups: [ImportGroupLabel.Events],
  });

  // The tick resolves rather than rejecting, and the pass record is SKIPPED
  // rather than shipped with a pending count that could not be computed.
  await assert.doesNotReject(() => tracker.flushNow());
  assert.deepEqual(
    emitted.map((input) => input.kind),
    [ImportHealthEvent.GroupFailed]
  );
  assert.equal(logged.length, 1);

  tracker.dispose();
});

test("a result arriving after dispose neither emits nor restarts sampling", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  let sampleCalls = 0;
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => {
      sampleCalls++;
      return Promise.resolve(["stuck-1"]);
    },
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // `importSessionBounded` abandons rather than cancels a timed-out import, so
  // its result can land long after teardown — after the DB host is gone.
  let releaseLateImport: (() => void) | undefined;
  const lateImport = new Promise<void>((resolve) => {
    releaseLateImport = resolve;
  });
  const wrapped = tracker.wrapImporter({
    importSession: async () => {
      await lateImport;
      return {
        skipped: false,
        reactivated: false,
        incomplete: true,
        failedGroups: [ImportGroupLabel.Events],
      };
    },
  });
  const pending = wrapped.importSession(SESSION, HARNESS);

  tracker.dispose();
  releaseLateImport?.();
  await pending;

  // The late result is dropped rather than reopening a tally on a disposed
  // tracker, and no further sampling is triggered.
  await tracker.flushNow();
  assert.deepEqual(emitted, []);
  assert.equal(sampleCalls, 1);
});

test("installImportHealthTracking drains the tally on shutdown", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const installed = installImportHealthTracking({
    emitImportHealth: (input) => emitted.push(input),
    database: {
      importer: importerReturning({
        skipped: false,
        reactivated: false,
        incomplete: true,
        failedGroups: [ImportGroupLabel.Events],
      }),
      listImportPendingSessionIds: () => Promise.resolve([]),
    },
    log: () => undefined,
  });

  await installed.importer.importSession(SESSION, HARNESS);
  // Shutdown runs while the DB host and relay are still alive, so the failure
  // inside the open tick window must still ship instead of being dropped.
  await installed.shutdown();

  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.GroupFailed,
      groupLabel: ImportGroupLabel.Events,
      count: 1,
    },
    {
      kind: ImportHealthEvent.Pass,
      sessionsIncomplete: 1,
      sessionsPendingRevision: 0,
    },
  ]);
});

test("installImportHealthTracking is inert without a telemetry seam", async () => {
  let sampleCalls = 0;
  const importer = importerReturning({
    skipped: false,
    reactivated: false,
    incomplete: true,
    failedGroups: [ImportGroupLabel.Events],
  });
  const installed = installImportHealthTracking({
    database: {
      importer,
      listImportPendingSessionIds: () => {
        sampleCalls++;
        return Promise.resolve(["stuck-1"]);
      },
    },
    log: () => undefined,
  });

  // The undecorated importer is handed straight back — no tally, and crucially
  // no sentinel queries against the database.
  assert.equal(installed.importer, importer);
  await installed.importer.importSession(SESSION, HARNESS);
  await installed.shutdown();
  assert.equal(sampleCalls, 0);
});

test("import.group_label is a closed set matching the write-core call sites exactly", () => {
  assert.deepEqual(Object.values(ImportGroupLabel), EXPECTED_GROUP_LABELS);

  // Structural (AST, never a raw-text scan): the labels write-core actually
  // passes must be exactly the contract's set minus the `unknown` fallback,
  // which has no call site by construction.
  const sourceFile = parseTypeScriptFile(WRITE_CORE_PATH);
  const callSiteLabels = new Set<string>();
  forEachNode(sourceFile, (node) => {
    if (!(ts.isCallExpression(node) && ts.isIdentifier(node.expression))) {
      return;
    }
    if (!LABEL_CALLEE_NAMES.has(node.expression.text)) {
      return;
    }
    const [firstArgument] = node.arguments;
    if (firstArgument && ts.isStringLiteral(firstArgument)) {
      callSiteLabels.add(firstArgument.text);
    }
  });

  assert.deepEqual(
    [...callSiteLabels].sort(),
    EXPECTED_GROUP_LABELS.filter(
      (label) => label !== ImportGroupLabel.Unknown
    ).sort()
  );
});

test("wrapping a db-host-style proxy importer invokes no stray op path", async () => {
  // In production the importer is the db-host ES Proxy, whose `get` trap answers
  // EVERY property path and whose `apply` trap issues a real IPC invoke. Reading
  // a non-method property like `.bind` off it therefore mints an op path, and
  // calling that path fires an invoke that cannot be structured-cloned — which
  // wedges the db-host client and every database read after it. This double
  // stands in for that proxy and fails if the decorator invokes anything it
  // should not.
  const invoked: string[] = [];
  const buildProxy = (path: string): ((...a: unknown[]) => unknown) =>
    new Proxy((() => undefined) as (...a: unknown[]) => unknown, {
      get: (_t, prop) =>
        typeof prop === "string"
          ? buildProxy(path === "" ? prop : `${path}.${prop}`)
          : undefined,
      apply: () => {
        invoked.push(path);
        return path.endsWith("importSession")
          ? Promise.resolve({ skipped: true, reactivated: false })
          : Promise.resolve(true);
      },
    });

  const tracker = createImportHealthTracker({
    emitImportHealth: () => undefined,
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  const wrapped = tracker.wrapImporter(
    buildProxy("importer") as unknown as Importer
  );
  // Wrapping alone must not call across the boundary at all.
  assert.deepEqual(invoked, []);

  await wrapped.importSession(SESSION, HARNESS);
  await wrapped.cancelInFlightWrite?.("session-1", new Error("evicted"));

  // Exactly the two real ops — never `importer.cancelInFlightWrite.bind`.
  assert.deepEqual(invoked, [
    "importer.importSession",
    "importer.cancelInFlightWrite",
  ]);
  tracker.dispose();
});

test("the decorator forwards cancelInFlightWrite verbatim, reason included", async () => {
  const calls: Array<{ sessionId: string; reason?: Error }> = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: () => undefined,
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const wrapped = tracker.wrapImporter({
    importSession: () => Promise.resolve({ skipped: true, reactivated: false }),
    cancelInFlightWrite: (sessionId: string, reason?: Error) => {
      calls.push({ sessionId, reason });
      return Promise.resolve(WriteQueueCancelOutcome.Running);
    },
  });

  // `importSessionBounded` passes a diagnostic Error as the second argument on
  // every bounded-timeout eviction; dropping it loses the eviction diagnostic.
  const reason = new Error("import exceeded its bound");
  const evicted = await wrapped.cancelInFlightWrite?.("session-1", reason);

  assert.deepEqual(calls, [{ sessionId: "session-1", reason }]);
  // The promise the db-host proxy returns is forwarded, not coerced — and the
  // ISS-6115 outcome survives verbatim, since collapsing it back to a boolean
  // would lose the queued-vs-running distinction the retry budget reads.
  assert.equal(evicted, WriteQueueCancelOutcome.Running);

  // An importer without the optional method must not gain one.
  const bare = tracker.wrapImporter({
    importSession: () => Promise.resolve({ skipped: true, reactivated: false }),
  });
  assert.equal(bare.cancelInFlightWrite, undefined);
  tracker.dispose();
});

test("shutdown completes even when the sentinel read never resolves", {
  timeout: 15_000,
}, async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  let sawSampleCall = false;
  const installed = installImportHealthTracking({
    emitImportHealth: (input) => emitted.push(input),
    database: {
      importer: importerReturning({
        skipped: false,
        reactivated: false,
        incomplete: true,
        failedGroups: [ImportGroupLabel.Events],
      }),
      // The db host is being torn down around us; this read never settles.
      listImportPendingSessionIds: () => {
        sawSampleCall = true;
        return new Promise<string[]>(() => undefined);
      },
    },
    log: () => undefined,
  });

  await installed.importer.importSession(SESSION, HARNESS);
  // An unbounded await here would hang process exit — the ISS-4585 failure
  // mode. `raceShutdownDeadline` abandons the read and lets the quit proceed.
  await installed.shutdown();

  assert.equal(sawSampleCall, true);
  // The group record emitted before the hanging read still shipped; the pass
  // record is correctly absent, since its pending count was never computable.
  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.GroupFailed,
      groupLabel: ImportGroupLabel.Events,
      count: 1,
    },
  ]);
});
