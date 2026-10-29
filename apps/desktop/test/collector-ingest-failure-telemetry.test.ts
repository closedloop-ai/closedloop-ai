/**
 * @file collector-ingest-failure-telemetry.test.ts
 * @description ISS-6336 (PRD-650) acceptance for the collector ingest-failure
 * counters.
 *
 * `src/main/collectors/**` imported zero telemetry emitters, so three failures
 * the collectors already compute were thrown away: a source whose parse threw, a
 * source the pending scan skipped as quarantined, and the `parseQuality` counts
 * the parsers persist on every session. A customer whose transcripts stopped
 * parsing after a harness update was indistinguishable from a customer with no
 * sessions.
 *
 * The first test here is the one that matters. A fixture-driven assertion that
 * "the counter is 1 on the event object" is exactly the vacuous test this issue
 * predicts, because the scenario the counters exist for — a source whose parse
 * threw — produces NO session row, so `sessionsIncomplete` and
 * `sessionsPendingRevision` both read zero and ISS-5103's suppression discarded
 * the whole record. ISS-6335 removed that suppression; this suite drives the
 * production path end to end, from the collector's own parse step to the bytes
 * that crossed the relay transport, in exactly that all-zero window.
 *
 * The quarantine half is pinned beside the code that skips the source, in
 * `collect-pending-sources-quarantine.test.ts`.
 */
import assert from "node:assert/strict";
import {
  ImportHealthEvent,
  ImportIngestFailure,
  ImportOutcome,
  ImportParseDegradedSite,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import { afterEach, test } from "vitest";
import { parseDegradedSite } from "../src/main/collectors/engine/collector-ingest-failure.js";
import {
  type PassParseOptions,
  parseSourceForPass,
} from "../src/main/collectors/engine/collector-manager-source-parse.js";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";
import { clampSessionsForWorkerResponse } from "../src/main/collectors/engine/historical-parse-worker-response-budget.js";
import type {
  HarnessCollector,
  NormalizedSession,
} from "../src/main/collectors/types.js";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
import type { DesktopImportHealthEventInput } from "../src/main/telemetry/app-otel-runtime-import-health.js";
import {
  createImportHealthTracker,
  installImportHealthTracking,
} from "../src/main/telemetry/import-health-telemetry.js";
import { SourceTimeoutStage } from "../src/shared/ingest-quarantine-contract.js";
import {
  decodeRelayImportRecords,
  HARNESS,
  importerReturning,
  NO_AUTOMATIC_TICK_MS,
  type StubTransport,
  startRelayRuntime,
} from "./helpers/import-health-fixtures.js";
import { makeSession as makeNormalizedSession } from "./normalized-session-test-utils.js";

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

const COLLECTOR = {
  key: "claude",
  cacheName: "claude",
  batch: false,
  listSources: () => [],
  parse: () => Promise.resolve([]),
} as unknown as HarnessCollector;

/** The parse-step options every case here shares; only the parse itself differs. */
function parseOptions(overrides: Partial<PassParseOptions>): PassParseOptions {
  return {
    parseSource: () => Promise.resolve([]),
    collector: COLLECTOR,
    source: "/tmp/iss-6336-transcript.jsonl",
    stat: null,
    extraMtime: null,
    cache: undefined,
    quarantine: undefined,
    lowDutyImport: false,
    parseTimeoutMs: null,
    isImportActive: () => true,
    abortInFlightParse: () => undefined,
    log: () => undefined,
    ...overrides,
  };
}

/** A session carrying `quality`, plus whatever identifying fields a case needs. */
function sessionWith(
  quality: NormalizedParseQuality | undefined,
  identity: Partial<NormalizedSession> = {}
): NormalizedSession {
  return {
    sessionId: "session-1",
    ...identity,
    ...(quality ? { parseQuality: quality } : {}),
  } as unknown as NormalizedSession;
}

/** Every byte the runtime actually shipped, as one searchable string. */
function shippedBytesAsText(transport: StubTransport): string {
  return transport.shipments
    .map((shipment) => Buffer.from(shipment.body).toString("latin1"))
    .join("");
}

/** The `[reason, count]` pairs of every ingest-failure record, sorted. */
function ingestFailurePairs(
  emitted: readonly DesktopImportHealthEventInput[]
): [string, number][] {
  const pairs: [string, number][] = [];
  for (const input of emitted) {
    if (input.kind === ImportHealthEvent.IngestFailed) {
      pairs.push([input.reason, input.count]);
    }
  }
  return pairs.sort();
}

test("a source whose parse throws reaches the relay in a zero-session window", async () => {
  const { runtime, transport } = await startRelayRuntime(
    "install_iss6336_parse_threw"
  );
  activeRuntime = runtime;

  // The production wiring the dashboard bootstrap uses, not the tracker factory.
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

  // The collector's own parse step, with a parser that throws — the acceptance
  // fixture. Nothing reaches `importSession`, so no session row exists and
  // nothing parks at the sentinel: `sessionsIncomplete` and
  // `sessionsPendingRevision` are both structurally zero for this window.
  const parsed = await parseSourceForPass(
    parseOptions({
      parseSource: () => Promise.reject(new Error("unparseable transcript")),
      onIngestFailure: installed.noteIngestFailure,
    })
  );

  await installed.shutdown();
  await runtime.shutdown();
  activeRuntime = null;

  // Positive controls: the parse really failed the way the fixture claims, and
  // the tick really ran as far as the sentinel read.
  assert.equal(parsed.outcome.kind, "threw");
  assert.equal(sampleCalls, 1);

  const records = decodeRelayImportRecords(transport);
  const pass = records.find(
    (record) =>
      record[TelemetryAttribute.ImportEvent] === ImportHealthEvent.Pass
  );
  const ingestFailed = records.find(
    (record) =>
      record[TelemetryAttribute.ImportEvent] === ImportHealthEvent.IngestFailed
  );

  // The window really is the all-zero one whose record ISS-5103 suppressed. If
  // the suppression were reintroduced, `pass` would be undefined and
  // `ingestFailed` — which rides the same tick and the same emit seam — would
  // never be built either.
  assert.equal(pass?.[TelemetryAttribute.ImportOutcome], ImportOutcome.Empty);
  assert.equal(pass?.[TelemetryAttribute.ImportSessionsIncomplete], 0);
  assert.equal(pass?.[TelemetryAttribute.ImportSessionsPendingRevision], 0);
  // ...and the counter left the machine.
  assert.equal(
    ingestFailed?.[TelemetryAttribute.ImportIngestFailure],
    ImportIngestFailure.SourceParseThrew
  );
  assert.equal(ingestFailed?.[TelemetryAttribute.ImportIngestFailedCount], 1);
});

test("the quarantine gauge reaches the relay as an explicit zero", async () => {
  const { runtime, transport } = await startRelayRuntime(
    "install_iss6336_gauge_zero"
  );
  activeRuntime = runtime;

  // Nothing is quarantined. A gauge that only appears when non-zero cannot tell
  // "this install has no poison transcripts" from "this install stopped
  // reporting" — the exact ambiguity ISS-6335 just removed from this record, and
  // re-introducing it one attribute over would be the same defect in a new hat.
  let gaugeReads = 0;
  const installed = installImportHealthTracking({
    emitImportHealth: (input) => runtime.emitImportHealthEvent(input),
    database: {
      importer: importerReturning(),
      listImportPendingSessionIds: () => Promise.resolve([]),
    },
    readQuarantinedCounts: () => {
      gaugeReads++;
      return { [SourceTimeoutStage.Parse]: 0, [SourceTimeoutStage.Import]: 0 };
    },
    log: () => undefined,
  });

  await installed.shutdown();
  await runtime.shutdown();
  activeRuntime = null;

  // Positive control: the gauge was actually read, so a missing attribute below
  // would mean the value was dropped rather than never sampled.
  assert.equal(gaugeReads, 1);

  const records = decodeRelayImportRecords(transport);
  const pass = records.find(
    (record) =>
      record[TelemetryAttribute.ImportEvent] === ImportHealthEvent.Pass
  );

  // ANCHOR: a known-present field asserted in the same breath, so the zero
  // assertions cannot be satisfied by a run that emitted nothing at all.
  assert.equal(pass?.[TelemetryAttribute.ImportOutcome], ImportOutcome.Empty);
  // Explicit zeros ON THE WIRE — `0`, not `undefined`.
  assert.equal(pass?.[TelemetryAttribute.ImportSourcesQuarantinedParse], 0);
  assert.equal(pass?.[TelemetryAttribute.ImportSourcesQuarantinedImport], 0);
  assert.ok(
    TelemetryAttribute.ImportSourcesQuarantinedParse in (pass ?? {}),
    "the parse gauge must be PRESENT at zero, not omitted"
  );
  assert.ok(
    TelemetryAttribute.ImportSourcesQuarantinedImport in (pass ?? {}),
    "the import gauge must be PRESENT at zero, not omitted"
  );
});

test("the quarantine gauge reports the level per stage, not an occurrence count", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  let level = { [SourceTimeoutStage.Parse]: 2, [SourceTimeoutStage.Import]: 1 };
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    readQuarantinedCounts: () => level,
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // A standing level, not a tally: three ticks over an unchanged store report
  // the SAME number three times. An occurrence counter would report 2/1 once and
  // then 0/0 forever, or accumulate — neither of which answers "how many sources
  // are quarantined right now".
  await tracker.flushNow();
  await tracker.flushNow();
  // ...and it tracks the store DOWN as well as up, which is the property a
  // monotonic occurrence count cannot have: clearing a quarantine is recovery.
  level = { [SourceTimeoutStage.Parse]: 0, [SourceTimeoutStage.Import]: 1 };
  await tracker.flushNow();

  assert.deepEqual(
    emitted.map((input) =>
      input.kind === ImportHealthEvent.Pass ? input.quarantinedByStage : null
    ),
    [
      { parse: 2, import: 1 },
      { parse: 2, import: 1 },
      { parse: 0, import: 1 },
    ]
  );
  tracker.dispose();
});

test("a window that could not be summarized omits the gauge rather than zeroing it", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () =>
      Promise.reject(new Error("db host is gone")),
    readQuarantinedCounts: () => ({
      [SourceTimeoutStage.Parse]: 4,
      [SourceTimeoutStage.Import]: 0,
    }),
    log: () => undefined,
    tickMs: NO_AUTOMATIC_TICK_MS,
  });

  // Zero is a positive claim on this attribute, so the one window where it must
  // NOT appear is the one that says it could not measure anything. Shipping
  // `0` here would report a clean install off a read that never completed.
  await assert.doesNotReject(() => tracker.flushNow());

  assert.deepEqual(emitted, [
    {
      kind: ImportHealthEvent.Pass,
      outcome: ImportOutcome.Error,
      sessionsIncomplete: 0,
    },
  ]);
  tracker.dispose();
});

test("a parse that times out is counted; one a restart superseded is not", async () => {
  const neverSettles = (_source: string, onDispatch: () => void) => {
    onDispatch();
    return new Promise<NormalizedSession[]>(() => undefined);
  };
  const boundedRun = async (
    isImportActive: () => boolean
  ): Promise<{ kind: string; reasons: string[] }> => {
    const reasons: string[] = [];
    const parsed = await parseSourceForPass(
      parseOptions({
        parseSource: neverSettles,
        lowDutyImport: true,
        parseTimeoutMs: 1,
        isImportActive,
        onIngestFailure: (reason) => reasons.push(reason),
      })
    );
    return { kind: parsed.outcome.kind, reasons };
  };

  const timedOut = await boundedRun(() => true);
  assert.equal(timedOut.kind, "timedOut");
  assert.deepEqual(timedOut.reasons, [ImportIngestFailure.SourceParseTimedOut]);

  // The same elapsed bound, but a stop()/restart superseded this generation
  // while the parse was in flight. That is a restart racing the pass, not a
  // source that failed to parse, and counting it would report ingest failures
  // every time the user toggles a collector off.
  const superseded = await boundedRun(() => false);
  assert.equal(superseded.kind, "superseded");
  assert.deepEqual(superseded.reasons, []);
});

test("parseQuality buckets each session exactly once, and a clean parse not at all", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const wrapped = tracker.wrapImporter(importerReturning());

  // Clean, and the benign shape of a live write: the final line is mid-flush, so
  // it is discounted exactly as `NormalizedParseQuality` documents. Counting it
  // would report a degraded parse on every session the user is working in.
  await wrapped.importSession(sessionWith(undefined), HARNESS);
  await wrapped.importSession(
    sessionWith({
      totalLines: 10,
      malformedLines: 0,
      truncatedFinalLine: false,
    }),
    HARNESS
  );
  await wrapped.importSession(
    sessionWith({
      totalLines: 10,
      malformedLines: 1,
      truncatedFinalLine: true,
    }),
    HARNESS
  );
  // Some lines lost, then every line lost, then a session whose lines parsed as
  // JSON but carried no envelope the parser recognizes — the shape a harness
  // format change takes.
  await wrapped.importSession(
    sessionWith(
      { totalLines: 10, malformedLines: 3, truncatedFinalLine: false },
      { sessionId: "partly-degraded" }
    ),
    HARNESS
  );
  await wrapped.importSession(
    sessionWith(
      { totalLines: 4, malformedLines: 4, truncatedFinalLine: false },
      { sessionId: "all-lines-lost" }
    ),
    HARNESS
  );
  // Every line lost AND the last one is the benign trailing truncation. The
  // discount has to apply to both sides of the split: measuring a discounted
  // numerator against an undiscounted `totalLines` reported "some lines lost"
  // for a transcript where nothing was read at all — the total-failure case
  // misclassified as partial, which is the collapse this ticket exists to end.
  await wrapped.importSession(
    sessionWith(
      { totalLines: 3, malformedLines: 3, truncatedFinalLine: true },
      { sessionId: "fully-unreadable" }
    ),
    HARNESS
  );
  // ISS-6336 (whitlockk review): the SAME total failure, spread over a parent and
  // two folded children that were each mid-write. Six lines across three files,
  // every one of them malformed. The fold discounted both CHILD truncations out
  // of `malformedLines` (3 corrupt + the parent's own trailing line = 4) and
  // left their two lines in `totalLines`, so measuring against `totalLines`
  // minus the parent's single flag left a denominator of 5 against a numerator
  // of 3 and reported "some lines lost" for a session where nothing survived.
  // Discounting all three truncations puts both sides at 3.
  await wrapped.importSession(
    sessionWith(
      {
        totalLines: 6,
        malformedLines: 4,
        truncatedFinalLine: true,
        childTruncatedFinalLines: 2,
      },
      { sessionId: "fully-unreadable-across-files" }
    ),
    HARNESS
  );
  await wrapped.importSession(
    sessionWith(
      {
        totalLines: 10,
        malformedLines: 0,
        truncatedFinalLine: false,
        unknownRecords: 7,
      },
      { sessionId: "unrouted-records" }
    ),
    HARNESS
  );
  await tracker.flushNow();

  // Once each. `unreadable` is not a louder `degraded`: the two are mutually
  // exclusive, so a session that lost everything is not also counted as a
  // session that lost something. The three clean sessions above contribute
  // nothing, which is what keeps the counter readable on a healthy install.
  assert.deepEqual(
    ingestFailurePairs(emitted),
    (
      [
        [ImportIngestFailure.SessionParseDegraded, 1],
        [ImportIngestFailure.SessionParseUnreadable, 3],
        [ImportIngestFailure.SessionRecordsUnrouted, 1],
      ] as [string, number][]
    ).sort()
  );
  tracker.dispose();
});

test("a standing parse defect counts once per window, not once per import", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const wrapped = tracker.wrapImporter(importerReturning());
  const degraded = (sessionId: string): NormalizedSession =>
    sessionWith(
      { totalLines: 10, malformedLines: 3, truncatedFinalLine: false },
      { sessionId }
    );

  // A live session the user is working in is re-parsed and re-imported on every
  // watcher write. Counting per import makes the metric track import FREQUENCY
  // rather than failure incidence, so one bad transcript in an active workspace
  // outweighs many bad transcripts in a quiet one.
  await wrapped.importSession(degraded("live-session"), HARNESS);
  await wrapped.importSession(degraded("live-session"), HARNESS);
  await wrapped.importSession(degraded("live-session"), HARNESS);
  // Positive control: a DIFFERENT degraded session still counts, so the dedupe
  // is keyed on identity and is not simply capping the window at one.
  await wrapped.importSession(degraded("other-session"), HARNESS);
  await tracker.flushNow();

  assert.deepEqual(ingestFailurePairs(emitted), [
    [ImportIngestFailure.SessionParseDegraded, 2],
  ]);

  // The dedupe is per WINDOW, not for the life of the process: a defect that is
  // still there next window is still worth reporting next window.
  await wrapped.importSession(degraded("live-session"), HARNESS);
  await tracker.flushNow();
  assert.deepEqual(ingestFailurePairs(emitted.slice(1)), [
    [ImportIngestFailure.SessionParseDegraded, 1],
  ]);
  tracker.dispose();
});

test("ISS-5822: a worker-clamped session is counted, and an intact one is not", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const wrapped = tracker.wrapImporter(importerReturning());

  // Both sessions come out of the REAL clamp rather than being hand-stamped, so
  // this asserts the production wiring: if `clampSessionsForWorkerResponse`
  // stops stamping the flag, or the field is renamed on one side only, this goes
  // red here instead of counting nothing in the field forever.
  const { sessions } = clampSessionsForWorkerResponse([
    {
      ...makeNormalizedSession({ sessionId: "clamped" }),
      teams: new Array(
        HistoricalParseWorkerLimits.maxSessionArrayItems + 1
      ).fill("team"),
    },
    makeNormalizedSession({ sessionId: "intact" }),
  ]);
  const [clamped, intact] = sessions;
  assert.equal(
    clamped.payloadClamped,
    true,
    "fixture guard: the clamp must actually have fired for this to mean anything"
  );

  await wrapped.importSession(intact, HARNESS);
  await wrapped.importSession(clamped, HARNESS);
  await tracker.flushNow();

  // The paired negative is what makes the positive mean something: a counter
  // that incremented on every offered session, or before the flag was checked,
  // would report 2 here.
  assert.deepEqual(ingestFailurePairs(emitted), [
    [ImportIngestFailure.SessionPayloadClamped, 1],
  ]);
  tracker.dispose();
});

test("ISS-5822: a clamp and a parse defect on one session count once each", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const wrapped = tracker.wrapImporter(importerReturning());

  // The two degradations are independent — the parser lost lines AND the worker
  // boundary then cut the payload — so neither may mask the other. The
  // per-session dedupe set is keyed on session id alone, so a naive guard that
  // returns after the first reason would silently drop the clamp here.
  await wrapped.importSession(
    {
      ...sessionWith(
        { totalLines: 10, malformedLines: 3, truncatedFinalLine: false },
        { sessionId: "degraded-and-clamped" }
      ),
      payloadClamped: true,
    },
    HARNESS
  );
  await tracker.flushNow();

  assert.deepEqual(
    ingestFailurePairs(emitted),
    (
      [
        [ImportIngestFailure.SessionParseDegraded, 1],
        [ImportIngestFailure.SessionPayloadClamped, 1],
      ] as [string, number][]
    ).sort()
  );
  tracker.dispose();
});

test("ISS-5822: a session that gains a SECOND degradation mid-window counts both", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const wrapped = tracker.wrapImporter(importerReturning());
  const offer = (payloadClamped: boolean): NormalizedSession => ({
    ...sessionWith(
      { totalLines: 10, malformedLines: 3, truncatedFinalLine: false },
      { sessionId: "live-session" }
    ),
    ...(payloadClamped ? { payloadClamped: true } : {}),
  });

  // The live-import scenario the clamp counter exists for. One session is
  // re-parsed and re-offered on every watcher write, and its degradations are
  // INDEPENDENT and can arrive at different offers: the transcript is
  // parse-degraded from the first line it lost, and only later grows past the
  // worker response budget and starts coming back clamped. Deduping per SESSION
  // records whichever reason arrived first and suppresses the other forever, so
  // `session_payload_clamped` reads empty for exactly the population it was
  // added to make visible. Dedupe is per `(session, reason)`.
  await wrapped.importSession(offer(false), HARNESS);
  await wrapped.importSession(offer(false), HARNESS);
  await wrapped.importSession(offer(true), HARNESS);
  await wrapped.importSession(offer(true), HARNESS);
  await tracker.flushNow();

  // ONE assertion carries both directions, which is why it is a whole-list
  // compare rather than two lookups. Dedupe per session drops the clamp pair
  // entirely; dropping the dedupe instead inflates `degraded` to 4 and `clamped`
  // to 2. Only per-`(session, reason)` produces exactly this.
  assert.deepEqual(
    ingestFailurePairs(emitted),
    (
      [
        [ImportIngestFailure.SessionParseDegraded, 1],
        [ImportIngestFailure.SessionPayloadClamped, 1],
      ] as [string, number][]
    ).sort()
  );
  tracker.dispose();
});

test("ISS-5822: per-reason dedupe still clears on the window boundary", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const wrapped = tracker.wrapImporter(importerReturning());
  const clamped: NormalizedSession = {
    ...sessionWith(undefined, { sessionId: "standing-clamp" }),
    payloadClamped: true,
  };

  // Widening the dedupe key must not widen its LIFETIME. The set is cleared on
  // every tick so a degradation still present next window is still reported
  // next window — a per-reason key that outlived the tick would turn a standing
  // clamp into a one-time blip and leave the monitor silent while it persists.
  await wrapped.importSession(clamped, HARNESS);
  await wrapped.importSession(clamped, HARNESS);
  await tracker.flushNow();
  assert.deepEqual(ingestFailurePairs(emitted), [
    [ImportIngestFailure.SessionPayloadClamped, 1],
  ]);

  await wrapped.importSession(clamped, HARNESS);
  await tracker.flushNow();
  assert.deepEqual(ingestFailurePairs(emitted.slice(1)), [
    [ImportIngestFailure.SessionPayloadClamped, 1],
  ]);
  tracker.dispose();
});

test("a parse rejected by a collector restart is not an ingest failure", async () => {
  // `historicalParseRunner.stop()` REJECTS every in-flight and queued parse, and
  // `restartCollectors` stops the collectors WITHOUT disposing the import-health
  // tracker — so a hooks toggle mid-backfill unwinds through the throw path once
  // per queued source. Counting those reports an ingest failure per source on a
  // routine user action, which is worse than no counter at all: it looks like
  // data. The `threw` OUTCOME still stands; only the report is suppressed.
  const rejectedRun = async (
    isImportActive: () => boolean
  ): Promise<{ kind: string; reasons: ImportIngestFailure[] }> => {
    const reasons: ImportIngestFailure[] = [];
    const parsed = await parseSourceForPass(
      parseOptions({
        parseSource: () =>
          Promise.reject(new Error("historical parse worker stopped")),
        isImportActive,
        onIngestFailure: (reason) => reasons.push(reason),
      })
    );
    return { kind: parsed.outcome.kind, reasons };
  };

  const superseded = await rejectedRun(() => false);
  assert.equal(superseded.kind, "threw");
  assert.deepEqual(superseded.reasons, []);

  // ANCHOR: the identical rejection on a LIVE generation does count, so the
  // assertion above is about the generation gate and not about a sink that was
  // never wired or a path that never ran.
  const live = await rejectedRun(() => true);
  assert.equal(live.kind, "threw");
  assert.deepEqual(live.reasons, [ImportIngestFailure.SourceParseThrew]);
});

test("no transcript content, session name, or path rides the wire", async () => {
  const { runtime, transport } = await startRelayRuntime("install_iss6336_pii");
  activeRuntime = runtime;

  const installed = installImportHealthTracking({
    emitImportHealth: (input) => runtime.emitImportHealthEvent(input),
    database: {
      importer: importerReturning(),
      listImportPendingSessionIds: () => Promise.resolve([]),
    },
    log: () => undefined,
  });

  // Identifying data pushed through every input the counters read: the source
  // path the parse step is handed, and the id / name / cwd on the session whose
  // parseQuality is classified.
  const secretPath =
    "/Users/jane.doe/acme-payments/.claude/zzsecretpathzz.jsonl";
  const secretSessionId = "zzsecretsessionidzz";
  const secretName = "zzsecretnamezz";
  const secretCwd = "/Users/jane.doe/acme-payments/zzsecretcwdzz";

  await parseSourceForPass(
    parseOptions({
      source: secretPath,
      parseSource: () => Promise.reject(new Error(`cannot read ${secretPath}`)),
      onIngestFailure: installed.noteIngestFailure,
    })
  );
  await installed.importer.importSession(
    sessionWith(
      { totalLines: 10, malformedLines: 3, truncatedFinalLine: false },
      { sessionId: secretSessionId, name: secretName, cwd: secretCwd }
    ),
    HARNESS
  );

  await installed.shutdown();
  await runtime.shutdown();
  activeRuntime = null;

  const records = decodeRelayImportRecords(transport);
  const reasons = records
    .filter(
      (record) =>
        record[TelemetryAttribute.ImportEvent] ===
        ImportHealthEvent.IngestFailed
    )
    .map((record) => record[TelemetryAttribute.ImportIngestFailure])
    .sort();

  // ANCHOR: both counters really shipped in this same run, so the absence
  // assertions below cannot be satisfied by emitting nothing at all.
  assert.deepEqual(
    reasons,
    [
      ImportIngestFailure.SessionParseDegraded,
      ImportIngestFailure.SourceParseThrew,
    ].sort()
  );

  const wire = shippedBytesAsText(transport);
  for (const secret of [
    secretPath,
    secretSessionId,
    secretName,
    secretCwd,
    "jane.doe",
    "acme-payments",
  ]) {
    assert.equal(
      wire.includes(secret),
      false,
      `serialized payload leaked ${secret}`
    );
  }
});

/**
 * ISS-12036: the fold site a degraded session lost its lines at.
 *
 * `malformedLines` is the sum of three independent files — the session's own
 * transcript, each folded child (a Claude subagent sidecar, a Codex
 * `workflow-*.jsonl` journal) and each folded descendant rollout (a Codex
 * fork/resume child). `session_parse_degraded` said a session lost content and
 * nothing said WHERE, so ISS-12036 could not tell a corrupting harness writer
 * from a corrupting fold. The fold sites tally their own shares and the
 * session's own is the remainder.
 *
 * Each case below moves exactly one operand, and the LAST two are the ones that
 * fail on a lazy implementation: an unattributed session must OMIT the site
 * rather than default to `main_transcript`, and shares that exceed the total
 * they are shares of must omit it too rather than publish a negative remainder
 * as a site.
 *
 * MUTATION: return `MainTranscript` instead of `undefined` for a quality with no
 * per-site counts and the fourth case fails; drop the `own < 0` guard and the
 * fifth reports `folded_child`.
 */
test("ISS-12036: a degraded session names which folded file lost the lines", () => {
  const cases: [string, NormalizedParseQuality, unknown][] = [
    [
      "the session's own transcript",
      { totalLines: 10, malformedLines: 2, truncatedFinalLine: false },
      ImportParseDegradedSite.MainTranscript,
    ],
    [
      "a folded child only",
      {
        totalLines: 10,
        malformedLines: 2,
        truncatedFinalLine: false,
        foldedChildMalformedLines: 2,
      },
      ImportParseDegradedSite.FoldedChild,
    ],
    [
      "a folded descendant only",
      {
        totalLines: 10,
        malformedLines: 2,
        truncatedFinalLine: false,
        foldedDescendantMalformedLines: 2,
      },
      ImportParseDegradedSite.FoldedDescendant,
    ],
    [
      "the session and a descendant both",
      {
        totalLines: 10,
        malformedLines: 3,
        truncatedFinalLine: false,
        foldedDescendantMalformedLines: 2,
      },
      ImportParseDegradedSite.Multiple,
    ],
    [
      "a benign trailing truncation and nothing else",
      { totalLines: 10, malformedLines: 1, truncatedFinalLine: true },
      undefined,
    ],
    [
      "shares that exceed the total they are shares of",
      {
        totalLines: 10,
        malformedLines: 1,
        truncatedFinalLine: false,
        foldedChildMalformedLines: 5,
      },
      undefined,
    ],
  ];

  assert.deepEqual(
    cases.map(([name, quality]) => [name, parseDegradedSite(quality)]),
    cases.map(([name, , expected]) => [name, expected])
  );
  // A session with no parse quality at all answers nothing either.
  assert.equal(parseDegradedSite(undefined), undefined);
});

/**
 * ISS-12036: the site reaches the emitted record, and ONLY on the reasons it
 * describes.
 *
 * Two sessions degraded at different sites need two records: the count measures
 * SESSIONS that lost content, so folding them into one record would have to drop
 * a site, and splitting a single session across sites would double its count.
 * The unrouted-records reason is the negative control — its lines parsed fine
 * and were lost later, so a corruption site would be an answer to a question it
 * does not ask.
 *
 * MUTATION: key `ingestFailureCounts` on the reason alone and the two degraded
 * sites collapse into one record; flip `session_records_unrouted` to `true` in
 * `PARSE_QUALITY_SITE_APPLIES` and the third row gains a site.
 */
test("ISS-12036: the fold site rides the ingest-failure record, per site", async () => {
  const emitted: DesktopImportHealthEventInput[] = [];
  const tracker = createImportHealthTracker({
    emitImportHealth: (input) => emitted.push(input),
    listPendingRevisionSessionIds: () => Promise.resolve([]),
    tickMs: NO_AUTOMATIC_TICK_MS,
  });
  const wrapped = tracker.wrapImporter(importerReturning());

  await wrapped.importSession(
    sessionWith(
      { totalLines: 10, malformedLines: 2, truncatedFinalLine: false },
      { sessionId: "own-transcript" }
    ),
    HARNESS
  );
  await wrapped.importSession(
    sessionWith(
      {
        totalLines: 10,
        malformedLines: 2,
        truncatedFinalLine: false,
        foldedChildMalformedLines: 2,
      },
      { sessionId: "folded-journal" }
    ),
    HARNESS
  );
  await wrapped.importSession(
    sessionWith(
      {
        totalLines: 10,
        malformedLines: 0,
        truncatedFinalLine: false,
        unknownRecords: 4,
      },
      { sessionId: "unrouted" }
    ),
    HARNESS
  );
  await tracker.flushNow();

  const rows: [string, number, string | undefined][] = [];
  for (const input of emitted) {
    if (input.kind === ImportHealthEvent.IngestFailed) {
      rows.push([input.reason, input.count, input.degradedSite]);
    }
  }
  assert.deepEqual(
    rows.sort(),
    [
      [
        ImportIngestFailure.SessionParseDegraded,
        1,
        ImportParseDegradedSite.FoldedChild,
      ],
      [
        ImportIngestFailure.SessionParseDegraded,
        1,
        ImportParseDegradedSite.MainTranscript,
      ],
      [ImportIngestFailure.SessionRecordsUnrouted, 1, undefined],
    ].sort() as [string, number, string | undefined][]
  );
  tracker.dispose();
});
