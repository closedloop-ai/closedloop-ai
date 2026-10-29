/**
 * @file import-health-telemetry.test.ts
 * @description ISS-5103 (PRD-611 gap 5) coverage for the desktop import-health
 * counters. Pins the three acceptance properties:
 *
 *   1. a fault-injected import failure produces the tagged counter THROUGH THE
 *      RELAY — the assertions decode the real OTLP protobuf the runtime shipped
 *      to the transport, not an in-process spy;
 *   2. the local success path still reports (ISS-6335 replaced ISS-5103's
 *      silent-when-healthy rule with an explicit `imported`/`empty` outcome, so
 *      absence of a record now means the process stopped reporting);
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
import { fileURLToPath } from "node:url";
import {
  ImportGroupLabel,
  ImportHealthEvent,
  ImportOutcome,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetryHarnessName } from "@closedloop-ai/telemetry-contract/resource";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import ts from "typescript6";
import { afterEach, test } from "vitest";
import type { Importer } from "../src/main/dashboard/agent-dashboard-db-types.js";
import {
  type WriteDispatchProbe,
  WriteDispatchState,
  WriteQueueCancelOutcome,
} from "../src/main/database/write-queue.js";
import {
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../src/main/telemetry/app-otel-runtime.js";
import type { DesktopImportHealthEventInput } from "../src/main/telemetry/app-otel-runtime-import-health.js";
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
  type StubTransport,
  stablePendingIds,
  startRelayRuntime as startRelayRuntimeFixture,
} from "./helpers/import-health-fixtures.js";
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
 * the write-core execution order a desktop that emitted every one of them used,
 * with the version-skew fallback last; the four {@link RETIRED_GROUP_LABELS}
 * keep their historical position.
 */
const EXPECTED_GROUP_LABELS = [
  "events",
  "token_usage",
  "token_events",
  "activity_segments",
  "link_snapshot_before",
  "artifact_links",
  "pull_requests",
  "pr_link_teardown_watermark",
  "segment_work_item_refs",
  "component_invocations",
  "link_snapshot_after",
  "sync_watermark",
  "analytics_rollup",
  "revision_seal",
  "unknown",
];

/**
 * ISS-8758 retired the first three groups: the link fingerprint is now bracketed
 * inside each writing phase's own transaction instead of a pair of standalone
 * snapshot groups, and the watermark bump commits with the change it describes
 * instead of in a tolerant group of its own. ISS-8905 retired the fourth, the
 * compensating bump ISS-8758 itself had to add, by moving the `normalized_pr`
 * teardown into the pull-requests transaction so delete and restore share a
 * commit and nothing is left to compensate for. All four stay in the CONTRACT
 * because an older desktop build still emits them and the collector validates
 * against that closed set — removing a value would reject a version-skewed
 * install's telemetry — but no current call site produces one.
 */
const RETIRED_GROUP_LABELS = new Set<string>([
  ImportGroupLabel.LinkSnapshotBefore,
  ImportGroupLabel.LinkSnapshotAfter,
  ImportGroupLabel.SyncWatermark,
  ImportGroupLabel.PrLinkTeardownWatermark,
]);

/** `runGroup` is called with a literal label at every call site. */
const LABEL_CALLEE_NAMES = new Set(["runGroup"]);

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

async function startRelayRuntime(): Promise<{
  runtime: DesktopOtelRuntime;
  transport: StubTransport;
}> {
  const started = await startRelayRuntimeFixture("install_import_health");
  activeRuntime = started.runtime;
  return started;
}

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
      outcome: attributes[TelemetryAttribute.ImportOutcome],
      incomplete: attributes[TelemetryAttribute.ImportSessionsIncomplete],
      pending: attributes[TelemetryAttribute.ImportSessionsPendingRevision],
    }));

  // The first tick cannot yet prove anything is stuck (nothing to compare
  // against), so it reports the two incomplete imports and zero survivors. The
  // second tick reports the four ids that outlived a full tick — and with no
  // import completing in that window, the outcome is the wedge.
  assert.deepEqual(passRecords, [
    { outcome: ImportOutcome.Imported, incomplete: 2, pending: 0 },
    { outcome: ImportOutcome.Wedged, incomplete: 0, pending: 4 },
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
      TelemetryAttribute.ImportOutcome,
      TelemetryAttribute.ImportSessionsIncomplete,
      TelemetryAttribute.ImportSessionsPendingRevision,
      TelemetryEmitMetadataKey.SchemaName,
    ].sort()
  );
});

/**
 * ISS-12036: a window whose only imports were byte-identical re-offers is NOT a
 * wedge.
 *
 * `write-core.ts` sets `skipped` for a no-op re-import (FEA-3227), so such a
 * result counted as an entered import and could never raise `progressed` —
 * `isDurableImportProgress` reads it as no progress, correctly, because nothing
 * was written. The wedge term was bare `started`, so a source the orphan
 * self-heal re-offers on every pass reported `wedged` forever on an install
 * where nothing was wrong: 134 of 208 outcomes on the install ISS-12036
 * measured, every one of them with `sessionsIncomplete: 0` and
 * `sessionsPendingRevision: 0`.
 *
 * The third window is the counterfactual that keeps the exemption from
 * excusing a real wedge: one genuine no-row refusal alongside the no-ops — the
 * FEA-2027 unsafe-token-count shape, which is `{ skipped, !reactivated }` with
 * no `unchanged` — still reports it.
 *
 * MUTATION: count an `unchanged` result as `unlanded` in `observe` and the
 * second window reads `wedged`.
 */
test("ISS-12036: a window of byte-identical re-offers is empty, not wedged", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const noOp = { skipped: true, reactivated: false, unchanged: true };
  // A refusal that wrote no row: the same `{ skipped, !reactivated }` shape,
  // deliberately WITHOUT `unchanged`.
  const refusal = { skipped: true, reactivated: false };

  // Window 1: nothing offered at all.
  await tracker.flushNow();
  // Window 2: two no-op re-offers and nothing else.
  const noOps = tracker.wrapImporter(importerReturning(noOp, noOp));
  await noOps.importSession(SESSION, HARNESS);
  await noOps.importSession(SESSION, HARNESS);
  await tracker.flushNow();
  // Window 3: the same two no-ops plus one genuine refusal.
  const mixed = tracker.wrapImporter(importerReturning(noOp, noOp, refusal));
  await mixed.importSession(SESSION, HARNESS);
  await mixed.importSession(SESSION, HARNESS);
  await mixed.importSession(SESSION, HARNESS);
  await tracker.flushNow();

  assert.deepEqual(
    emitted
      .filter((input) => input.kind === ImportHealthEvent.Pass)
      .map((input) =>
        input.kind === ImportHealthEvent.Pass ? input.outcome : input.kind
      ),
    [ImportOutcome.Empty, ImportOutcome.Empty, ImportOutcome.Wedged]
  );
  tracker.dispose();
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

  // Every tick saw a row sitting at the sentinel, but no id survived a full
  // tick — so the survivor count stays zero throughout. The baseline tick has
  // no prior snapshot and so cannot yet tell a churning row from a parked one;
  // it leans `wedged` rather than claim a clear sentinel it did not verify.
  // From the second tick on, survivorship IS provable and the healthy backfill
  // reads `empty`, so a consecutive-window monitor never fires on it.
  assert.deepEqual(
    emitted.map((input) =>
      input.kind === ImportHealthEvent.Pass
        ? {
            outcome: input.outcome,
            pending: input.sessionsPendingRevision,
          }
        : input.kind
    ),
    [
      { outcome: ImportOutcome.Wedged, pending: 0 },
      { outcome: ImportOutcome.Empty, pending: 0 },
      { outcome: ImportOutcome.Empty, pending: 0 },
    ]
  );
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
  // backlog visible anyway: the baseline tick cannot yet PROVE survivorship, so
  // it reports zero survivors while still naming the window wedged.
  await tracker.flushNow();
  await tracker.flushNow();

  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Wedged,
      sessionsIncomplete: 0,
      sessionsPendingRevision: 0,
    },
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Wedged,
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

test("the local success path reports an explicit outcome rather than silence", async () => {
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

  // ISS-6335: no failed group, nothing incomplete, nothing stuck — and the
  // window still reports. The first tick saw both imports land (`imported`);
  // the second saw no work at all (`empty`). ISS-5103 suppressed both, which is
  // what made a healthy install indistinguishable from a dead one.
  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Imported,
      sessionsIncomplete: 0,
      sessionsPendingRevision: 0,
    },
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Empty,
      sessionsIncomplete: 0,
      sessionsPendingRevision: 0,
    },
  ]);
  // And they reach the relay, not just the in-process seam.
  assert.deepEqual(
    decodeRelayImportRecords(transport).map(
      (attributes) => attributes[TelemetryAttribute.ImportOutcome]
    ),
    [ImportOutcome.Imported, ImportOutcome.Empty]
  );
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
      outcome: ImportOutcome.Imported,
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

  // The tick resolves rather than rejecting, and the window is reported as
  // `error` rather than shipped with a pending count that could not be
  // computed — the survivor count is OMITTED, never zeroed, so an uncomputed
  // sample cannot read as "nothing is stuck".
  await assert.doesNotReject(() => tracker.flushNow());
  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.GroupFailed,
      groupLabel: ImportGroupLabel.Events,
      count: 1,
    },
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Error,
      sessionsIncomplete: 1,
    },
  ]);
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
  // tracker, and no further sampling is triggered. ISS-6335 adds a second
  // reason the record stays absent: with the outcome now emitted on every tick,
  // a pass record here would ship an `empty` window describing a tracker that
  // no longer exists.
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
      outcome: ImportOutcome.Imported,
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
      (label) =>
        label !== ImportGroupLabel.Unknown && !RETIRED_GROUP_LABELS.has(label)
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

const QUEUED_PROBE: WriteDispatchProbe = {
  state: WriteDispatchState.Queued,
  taskSeq: 17,
};

test("ISS-7256: the decorator forwards hasUndispatchedWrite — the manager sees only this wrapper", async () => {
  const asked: string[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: () => undefined,
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const wrapped = tracker.wrapImporter({
    importSession: () => Promise.resolve({ skipped: true, reactivated: false }),
    hasUndispatchedWrite: (sessionId: string) => {
      asked.push(sessionId);
      return Promise.resolve(QUEUED_PROBE);
    },
  });

  // `importSessionBounded` only ever holds this wrapper, so a hook the decorator
  // drops is a hook that does not exist in production.
  const waiting = await wrapped.hasUndispatchedWrite?.("session-1");

  assert.deepEqual(asked, ["session-1"]);
  assert.deepEqual(
    waiting,
    QUEUED_PROBE,
    "the PROBE is forwarded whole — a decorator that collapsed it to a boolean would drop the taskSeq the re-arm's staleness check needs"
  );

  // An importer without the optional probe must not gain one — the bound then
  // keeps its pre-ISS-7256 behavior rather than reading a fabricated answer.
  const bare = tracker.wrapImporter({
    importSession: () => Promise.resolve({ skipped: true, reactivated: false }),
  });
  assert.equal(bare.hasUndispatchedWrite, undefined);
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

test("ISS-8600: the three occurrence records ship exactly import.event and harness.name", async () => {
  const { runtime, transport } = await startRelayRuntime();
  const tracker = createImportHealthTracker({
    emitImportHealth: (input: DesktopImportHealthEventInput) =>
      runtime.emitImportHealthEvent(input),
    listPendingRevisionSessionIds: stablePendingIds(),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // No `flushNow()` anywhere below, and that is the point: unlike the window
  // tallies these are OCCURRENCES and must reach the relay on the spot. A
  // regression that accumulated them into the five-minute tick would ship
  // nothing here.
  tracker.noteWatchLost(TelemetryHarnessName.Copilot);
  // Two DIFFERENT harnesses, and the first is deliberately not the one batch
  // collector shipping today: the tracker used to stamp `opencode` on every
  // materialize record itself, and a same-harness pair here would leave that
  // hardcode green.
  tracker.noteMaterializeOutcome(
    TelemetryHarnessName.Cursor,
    ImportHealthEvent.MaterializeFailed
  );
  tracker.noteMaterializeOutcome(
    TelemetryHarnessName.OpenCode,
    ImportHealthEvent.MaterializeTimedOut
  );

  await runtime.shutdown();
  activeRuntime = null;

  const records = decodeRelayImportRecords(transport);
  // EXACT key sets, per kind, decoded off the wire. These records ride a pipe
  // contractually limited to counts and closed enums, so this is what stops a
  // later edit smuggling a watch root's path or a session id onto them — and it
  // is also what stops `sourcesRemaining` being copied across from the backfill
  // records it does not describe.
  for (const kind of [
    ImportHealthEvent.WatchLost,
    ImportHealthEvent.MaterializeFailed,
    ImportHealthEvent.MaterializeTimedOut,
  ]) {
    const attributes = records.find(
      (candidate) => candidate[TelemetryAttribute.ImportEvent] === kind
    );
    assert.ok(attributes, `${kind} must reach the relay`);
    assert.deepEqual(
      Object.keys(attributes).sort(),
      [
        TelemetryAttribute.ImportEvent,
        TelemetryAttribute.HarnessName,
        TelemetryEmitMetadataKey.SchemaName,
      ].sort(),
      `${kind} must carry exactly import.event and harness.name`
    );
  }

  const occurrences: string[] = [
    ImportHealthEvent.WatchLost,
    ImportHealthEvent.MaterializeFailed,
    ImportHealthEvent.MaterializeTimedOut,
  ];
  assert.deepEqual(
    records
      .filter((attributes) =>
        occurrences.includes(String(attributes[TelemetryAttribute.ImportEvent]))
      )
      .map((attributes) => [
        attributes[TelemetryAttribute.ImportEvent],
        attributes[TelemetryAttribute.HarnessName],
      ]),
    [
      // Every occurrence record carries the harness its CALLER named — the
      // watcher's is whichever collector went dark, and a materialize pass's is
      // whichever store the lane that owns the runner regenerates.
      [ImportHealthEvent.WatchLost, TelemetryHarnessName.Copilot],
      [ImportHealthEvent.MaterializeFailed, TelemetryHarnessName.Cursor],
      [ImportHealthEvent.MaterializeTimedOut, TelemetryHarnessName.OpenCode],
    ]
  );
});

test("ISS-8600: occurrence reports after dispose, from an unknown harness, or into a throwing seam are all swallowed", () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const logged: string[] = [];
  let throwOnEmit = false;
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => {
      if (throwOnEmit) {
        throw new Error("relay dispatch failed");
      }
      emitted.push(input);
    },
    listPendingRevisionSessionIds: stablePendingIds(),
    tickMs: NO_AUTOMATIC_TICK_MS,
    log: (message) => logged.push(message),
  });

  // A harness outside the contract's closed `harness.name` set is dropped
  // rather than widening the attribute's cardinality at runtime.
  tracker.noteWatchLost("aider");
  assert.deepEqual(emitted, [], "an unknown harness must emit nothing");
  // Dropped is not the same as silent. The trigger is a code defect — the
  // collectors gained a harness the contract has not learned — so the key that
  // caused it has to be recoverable from the collector log, the way the
  // ISS-6116 harness-progress path already reports its own drop.
  assert.deepEqual(
    logged.filter((message) => message.includes("aider")),
    ["import-health watch lost: unknown harness key aider"],
    "an unknown harness key must be named on the local log"
  );

  // A throwing emit seam must not reach the collector pass that reported.
  throwOnEmit = true;
  tracker.noteWatchLost(TelemetryHarnessName.Claude);
  tracker.noteMaterializeOutcome(
    TelemetryHarnessName.OpenCode,
    ImportHealthEvent.MaterializeFailed
  );
  throwOnEmit = false;

  tracker.dispose();
  tracker.noteWatchLost(TelemetryHarnessName.Claude);
  tracker.noteMaterializeOutcome(
    TelemetryHarnessName.OpenCode,
    ImportHealthEvent.MaterializeTimedOut
  );
  assert.deepEqual(
    emitted,
    [],
    "a report after dispose must not resurrect a torn-down window"
  );
});
