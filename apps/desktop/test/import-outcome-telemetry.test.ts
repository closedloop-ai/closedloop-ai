/**
 * @file import-outcome-telemetry.test.ts
 * @description ISS-6335 (PRD-650) acceptance for the explicit import outcome.
 *
 * ISS-5103 suppressed the import-health `pass` record whenever both counters
 * read zero, which collapsed three different states into one observable —
 * silence: a fresh install with no harness sessions, an install whose sources
 * never finish importing, and a process that stopped reporting altogether. What
 * is pinned here is that each now names itself on the wire, and that a record
 * arrives on EVERY tick, so absence is a statement about the process.
 *
 * That last property is also the ISS-6336 unblock: its parse-throw, quarantine,
 * and parseQuality counters ride this record, and every one of them is zero in
 * exactly the scenario they exist to describe. The carrier has to survive an
 * all-zero window or those counters never leave the machine.
 *
 * ISS-5103's own counters, cardinality set, and best-effort boundary rules stay
 * in the sibling `import-health-telemetry.test.ts`; the fixtures both suites
 * drive are shared from `helpers/import-health-fixtures.ts`.
 */
import assert from "node:assert/strict";
import {
  AppTelemetrySchema,
  ImportGroupLabel,
  ImportHealthEvent,
  ImportIngestFailure,
  ImportOutcome,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetryHarnessName } from "@closedloop-ai/telemetry-contract/resource";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, test } from "vitest";
import type { ImportResult } from "../src/main/dashboard/agent-dashboard-db-types.js";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
import {
  buildImportHealthRecord,
  type DesktopImportHealthEventInput,
} from "../src/main/telemetry/app-otel-runtime-import-health.js";
import {
  createImportHealthTracker,
  installImportHealthTracking,
} from "../src/main/telemetry/import-health-telemetry.js";
import {
  decodeRelayImportRecords,
  HARNESS,
  importerReturning,
  NO_AUTOMATIC_TICK_MS,
  SESSION,
  startRelayRuntime,
} from "./helpers/import-health-fixtures.js";

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

test("a zero-session import reaches the relay as an explicit empty outcome", async () => {
  const { runtime, transport } = await startRelayRuntime(
    "install_import_outcome_empty"
  );
  activeRuntime = runtime;

  // A fresh install: the collector manager finds no harness sessions, so the
  // importer is never called and no row is parked at the sentinel. Driven
  // through `installImportHealthTracking` — the production wiring the dashboard
  // bootstrap uses — rather than the tracker factory directly.
  let sampleCalls = 0;
  const installed = installImportHealthTracking({
    emitImportHealth: (input) => runtime.emitImportHealthEvent(input),
    database: {
      importer: importerReturning(),
      listImportPendingSessionIds: () => {
        sampleCalls++;
        return Promise.resolve([]);
      },
    },
    log: () => undefined,
  });

  await installed.shutdown();
  await runtime.shutdown();
  activeRuntime = null;

  // Positive control: the tick really ran and got as far as the sentinel read,
  // so the assertion below is about the emit and not about a skipped tick.
  assert.equal(sampleCalls, 1);

  const records = decodeRelayImportRecords(transport);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(
    record?.[TelemetryAttribute.ImportEvent],
    ImportHealthEvent.Pass
  );
  assert.equal(record?.[TelemetryAttribute.ImportOutcome], ImportOutcome.Empty);
  assert.equal(record?.[TelemetryAttribute.ImportSessionsIncomplete], 0);
  assert.equal(record?.[TelemetryAttribute.ImportSessionsPendingRevision], 0);
  // Counts and closed enums only — the emit envelope's schema stamp is the only
  // other key allowed through, and no session id, path, or free text rides along.
  assert.deepEqual(
    Object.keys(record ?? {}).sort(),
    [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.ImportOutcome,
      TelemetryAttribute.ImportSessionsIncomplete,
      TelemetryAttribute.ImportSessionsPendingRevision,
      TelemetryEmitMetadataKey.SchemaName,
    ].sort()
  );
});

test("an all-zero window still carries the record ISS-6336's counters ride", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // Both of the counters ISS-5103's suppression keyed on read zero. A source
  // whose parse throws produces no session row at all, so this is precisely the
  // window in which ISS-6336's parse-throw / quarantine / parseQuality counters
  // would sit — and, before ISS-6335, be discarded with the whole record.
  await tracker.flushNow();

  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Empty,
      sessionsIncomplete: 0,
      sessionsPendingRevision: 0,
    },
  ]);
  tracker.dispose();
});

test("sources that never land are wedged, not empty", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  let innerCalls = 0;
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // `importSessionBounded` wraps this decorator, so a source that exceeds the
  // per-session bound resolves a synthetic result ABOVE us and our own await
  // never returns: no session row, nothing at the sentinel, and — before this
  // change — a window indistinguishable from a fresh install with no sources.
  const wrapped = tracker.wrapImporter({
    importSession: () => {
      innerCalls++;
      return new Promise<ImportResult>(() => undefined);
    },
  });
  const inFlight = Promise.resolve(wrapped.importSession(SESSION, HARNESS));
  const settled = await Promise.race([
    inFlight.then(() => "settled"),
    Promise.resolve("pending"),
  ]);
  await tracker.flushNow();

  // Positive control: the inner importer really was entered and really has not
  // answered, so the wedge below describes a started-but-unlanded window and
  // not a call that never happened.
  assert.equal(innerCalls, 1);
  assert.equal(settled, "pending");
  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Wedged,
      sessionsIncomplete: 0,
      sessionsPendingRevision: 0,
    },
  ]);
  tracker.dispose();
});

test("an import that never settles stays wedged in every later window", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  let innerCalls = 0;
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  const wrapped = tracker.wrapImporter({
    importSession: () => {
      innerCalls++;
      return new Promise<ImportResult>(() => undefined);
    },
  });
  const inFlight = Promise.resolve(wrapped.importSession(SESSION, HARNESS));
  const settlementProbe = () =>
    Promise.race([inFlight.then(() => "settled"), Promise.resolve("pending")]);

  // Three windows, one import call. Only the FIRST window sees it in a counter
  // the tick resets: the promise never settles, so it never re-enters
  // `importSession` and never reaches `observe()`. On window counters alone the
  // second and third would read 0/0 and report `empty`, and a consecutive-window
  // monitor could never fire on the one failure it exists to catch — the wedge
  // would erase its own evidence one tick after producing it.
  await tracker.flushNow();
  await tracker.flushNow();
  await tracker.flushNow();

  // Positive control: the inner importer was entered once and still has not
  // answered across all three windows, so the wedges below describe a genuinely
  // outstanding import rather than a call that never happened.
  assert.equal(innerCalls, 1);
  assert.equal(await settlementProbe(), "pending");
  const wedgedWindow = {
    kind: ImportHealthEvent.Pass,
    outcome: ImportOutcome.Wedged,
    sessionsIncomplete: 0,
    sessionsPendingRevision: 0,
  };
  assert.deepEqual(emitted, [wedgedWindow, wedgedWindow, wedgedWindow]);
  tracker.dispose();
});

test("a window whose results wrote nothing durable is wedged, not imported", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // The two shapes the collector manager itself scores as zero durable progress
  // (`isDurableImportProgress`): a `failed` import halted before the session was
  // handled, and a skip that did not reactivate matched an existing row and
  // wrote nothing. A result coming back is not, on its own, an import — a window
  // holding only these once read `imported`.
  const wrapped = tracker.wrapImporter(
    importerReturning(
      { skipped: false, reactivated: false, failed: true },
      { skipped: true, reactivated: false },
      { skipped: true, reactivated: true }
    )
  );
  await wrapped.importSession(SESSION, HARNESS);
  await tracker.flushNow();
  await wrapped.importSession(SESSION, HARNESS);
  await tracker.flushNow();
  // Positive control: a reactivated skip DID write, so the predicate is not
  // simply refusing every skip — and the window after it, with nothing offered
  // and every promise settled, drops back to `empty` rather than a stuck wedge.
  await wrapped.importSession(SESSION, HARNESS);
  await tracker.flushNow();
  await tracker.flushNow();

  assert.deepEqual(
    emitted.map((input) =>
      input.kind === ImportHealthEvent.Pass ? input.outcome : input.kind
    ),
    [
      ImportOutcome.Wedged,
      ImportOutcome.Wedged,
      ImportOutcome.Imported,
      ImportOutcome.Empty,
    ]
  );
  tracker.dispose();
});

test("a pass emit that fails before dispatch reports error, not silence", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const logged: string[] = [];
  const tracker = createImportHealthTracker({
    // The shape a real pre-dispatch failure takes: the `.strict()` app-schema
    // parse inside `buildImportHealthRecord` rejects the full record and nothing
    // is dispatched. The degraded `error` record carries a strict subset of the
    // same attributes, so it still ships.
    emitImportHealth: (input) => {
      if (
        input.kind === ImportHealthEvent.Pass &&
        input.outcome !== ImportOutcome.Error
      ) {
        throw new Error("record rejected before dispatch");
      }
      emitted.push(input);
    },
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    log: (message) => logged.push(message),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  await assert.doesNotReject(() => tracker.flushNow());

  // Silence now means the process stopped reporting, so a window whose own pass
  // record never left the machine has to say that rather than say nothing.
  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Error,
      sessionsIncomplete: 0,
    },
  ]);
  assert.equal(logged.length, 1);
  tracker.dispose();
});

test("a backlog parked at the sentinel is wedged on the very first tick", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () =>
      Promise.resolve(["parked-1", "parked-2"]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // A process that quits inside one tick window ships exactly one record: the
  // baseline tick, whose survivor count is structurally zero because there is
  // no prior snapshot to compare against. That zero must not become a positive
  // `empty` claim while a backlog sits at the sentinel.
  await tracker.flushNow();

  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Wedged,
      sessionsIncomplete: 0,
      sessionsPendingRevision: 0,
    },
  ]);
  tracker.dispose();
});

test("a failing sentinel sample reports error, not a clear sentinel", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const logged: string[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    // Only the sentinel read fails — no group failure precedes it, so the
    // sample is genuinely attempted rather than skipped by an earlier throw.
    listPendingRevisionSessionIds: () =>
      Promise.reject(new Error("db host is gone")),
    log: (message) => logged.push(message),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  await assert.doesNotReject(() => tracker.flushNow());

  // Degrading the failed read to `pending: 0` would ship `empty` — a positive
  // claim that nothing is stuck, computed from a read that never answered.
  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Error,
      sessionsIncomplete: 0,
    },
  ]);
  assert.equal(logged.length, 1);
  tracker.dispose();
});

test("a tick abandoned by the shutdown deadline emits nothing after dispose", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  let releaseSentinelRead: ((ids: string[]) => void) | undefined;
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () =>
      new Promise<string[]>((resolve) => {
        releaseSentinelRead = resolve;
      }),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // `installImportHealthTracking.shutdown()` races the final tick against the
  // 2s deadline and then disposes regardless, so a slow teardown-time db read
  // can answer AFTER dispose. The resumed tick must not ship an `empty` record
  // describing a torn-down tracker.
  const abandoned = tracker.flushNow();
  tracker.dispose();
  releaseSentinelRead?.([]);
  await abandoned;

  assert.deepEqual(emitted, []);
});

test("every emitted variant survives the strict app-schema boundary", () => {
  // The `.strict()` parse rejects an unknown key by dropping the WHOLE record,
  // silently and on every retry, so each shape the tracker can emit is round
  // tripped here rather than trusted to the producer's own tests.
  const variants: DesktopImportHealthEventInput[] = [
    {
      kind: ImportHealthEvent.GroupFailed,
      groupLabel: ImportGroupLabel.Events,
      count: 3,
    },
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Imported,
      sessionsIncomplete: 1,
      sessionsPendingRevision: 2,
    },
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Error,
      sessionsIncomplete: 1,
    },
    // ISS-6336. Enumerated here as well as in its own suite, because this list
    // is the claim that EVERY shape the tracker can emit round trips — a variant
    // missing from it makes the claim false by omission.
    {
      kind: ImportHealthEvent.IngestFailed,
      reason: ImportIngestFailure.SourceParseThrew,
      count: 4,
    },
    {
      kind: ImportHealthEvent.SourcesRemaining,
      harness: TelemetryHarnessName.Codex,
      sourcesRemaining: 0,
    },
    {
      kind: ImportHealthEvent.HarnessNotAdvancing,
      harness: TelemetryHarnessName.Codex,
      sourcesRemaining: 2465,
    },
    // ISS-6116: the frozen-source-scan shape, whose denominator is OMITTED. The
    // strict parse rejects the whole record on an unknown key, so the absent
    // optional has to be round tripped too, not just the populated one.
    {
      kind: ImportHealthEvent.HarnessNotAdvancing,
      harness: TelemetryHarnessName.Codex,
    },
  ];

  const keySets = variants.map((variant) => {
    const record = buildImportHealthRecord(variant);
    // Parsing again proves the built attributes are themselves schema-legal,
    // not merely that the builder ran.
    AppTelemetrySchema.parse(record.attributes);
    return Object.keys(record.attributes).sort();
  });

  assert.deepEqual(keySets, [
    [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.ImportGroupFailedCount,
      TelemetryAttribute.ImportGroupLabel,
    ].sort(),
    [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.ImportOutcome,
      TelemetryAttribute.ImportSessionsIncomplete,
      TelemetryAttribute.ImportSessionsPendingRevision,
    ].sort(),
    // The uncomputed survivor count is ABSENT, not null and not zero: a value
    // the producer never computed must not read as "nothing is stuck".
    [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.ImportOutcome,
      TelemetryAttribute.ImportSessionsIncomplete,
    ].sort(),
    [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.ImportIngestFailure,
      TelemetryAttribute.ImportIngestFailedCount,
    ].sort(),
    [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.HarnessName,
      TelemetryAttribute.ImportSourcesRemaining,
    ].sort(),
    [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.HarnessName,
      TelemetryAttribute.ImportSourcesRemaining,
    ].sort(),
    // Same rule one level down (ISS-6116): a frozen source scan has no
    // denominator, so the key is absent rather than reported as zero.
    [TelemetryAttribute.ImportEvent, TelemetryAttribute.HarnessName].sort(),
  ]);
});

test("import.outcome is a closed set", () => {
  assert.deepEqual(Object.values(ImportOutcome), [
    "imported",
    "empty",
    "wedged",
    "error",
  ]);
});

/**
 * ISS-12036 (tamsinb review): both sides of the wedge test are counted at
 * SETTLE. A byte-identical re-offer that entered in one window and settles in
 * the next must not cancel a genuine refusal that settles there too — netting
 * an entry-time count against a settle-time one did exactly that.
 */
test("a no-op settling across a window reset does not hide a refusal", async () => {
  const outcomes: string[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => {
      if (input.kind === ImportHealthEvent.Pass) {
        outcomes.push(input.outcome);
      }
    },
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  let releaseNoOp: (result: ImportResult) => void = () => undefined;
  const importer = tracker.wrapImporter({
    importSession: () =>
      new Promise<ImportResult>((resolve) => {
        releaseNoOp = resolve;
      }),
  });
  const refusals = tracker.wrapImporter(
    importerReturning({ skipped: true, reactivated: false })
  );

  // Window N: the no-op enters and is still outstanding at the tick.
  const noOp = importer.importSession(SESSION, HARNESS);
  await tracker.flushNow();
  // Window N+1: the no-op settles here, beside one refusal that wrote nothing.
  releaseNoOp({ skipped: true, reactivated: false, unchanged: true });
  await noOp;
  await refusals.importSession(SESSION, HARNESS);
  await tracker.flushNow();

  assert.deepEqual(outcomes, [ImportOutcome.Wedged, ImportOutcome.Wedged]);
  tracker.dispose();
});
