/**
 * @file import-stall-telemetry.test.ts
 * @description ISS-6116 (PRD-650) acceptance for the backfill-side import-health
 * records.
 *
 * ISS-5103's counters watch what the IMPORTER did and what sits at the
 * DATA_REVISION_IMPORT_PENDING sentinel. Both are structurally blind to the
 * wedge ISS-6003 documents: a source whose import never completes writes no
 * session row, so nothing reaches the sentinel to be counted, and its record
 * groups never FAIL — they are merely slow, and the outer per-session bound
 * abandons the import. A store wedged for eight days at `codex 0/2465` reported
 * ONE session at the sentinel.
 *
 * The measured 0/2465 shape is therefore the primary case here, not an edge
 * case: the first test drives it end to end and asserts on the OTLP protobuf the
 * runtime actually shipped, alongside the install-scoped pass record that reads
 * `empty` for the same window — the blindness, pinned.
 *
 * The rest is the defeat space. "No forward progress" is true for several
 * reasons that are not a wedge (a pass that just began, one parked at the user's
 * backfill pause or yielded to a live event, one that already settled, a harness
 * whose scan found nothing at all), and a false stall on a fresh install would
 * make the signal worthless in the same way a blind one is. Each is pinned
 * against the real `IngestProgressTracker`, whose no-progress condition this
 * shares rather than re-deriving.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ImportHealthEvent,
  ImportOutcome,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetryHarnessName } from "@closedloop-ai/telemetry-contract/resource";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { Harness } from "@repo/lib/harness/types";
import ts from "typescript6";
import { afterEach, test } from "vitest";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
import {
  buildImportHealthRecord,
  type DesktopImportHealthEventInput,
  IMPORT_HARNESS_NOT_ADVANCING_EVENT_NAME,
  IMPORT_MATERIALIZE_FAILED_EVENT_NAME,
  IMPORT_MATERIALIZE_TIMED_OUT_EVENT_NAME,
  IMPORT_SOURCES_REMAINING_EVENT_NAME,
  IMPORT_WATCH_LOST_EVENT_NAME,
} from "../src/main/telemetry/app-otel-runtime-import-health.js";
import {
  createImportHealthTracker,
  installImportHealthTracking,
} from "../src/main/telemetry/import-health-telemetry.js";
import {
  decodeRelayImportRecords,
  importerReturning,
  NO_AUTOMATIC_TICK_MS,
  type StubTransport,
  startRelayRuntime as startRelayRuntimeFixture,
} from "./helpers/import-health-fixtures.js";
import { createTracker } from "./helpers/ingest-progress-fixture.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

/** The measured wedge: `codex 0/2465`, zero net progress for eight days. */
const WEDGED_SOURCE_COUNT = 2465;
/** The tracker's own no-progress window; the sweep reports past this. */
const STALL_WARN_MS = 60_000;
/** What the install-scoped half of an idle window emits, unchanged by ISS-6116. */
const PASS_RECORD_FOR_AN_EMPTY_WINDOW = {
  kind: ImportHealthEvent.Pass,
  outcome: ImportOutcome.Empty,
  sessionsIncomplete: 0,
  sessionsPendingRevision: 0,
};
/** The production call site the harness-progress seam has to be wired at. */
const DASHBOARD_RUNTIME_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "main",
  "dashboard",
  "agent-dashboard-design-system-runtime.ts"
);
const INSTALL_IMPORT_HEALTH_TRACKING = "installImportHealthTracking";
const HARNESS_PROGRESS_OPTION = "reportHarnessProgress";
const MANAGER_REPORT_METHOD = "reportHarnessProgress";

/**
 * The two BACKFILL record kinds, as the emitted input union sees them.
 *
 * Named by kind rather than by "has a `harness`": ISS-8600 added three more
 * harness-scoped records that carry no `sourcesRemaining`, and this suite reads
 * that denominator off every record it selects.
 */
type BackfillHarnessInput = Extract<
  DesktopImportHealthEventInput,
  {
    kind:
      | typeof ImportHealthEvent.SourcesRemaining
      | typeof ImportHealthEvent.HarnessNotAdvancing;
  }
>;

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

test("a wedged backfill reaches the relay with its harness and its denominator", async () => {
  const { runtime, transport } = await startRelayRuntime(
    "install_import_stall_wedged"
  );
  const { tracker: ingest, clock } = createTracker();

  // The measured shape. `beginPass` is the only thing that happened: the source
  // scan found 2,465 codex rollouts and not one of them has finished importing.
  ingest.beginPass(Harness.Codex, WEDGED_SOURCE_COUNT);
  clock.advanceTo(clock.now() + STALL_WARN_MS);

  // Driven through `installImportHealthTracking` — the production wiring the
  // dashboard bootstrap uses — with the two blind inputs held at exactly what
  // the wedge produces: the importer is never called (the bounded import
  // abandons above this decorator) and NOTHING sits at the sentinel.
  const installed = installImportHealthTracking({
    emitImportHealth: (input) => runtime.emitImportHealthEvent(input),
    database: {
      importer: importerReturning(),
      listImportPendingSessionIds: () => Promise.resolve([]),
    },
    reportHarnessProgress: () => ingest.reportHarnessProgress(),
    log: () => undefined,
  });

  await installed.shutdown();
  await runtime.shutdown();
  activeRuntime = null;

  const records = decodeRelayImportRecords(transport);

  // The install-scoped record for the very same window says the store is idle.
  // This is the blindness ISS-6116 exists to cover, asserted rather than
  // asserted-about: `empty` and a zero sentinel, while 2,465 sources are stuck.
  const passRecord = records.find(
    (attributes) =>
      attributes[TelemetryAttribute.ImportEvent] === ImportHealthEvent.Pass
  );
  assert.equal(
    passRecord?.[TelemetryAttribute.ImportOutcome],
    ImportOutcome.Empty
  );
  assert.equal(
    passRecord?.[TelemetryAttribute.ImportSessionsPendingRevision],
    0
  );

  assert.deepEqual(
    harnessRecordsOf(records, ImportHealthEvent.SourcesRemaining),
    [{ harness: TelemetryHarnessName.Codex, remaining: WEDGED_SOURCE_COUNT }]
  );
  assert.deepEqual(
    harnessRecordsOf(records, ImportHealthEvent.HarnessNotAdvancing),
    [{ harness: TelemetryHarnessName.Codex, remaining: WEDGED_SOURCE_COUNT }]
  );

  // Counts and closed enums only — no session id, path, or free text rides
  // along. Anchored on the record found above, so a change that emitted nothing
  // at all cannot satisfy this by vacuous truth.
  const notAdvancing = records.find(
    (attributes) =>
      attributes[TelemetryAttribute.ImportEvent] ===
      ImportHealthEvent.HarnessNotAdvancing
  );
  assert.ok(notAdvancing);
  assert.deepEqual(
    Object.keys(notAdvancing).sort(),
    [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.HarnessName,
      TelemetryAttribute.ImportSourcesRemaining,
      TelemetryEmitMetadataKey.SchemaName,
    ].sort()
  );
});

test("the denominator ships on every settled window, including at zero", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const { tracker: ingest, clock } = createTracker();
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => ingest.reportHarnessProgress(),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  ingest.beginPass(Harness.Claude, 2);
  ingest.advance(Harness.Claude, 10, 20);
  await tracker.flushNow();

  // The pass finishes. The harness has nothing left to do — which is a DIFFERENT
  // state from "wedged" and from "stopped reporting", and only stays different
  // if the window keeps reporting an explicit zero rather than going quiet.
  ingest.advance(Harness.Claude, 20, 40);
  ingest.settlePass(Harness.Claude);
  clock.advanceTo(clock.now() + 10 * STALL_WARN_MS);
  await tracker.flushNow();
  tracker.dispose();

  assert.deepEqual(
    harnessInputsOf(emitted, ImportHealthEvent.SourcesRemaining),
    [
      {
        kind: ImportHealthEvent.SourcesRemaining,
        harness: TelemetryHarnessName.Claude,
        sourcesRemaining: 1,
      },
      {
        kind: ImportHealthEvent.SourcesRemaining,
        harness: TelemetryHarnessName.Claude,
        sourcesRemaining: 0,
      },
    ]
  );
  // A settled pass has no work to advance, so ten stall windows later it still
  // reports nothing wrong.
  assert.deepEqual(
    harnessInputsOf(emitted, ImportHealthEvent.HarnessNotAdvancing),
    []
  );
});

test("a pass that settled with work left behind does not report zero", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const { tracker: ingest } = createTracker();
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => ingest.reportHarnessProgress(),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // Five sources; two durably imported, one left retryable by a bounded parse
  // timeout, two never reached. `settlePass` then overwrites `processed` with
  // `total` to settle the FTUE bar to 100%, and the first-pass gate means this
  // boot will not come back for the three it dropped. Reading the settled
  // counters here would report a clean install for a boot that gave up.
  ingest.beginPass(Harness.Codex, 5);
  ingest.advance(Harness.Codex, 1, 1);
  ingest.advance(Harness.Codex, 1, 1);
  ingest.advance(Harness.Codex, 1, 1, false);
  ingest.settlePass(Harness.Codex);
  await tracker.flushNow();
  tracker.dispose();

  assert.deepEqual(
    harnessInputsOf(emitted, ImportHealthEvent.SourcesRemaining),
    [
      {
        kind: ImportHealthEvent.SourcesRemaining,
        harness: TelemetryHarnessName.Codex,
        sourcesRemaining: 3,
      },
    ]
  );
});

test("two wedged harnesses stay distinguishable on the wire", async () => {
  const { runtime, transport } = await startRelayRuntime(
    "install_import_stall_harnesses"
  );
  const { tracker: ingest, clock } = createTracker();

  // Codex is wedged at 0/2465; Claude is working through its own backlog and
  // completed a source just now. Two harnesses, two different denominators, and
  // only one of them is in trouble.
  ingest.beginPass(Harness.Codex, WEDGED_SOURCE_COUNT);
  ingest.beginPass(Harness.Claude, 100);
  clock.advanceTo(clock.now() + STALL_WARN_MS);
  ingest.advance(Harness.Claude, 5, 5);

  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => runtime.emitImportHealthEvent(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => ingest.reportHarnessProgress(),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  await tracker.flushNow();
  tracker.dispose();
  await runtime.shutdown();
  activeRuntime = null;

  const records = decodeRelayImportRecords(transport);
  assert.deepEqual(
    harnessRecordsOf(records, ImportHealthEvent.SourcesRemaining).sort(
      byHarness
    ),
    [
      { harness: TelemetryHarnessName.Claude, remaining: 99 },
      { harness: TelemetryHarnessName.Codex, remaining: WEDGED_SOURCE_COUNT },
    ]
  );
  // Both harnesses reported a denominator; only the wedged one reported a
  // breach, and it is labelled as itself rather than as "a harness".
  assert.deepEqual(
    harnessRecordsOf(records, ImportHealthEvent.HarnessNotAdvancing),
    [{ harness: TelemetryHarnessName.Codex, remaining: WEDGED_SOURCE_COUNT }]
  );
});

test("no-progress-for-a-reason never fires a not-advancing record", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const { tracker: ingest, clock } = createTracker();
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => ingest.reportHarnessProgress(),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // A fresh install's very first pass: the scan just handed over a large
  // population and nothing has completed yet, because nothing has HAD time to.
  ingest.beginPass(Harness.Codex, WEDGED_SOURCE_COUNT);
  await tracker.flushNow();

  // Parked at the user's backfill pause, or returned early to service a
  // live-watcher event. Not advancing, on purpose, for as long as it takes.
  ingest.noteSuspended(Harness.Codex);
  clock.advanceTo(clock.now() + 10 * STALL_WARN_MS);
  await tracker.flushNow();

  // The pass ends. Whatever it left behind, it is no longer a running pass that
  // could advance.
  ingest.noteResumed(Harness.Codex);
  ingest.settlePass(Harness.Codex);
  clock.advanceTo(clock.now() + 20 * STALL_WARN_MS);
  await tracker.flushNow();
  tracker.dispose();

  assert.deepEqual(
    harnessInputsOf(emitted, ImportHealthEvent.HarnessNotAdvancing),
    []
  );
  // Positive control: the gauge reported all three windows, so the absence
  // above is the gate working and not the seam being unwired.
  assert.equal(
    harnessInputsOf(emitted, ImportHealthEvent.SourcesRemaining).length,
    3
  );
});

test("a harness whose scan found nothing is absent, not reported at zero", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const { tracker: ingest, clock } = createTracker();
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => ingest.reportHarnessProgress(),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // `scanImportPass` only calls `beginPass` when the scan found pending
  // sources, so a harness the user does not use never enters the tracker. It
  // must not manufacture a `0` for it — that would be a claim about a
  // population nobody measured.
  ingest.beginPass(Harness.Codex, 1);
  clock.advanceTo(clock.now() + 10 * STALL_WARN_MS);
  await tracker.flushNow();
  tracker.dispose();

  assert.deepEqual(
    harnessInputsOf(emitted, ImportHealthEvent.SourcesRemaining).map(
      (input) => input.harness
    ),
    [TelemetryHarnessName.Codex]
  );
});

test("an unknown collector key is dropped rather than widening the label set", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const lines: string[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => [
      { harness: "gemini", remaining: 7, notAdvancing: true },
      { harness: Harness.Cursor, remaining: 3, notAdvancing: true },
    ],
    log: (message) => lines.push(message),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  await tracker.flushNow();
  tracker.dispose();

  assert.deepEqual(
    harnessInputsIn(emitted).map((input) => input.harness),
    [TelemetryHarnessName.Cursor, TelemetryHarnessName.Cursor]
  );
  assert.ok(lines.some((line) => line.includes("gemini")));
});

test("a throwing report seam cannot silence the pass record", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const lines: string[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => {
      throw new Error("collector manager is being torn down");
    },
    log: (message) => lines.push(message),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // Best-effort per the desktop exporter-boundary rule: the report seam may not
  // reject out of the tick, and may not take down the install-scoped record,
  // whose ARRIVAL is what tells the server this process is still reporting.
  await tracker.flushNow();
  tracker.dispose();

  assert.deepEqual(emitted, [PASS_RECORD_FOR_AN_EMPTY_WINDOW]);
  assert.ok(lines.some((line) => line.includes("harness progress report")));
});

test("a gauge that fails to dispatch cannot take the breach record with it", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const lines: string[] = [];
  const tracker = createImportHealthTracker({
    // The relay refuses the gauge and accepts everything else. One shared
    // `try` around the pair would drop the breach — the record an alert reads —
    // whenever the merely-informational one failed.
    emitImportHealth: (input) => {
      if (input.kind === ImportHealthEvent.SourcesRemaining) {
        throw new Error("relay refused the gauge");
      }
      emitted.push(input);
    },
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => [
      {
        harness: Harness.Codex,
        remaining: WEDGED_SOURCE_COUNT,
        notAdvancing: true,
      },
    ],
    log: (message) => lines.push(message),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  await tracker.flushNow();
  tracker.dispose();

  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.HarnessNotAdvancing,
      harness: TelemetryHarnessName.Codex,
      sourcesRemaining: WEDGED_SOURCE_COUNT,
    },
    PASS_RECORD_FOR_AN_EMPTY_WINDOW,
  ]);
  assert.ok(lines.some((line) => line.includes("harness progress emit")));
});

test("an abandoned pass keeps reporting the remainder it left behind", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const { tracker: ingest } = createTracker();
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => ingest.reportHarnessProgress(),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // The db host killed the pass (ISS-5808). `abandonPass` DELETES the progress
  // entry, so a report built from that map alone would drop the harness — and
  // absence is defined as "no tracked pass", which reads as a healthy machine
  // that simply does not use codex. The preserved shortfall is what it has.
  ingest.beginPass(Harness.Codex, WEDGED_SOURCE_COUNT);
  ingest.advance(Harness.Codex, 1, 1);
  ingest.abandonPass(Harness.Codex, "db host exited");
  await tracker.flushNow();
  tracker.dispose();

  assert.deepEqual(
    harnessInputsOf(emitted, ImportHealthEvent.SourcesRemaining),
    [
      {
        kind: ImportHealthEvent.SourcesRemaining,
        harness: TelemetryHarnessName.Codex,
        sourcesRemaining: WEDGED_SOURCE_COUNT - 1,
      },
    ]
  );
});

test("a frozen source scan reports the breach with no fabricated denominator", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const { tracker: ingest, clock } = createTracker();
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => ingest.reportHarnessProgress(),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // `listSources`/`collectPendingSources` run BEFORE the first `beginPass`
  // (ISS-4917), so a freeze there has no progress entry and no denominator at
  // all. It is still a wedge with no session rows and no sentinel entries, so
  // the breach ships — carrying no `sourcesRemaining`, because nobody has
  // counted the population. Omitted, never zeroed.
  ingest.markPreparing(Harness.Cursor);
  clock.advanceTo(clock.now() + STALL_WARN_MS);
  await tracker.flushNow();
  tracker.dispose();

  assert.deepEqual(harnessInputsIn(emitted), [
    {
      kind: ImportHealthEvent.HarnessNotAdvancing,
      harness: TelemetryHarnessName.Cursor,
    },
  ]);
});

test("every harness-scoped record ships under its own log-record name", () => {
  // All five kinds the name map routes, not the two this suite was born with:
  // ISS-8600 turned a two-armed ternary into a `Record` over the kind union, so
  // `tsc` now catches a MISSING name while a name pointing at the wrong record
  // -- a copy-paste between two adjacent entries -- still compiles. That is what
  // the per-kind equalities below and the distinctness check underneath catch.
  const namesByKind = [
    [
      buildImportHealthRecord({
        kind: ImportHealthEvent.SourcesRemaining,
        harness: TelemetryHarnessName.Codex,
        sourcesRemaining: 0,
      }).name,
      IMPORT_SOURCES_REMAINING_EVENT_NAME,
    ],
    [
      buildImportHealthRecord({
        kind: ImportHealthEvent.HarnessNotAdvancing,
        harness: TelemetryHarnessName.Codex,
        sourcesRemaining: WEDGED_SOURCE_COUNT,
      }).name,
      IMPORT_HARNESS_NOT_ADVANCING_EVENT_NAME,
    ],
    [
      buildImportHealthRecord({
        kind: ImportHealthEvent.WatchLost,
        harness: TelemetryHarnessName.Copilot,
      }).name,
      IMPORT_WATCH_LOST_EVENT_NAME,
    ],
    [
      buildImportHealthRecord({
        kind: ImportHealthEvent.MaterializeFailed,
        harness: TelemetryHarnessName.OpenCode,
      }).name,
      IMPORT_MATERIALIZE_FAILED_EVENT_NAME,
    ],
    [
      buildImportHealthRecord({
        kind: ImportHealthEvent.MaterializeTimedOut,
        harness: TelemetryHarnessName.OpenCode,
      }).name,
      IMPORT_MATERIALIZE_TIMED_OUT_EVENT_NAME,
    ],
  ];

  for (const [built, expected] of namesByKind) {
    assert.equal(built, expected);
  }

  // A Datadog query names ONE record, so two kinds sharing a name silently
  // merges two populations into whichever monitor asked first.
  const built = namesByKind.map(([name]) => name);
  assert.equal(
    new Set(built).size,
    built.length,
    "two harness-scoped kinds must not ship under one record name"
  );
});

test("the dashboard runtime hands the tracker a harness-progress seam", () => {
  // The seam is optional, so an unwired production call site would leave every
  // behavioral test above green while the fleet reported nothing. There is no
  // way to drive this call site in-process (it builds the whole Electron
  // dashboard runtime), so the wiring is pinned structurally, on the resolved
  // AST rather than on the source text.
  const source = parseTypeScriptFile(DASHBOARD_RUNTIME_PATH);

  // The seam reads the manager off a holder rather than closing over the
  // `const` (which the tracker's already-armed interval could reach inside its
  // temporal dead zone), so BOTH halves are pinned: passing the option and
  // filling the holder. Asserting only the first leaves a seam that returns an
  // empty report forever, which the fleet cannot tell from an idle machine.
  const holder = harnessProgressHolderName(source);
  assert.ok(holder);
  assert.equal(assignsIdentifier(source, holder), true);
});

test("the collector harness keys and the telemetry label set are one set", () => {
  // The emit site maps collector keys onto the contract's closed `harness.name`
  // set and DROPS anything unmapped, so a sixth collector added without teaching
  // the contract would go silent exactly when it wedged. This is the guard that
  // makes that unreachable rather than merely unlikely; the contract cannot
  // import `@repo/lib` (it publishes standalone), so equality is asserted here.
  assert.deepEqual(
    Object.values(Harness).slice().sort(),
    Object.values(TelemetryHarnessName).slice().sort()
  );
});

test("a wedged harness keeps reporting across a collector stop/start", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const { tracker: ingest, clock } = createTracker();

  // Boot 1: the pass ends having landed nothing, so `settlePass` preserves the
  // full shortfall as the record of it.
  ingest.beginPass(Harness.Codex, WEDGED_SOURCE_COUNT);
  ingest.settlePass(Harness.Codex);

  // The collector restarts in-process. `resetForStop` clears the ledger; the
  // first-pass gate is what decides whether the NEXT pass is tracked at all.
  ingest.resetForStop();
  assert.equal(
    ingest.isFirstPassPending(Harness.Codex),
    true,
    "a harness that never landed its sources must be re-armed for tracking"
  );

  // Boot 2 re-drives the same wedge: the retry begins and then advances nothing
  // for a full no-progress window.
  ingest.beginPass(Harness.Codex, WEDGED_SOURCE_COUNT);
  clock.advanceTo(clock.now() + STALL_WARN_MS);

  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => ingest.reportHarnessProgress(),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  await tracker.flushNow();
  tracker.dispose();

  // Both counters resume. Before ISS-6116's review fix the gate survived the
  // restart, `trackProgress` stayed false, and this window emitted neither.
  assert.deepEqual(
    harnessInputsOf(emitted, ImportHealthEvent.SourcesRemaining).map(
      (input) => [input.harness, input.sourcesRemaining] as const
    ),
    [[TelemetryHarnessName.Codex, WEDGED_SOURCE_COUNT]]
  );
  assert.deepEqual(
    harnessInputsOf(emitted, ImportHealthEvent.HarnessNotAdvancing).map(
      (input) => input.harness
    ),
    [TelemetryHarnessName.Codex]
  );
});

test("a harness that finished cleanly stays gated across the same restart", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const { tracker: ingest, clock } = createTracker();

  // The negative control for the test above, and the behaviour `resetForStop`
  // has always existed to protect: an already-imported machine must not re-arm,
  // or a routine catch-up surfaces as a false "Importing your history" pass.
  ingest.beginPass(Harness.Claude, 2);
  ingest.advance(Harness.Claude, 0, 0);
  ingest.advance(Harness.Claude, 0, 0);
  ingest.settlePass(Harness.Claude);

  ingest.resetForStop();
  assert.equal(ingest.isFirstPassPending(Harness.Claude), false);

  clock.advanceTo(clock.now() + 10 * STALL_WARN_MS);
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    reportHarnessProgress: () => ingest.reportHarnessProgress(),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  await tracker.flushNow();
  tracker.dispose();

  // Nothing outstanding, so nothing to report — a zero here would be a stall
  // claim about a harness that finished.
  assert.deepEqual(harnessInputsIn(emitted), []);
});

async function startRelayRuntime(
  installationId: string
): Promise<{ runtime: DesktopOtelRuntime; transport: StubTransport }> {
  const started = await startRelayRuntimeFixture(installationId);
  activeRuntime = started.runtime;
  return started;
}

/** The decoded harness records of one kind, reduced to what a monitor reads. */
function harnessRecordsOf(
  records: Record<string, unknown>[],
  kind: BackfillHarnessInput["kind"]
): { harness: unknown; remaining: unknown }[] {
  return records
    .filter((attributes) => attributes[TelemetryAttribute.ImportEvent] === kind)
    .map((attributes) => ({
      harness: attributes[TelemetryAttribute.HarnessName],
      remaining: attributes[TelemetryAttribute.ImportSourcesRemaining],
    }));
}

/** Every backfill emit input, narrowed off the discriminated union. */
function harnessInputsIn(
  emitted: DesktopImportHealthEventInput[]
): BackfillHarnessInput[] {
  return emitted.filter(isBackfillHarnessInput);
}

/** The backfill emit inputs of one kind. */
function harnessInputsOf(
  emitted: DesktopImportHealthEventInput[],
  kind: BackfillHarnessInput["kind"]
): BackfillHarnessInput[] {
  return harnessInputsIn(emitted).filter((input) => input.kind === kind);
}

function isBackfillHarnessInput(
  input: DesktopImportHealthEventInput
): input is BackfillHarnessInput {
  return (
    input.kind === ImportHealthEvent.SourcesRemaining ||
    input.kind === ImportHealthEvent.HarnessNotAdvancing
  );
}

function byHarness(
  left: { harness: unknown },
  right: { harness: unknown }
): number {
  return String(left.harness).localeCompare(String(right.harness));
}

function isInstallImportHealthTrackingCall(
  node: ts.Node
): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === INSTALL_IMPORT_HEALTH_TRACKING
  );
}

/** The local the wiring reads `reportHarnessProgress()` off, if there is one. */
function harnessProgressHolderName(source: ts.SourceFile): string | undefined {
  let holder: string | undefined;
  forEachNode(source, (node) => {
    if (!isInstallImportHealthTrackingCall(node)) {
      return;
    }
    const [argument] = node.arguments;
    if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
      return;
    }
    for (const property of argument.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === HARNESS_PROGRESS_OPTION
      ) {
        holder = reportMethodReceiver(property.initializer) ?? holder;
      }
    }
  });
  return holder;
}

/** The identifier `<x>.reportHarnessProgress()` is called on inside `node`. */
function reportMethodReceiver(node: ts.Node): string | undefined {
  let receiver: string | undefined;
  forEachNode(node, (inner) => {
    if (
      ts.isPropertyAccessExpression(inner) &&
      inner.name.text === MANAGER_REPORT_METHOD &&
      ts.isIdentifier(inner.expression)
    ) {
      receiver = inner.expression.text;
    }
  });
  return receiver;
}

/** Whether the module assigns another binding into `name` somewhere. */
function assignsIdentifier(source: ts.SourceFile, name: string): boolean {
  let assigned = false;
  forEachNode(source, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      ts.isIdentifier(node.right)
    ) {
      assigned = true;
    }
  });
  return assigned;
}
