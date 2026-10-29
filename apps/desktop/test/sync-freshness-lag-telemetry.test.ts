/**
 * @file sync-freshness-lag-telemetry.test.ts
 * @description ISS-7496 coverage for the unmeasurable-freshness monitored event.
 *
 * `ANOMALY_MESSAGE` is not exported, so every case drives the public
 * {@link reportFreshestSessionLagAnomaly} and asserts on the emitted event — which
 * is also the boundary that matters, since the sentence is what an operator reads,
 * and since this rides the same authenticated lane the sibling
 * `sync-lane-stall-telemetry.test.ts` guards the same way.
 *
 * The clock is pinned for every case. Nothing here is time-DEPENDENT, but the
 * envelope carries an emission timestamp the redaction scan below has to reason
 * about, and ISS-7712 is what an unpinned scan cost: a canary that failed on
 * CORRECT output for one hour a day, ejecting other authors' PRs from the merge
 * queue fleet-wide. Pinning inside that hour makes every run a run at 12:34 UTC.
 *
 * The per-kind latch is module-level and PROCESS-WIDE by design, and
 * `Observability.reset()` does not clear it. Every case therefore loads a FRESH
 * module graph via {@link loadFreshReporter} so it owns its own latch. Without
 * that, a case asserting "already latched" passes only because an earlier case
 * primed the set, and fails the moment it runs alone or the file is reordered —
 * a guard that cannot fail is not a guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreshestSessionLagAnomaly } from "../src/main/agent-sync/agent-session-freshness-lag.js";
import type { Observability as ObservabilityClass } from "../src/main/telemetry/observability.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";

const UNMEASURABLE_CATEGORY = "sync.freshest_session_lag.unmeasurable";
const CORRUPT_ROW_RE = /no readable session updated_at/;
const CLOCK_STEP_RE = /ahead of the local clock that acked it/;
/**
 * Shapes that must never reach the wire from this reporter: a session id, a home
 * or workspace path, and any absolute timestamp. The claim the module makes about
 * itself is only worth what this scan asserts.
 */
const FORBIDDEN_CONTENT = ["session-", "/Users/", "/workspace/"];
/** Label for the timestamp rule, so a leak report can name which rule fired. */
const ABSOLUTE_TIMESTAMP_SHAPE = "an absolute date-time";
/**
 * The ONE field allowed to carry an absolute timestamp: the envelope stamp
 * `TelemetryService.enrichEvent` writes over whatever the caller passed. Named
 * so {@link scannableEnvelope} exempts a field rather than a key name.
 */
const ENVELOPE_TIMESTAMP_KEY = "timestamp";
/**
 * The timestamp half of that scan. A literal hour (this was `"T12:"`) cannot
 * express "any absolute timestamp" — it matches one hour in twenty-four, and the
 * only thing it ever caught was the envelope's own `timestamp`, which the
 * telemetry service stamps and the schema requires. So it passed for 23 hours a
 * day and reddened every suite in the repo during the 12:00 UTC hour.
 *
 * `[T ]` because a SQLite `updated_at` read straight off a row is space-separated
 * (`2026-03-04 05:06:07`) and is exactly the value this reporter must not echo; a
 * `T`-only pattern would carry it to the wire unnoticed. The minutes are required
 * so the pattern matches a date-time rather than a truncated fragment of one.
 */
const ABSOLUTE_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * Pinned INSIDE the window the old canary broke in, per the repo's rule that
 * clock-boundary behaviour is pinned rather than observed. The hour that took the
 * fleet down is now the hour this suite proves itself in, on every machine at any
 * local time — and it is what lets the exempted envelope `timestamp` be asserted
 * as an exact value rather than merely stripped.
 */
const PINNED_NOW = "2026-08-22T12:34:56.789Z";

/**
 * A fresh module graph, so the module-level latch starts empty. `Observability`
 * is re-imported from the SAME reset registry — importing it statically would
 * hand back a different class object than the one the reporter closed over, and
 * `init` would then wire a sink the reporter never reads.
 */
async function loadFreshReporter(): Promise<{
  report: (anomaly: FreshestSessionLagAnomaly) => void;
  Observability: typeof ObservabilityClass;
  setTelemetryDeliverable: (predicate: (() => boolean) | null) => void;
}> {
  vi.resetModules();
  const [reporterModule, observabilityModule, readinessModule] =
    await Promise.all([
      import("../src/main/telemetry/sync-freshness-lag-telemetry.js"),
      import("../src/main/telemetry/observability.js"),
      import("../src/main/telemetry/telemetry-delivery-readiness.js"),
    ]);
  return {
    report: reporterModule.reportFreshestSessionLagAnomaly,
    Observability: observabilityModule.Observability,
    setTelemetryDeliverable: readinessModule.setTelemetryDeliverable,
  };
}

/**
 * Drive the reporter against a lane whose send gate is `deliverable`.
 *
 * `telemetrySend` drops while the gate is closed, exactly as the lane router
 * does — modelling the outage as a silent drop rather than a captured event is
 * what makes the returned array mean "reached the wire".
 */
function capture(
  harness: Awaited<ReturnType<typeof loadFreshReporter>>,
  deliverable: boolean,
  report: () => void
): EnrichedTelemetryEvent[] {
  const events: EnrichedTelemetryEvent[] = [];
  harness.Observability.init({
    telemetrySend: (event) => {
      if (deliverable) {
        events.push(event);
      }
    },
  });
  harness.setTelemetryDeliverable(() => deliverable);
  try {
    report();
  } finally {
    harness.Observability.reset();
    harness.setTelemetryDeliverable(null);
  }
  return events;
}

/**
 * The redaction scan, returning the shapes that DID leak rather than asserting.
 *
 * Extracted so the case that drives the reporter and the case that proves this
 * scan can still fail run the same code, and returning labels so that second case
 * can name the one rule it tripped — "something failed" would stay green if a
 * different rule fired for a different reason. A canary only ever run against
 * known-clean output is a canary nobody has watched die, which is how `"T12:"`
 * stayed inert twenty-three hours a day without anyone noticing.
 *
 * The scan drops the service-stamped `timestamp`, which is envelope metadata the
 * schema requires rather than anything the reporter chose; every field the
 * reporter CAN reach, including the sentence, stays in scope for both rules.
 */
function findLeaks(events: EnrichedTelemetryEvent[]): string[] {
  const serialized = JSON.stringify(events.map(scannableEnvelope));
  const leaked = FORBIDDEN_CONTENT.filter((forbidden) =>
    serialized.includes(forbidden)
  );
  if (ABSOLUTE_TIMESTAMP_RE.test(serialized)) {
    leaked.push(ABSOLUTE_TIMESTAMP_SHAPE);
  }
  return leaked;
}

/**
 * One event reduced to the fields the REPORTER authors: everything except the
 * service-stamped top-level `timestamp`.
 *
 * ISS-7722. This used to be a `JSON.stringify` replacer keyed on
 * `key === "timestamp"`, and a replacer sees only `(key, value)` — it fires at
 * EVERY depth. So an absolute timestamp that reached a NESTED field which
 * happens to be named `timestamp` was stripped before either rule could see it,
 * and the scan reported clean. That is not a hypothetical name collision:
 * `TelemetryDiagnostics.decisionTableVerification` already resolves to
 * `DecisionTableVerificationRecordDiagnostics`, which declares a required
 * `timestamp: string` (`src/main/telemetry/telemetry-protocol.ts`), and
 * `diagnostics.extra` is an unbounded `Record<string, unknown>` that can carry
 * the name too.
 *
 * The exemption belongs to ONE field on ONE object — the envelope stamp
 * `TelemetryService.enrichEvent` writes unconditionally — so it is taken by
 * NAME AT THE TOP LEVEL OF EACH EVENT rather than by name at any depth. The
 * `timestamp` key is dropped rather than blanked because a placeholder value
 * would have to be a shape neither rule matches, which is one more thing to keep
 * true.
 */
function scannableEnvelope(
  event: EnrichedTelemetryEvent
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== ENVELOPE_TIMESTAMP_KEY)
  );
}

/**
 * One leaked `message` per shape {@link findLeaks} claims to stop.
 *
 * The date-time fixture deliberately uses hour **05**, not 12: the substring this
 * change removes would have waved that leak straight through, which is the whole
 * reason a four-character canary was never the assertion it was written down as.
 */
/**
 * The absolute timestamp injected into a NESTED field named `timestamp`.
 *
 * Deliberately a different value from {@link PINNED_NOW}: a leak that happened
 * to equal the envelope's own stamp could be waved through by a future
 * value-based exemption and nobody would notice.
 */
const NESTED_LEAKED_TIMESTAMP = "2026-03-04T05:06:07.000Z";

const LEAK_FIXTURES = [
  {
    shape: "session-",
    message: "session-4f2ab7 carried no readable updated_at",
  },
  {
    shape: "/Users/",
    message: "could not read /Users/someone/store.sqlite",
  },
  {
    shape: "/workspace/",
    message: "could not read /workspace/checkout/store.sqlite",
  },
  {
    shape: ABSOLUTE_TIMESTAMP_SHAPE,
    message: "row updated_at was 2026-03-04T05:06:07.000Z",
  },
] as const;

describe("reportFreshestSessionLagAnomaly", () => {
  beforeEach(() => {
    // `Date` only: the module graph is loaded through dynamic imports, and faking
    // the timer functions as well would put Vite's own scheduling on a clock this
    // suite controls for no benefit.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(PINNED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports each kind once, with its own sentence and nothing else", async () => {
    const harness = await loadFreshReporter();
    const { report } = harness;

    const events = capture(harness, true, () => {
      report(FreshestSessionLagAnomaly.UnreadableUpdatedAt);
      // The repeat is what a persistently corrupt store would do on every batch.
      report(FreshestSessionLagAnomaly.UnreadableUpdatedAt);
      // A DIFFERENT kind must still get through — one shared flag would silence
      // the clock-step condition on any machine that hit the corrupt-row one.
      report(FreshestSessionLagAnomaly.FutureUpdatedAt);
      report(FreshestSessionLagAnomaly.FutureUpdatedAt);
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.category)).toEqual([
      UNMEASURABLE_CATEGORY,
      UNMEASURABLE_CATEGORY,
    ]);
    expect(events.map((event) => event.severity)).toEqual(["error", "error"]);
    expect(events[0]?.message).toMatch(CORRUPT_ROW_RE);
    expect(events[1]?.message).toMatch(CLOCK_STEP_RE);

    // Scanning the SERIALIZED events catches a leak anywhere in the envelope
    // except the ONE exempted field, not only in the field this suite happened
    // to think of. That sentence used to be written without the exception and
    // was wrong for one key name — see {@link scannableEnvelope} (ISS-7722).
    // The length assertion above is its positive control: the scan ran over
    // real events.
    expect(findLeaks(events)).toEqual([]);

    // Positive control for the one field `findLeaks` exempts. If the envelope
    // stopped carrying `timestamp`, the scan would drop nothing and no
    // assertion here would notice; pinning the clock lets the exemption be
    // asserted as a present, exact value rather than taken on trust.
    expect(events.map((event) => event.timestamp)).toEqual([
      PINNED_NOW,
      PINNED_NOW,
    ]);
  });

  it("stays latched for the rest of the process once both kinds have reported", async () => {
    const harness = await loadFreshReporter();
    const { report } = harness;

    // Prime the latch inside THIS case, so the assertion below depends on the
    // reporter and not on which sibling happened to run first.
    const primed = capture(harness, true, () => {
      report(FreshestSessionLagAnomaly.UnreadableUpdatedAt);
      report(FreshestSessionLagAnomaly.FutureUpdatedAt);
    });
    expect(primed).toHaveLength(2);

    const afterLatch = capture(harness, true, () => {
      report(FreshestSessionLagAnomaly.UnreadableUpdatedAt);
      report(FreshestSessionLagAnomaly.FutureUpdatedAt);
    });

    expect(afterLatch).toEqual([]);
  });

  it("does not burn the latch on a report the lane could not carry (whitlockk)", async () => {
    const harness = await loadFreshReporter();
    const { report } = harness;

    // The lane is down: the send gate is closed, so this report reaches nothing
    // and no operator ever sees it.
    const duringOutage = capture(harness, false, () => {
      report(FreshestSessionLagAnomaly.UnreadableUpdatedAt);
    });
    expect(duringOutage).toEqual([]);

    // The condition is a STATE, so the next confirmed batch reports it again.
    // If the latch were set on the ATTEMPT above, this would be empty and the
    // install would look healthy for the rest of the process.
    const afterRecovery = capture(harness, true, () => {
      report(FreshestSessionLagAnomaly.UnreadableUpdatedAt);
    });

    expect(afterRecovery).toHaveLength(1);
    expect(afterRecovery[0]?.category).toBe(UNMEASURABLE_CATEGORY);
    expect(afterRecovery[0]?.message).toMatch(CORRUPT_ROW_RE);
  });

  it("has a redaction scan that still fires on a real leak", async () => {
    const harness = await loadFreshReporter();
    const { report } = harness;

    const clean = capture(harness, true, () => {
      report(FreshestSessionLagAnomaly.UnreadableUpdatedAt);
    });
    expect(clean).toHaveLength(1);
    // The scan is silent on the reporter's real output — so every hit below is
    // the injected leak, not a scan that rejects everything it is handed.
    expect(findLeaks(clean)).toEqual([]);

    // A rule added to the scan without a fixture proving it fires would leave
    // that rule as inert as `"T12:"` was; this keeps the two in lockstep.
    expect(LEAK_FIXTURES.map((fixture) => fixture.shape)).toEqual([
      ...FORBIDDEN_CONTENT,
      ABSOLUTE_TIMESTAMP_SHAPE,
    ]);

    for (const fixture of LEAK_FIXTURES) {
      const leaked = clean.map((event) => ({
        ...event,
        message: fixture.message,
      }));
      expect(findLeaks(leaked), fixture.shape).toEqual([fixture.shape]);
    }
  });

  it("sees an absolute timestamp nested under a field also named timestamp", async () => {
    const harness = await loadFreshReporter();
    const { report } = harness;

    const clean = capture(harness, true, () => {
      report(FreshestSessionLagAnomaly.UnreadableUpdatedAt);
    });
    expect(clean).toHaveLength(1);
    expect(findLeaks(clean)).toEqual([]);

    // The exemption is load-bearing rather than decorative: the envelope stamp
    // IS an absolute date-time, so without it the clean scan above would report
    // this shape on every correct emission. That is also why an injection at the
    // TOP level cannot observe ISS-7722 — it lands on the one field the scan is
    // supposed to drop, and dropping it is right.
    expect(ABSOLUTE_TIMESTAMP_RE.test(clean[0]?.timestamp ?? "")).toBe(true);

    // `diagnostics.extra` is the type-legal nesting for this injection today.
    // The real declared sibling it stands in for is
    // `diagnostics.decisionTableVerification.timestamp`, a REQUIRED `string` on
    // `DecisionTableVerificationRecordDiagnostics` — seeded here through the
    // unbounded bag so the case pins the SCAN and not one diagnostics variant's
    // dozen unrelated required fields.
    const leaked = clean.map((event) => ({
      ...event,
      diagnostics: {
        ...event.diagnostics,
        extra: { timestamp: NESTED_LEAKED_TIMESTAMP },
      },
    }));

    // ISS-7722: a replacer keyed on `key === "timestamp"` strips this too, and
    // reports clean. Exempting the field instead of the name is what lets the
    // rule reach it.
    expect(findLeaks(leaked)).toEqual([ABSOLUTE_TIMESTAMP_SHAPE]);
  });
});
