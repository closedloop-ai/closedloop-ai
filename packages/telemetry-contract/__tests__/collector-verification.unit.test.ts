import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { CollectorTailSamplingPolicy } from "../collector-tail-sampling-policy";
import {
  parseTailSamplingProcessor,
  renderVerificationCollectorConfig,
  VERIFICATION_EXPORT_FLUSH_INTERVAL_MS,
} from "../collector-verification/otelcol-config";
import type { VerificationReport } from "../collector-verification/run-verification";
import {
  buildScenarioTraces,
  type OtlpTracePayload,
  SCENARIO_ATTRIBUTE_KEY,
  Scenario,
  type ScenarioCounts,
} from "../collector-verification/synthetic-otlp";
import {
  evaluateLegs,
  InconclusiveVerificationError,
  parseDecisionMetrics,
  parseExportedScenarioCounts,
  settleExportedScenarioCounts,
} from "../collector-verification/tail-sampling-metrics";
import {
  RETENTION_SEMANTICS,
  renderArtifact,
} from "../scripts/verify-collector-tail-sampling";

const FRAGMENT_PATH = new URL(
  "../collector/tail-sampling.yaml",
  import.meta.url
);
const committedFragment = readFileSync(FRAGMENT_PATH, "utf-8");

const COUNTS: ScenarioCounts = {
  errors: 3,
  serverErrors: 2,
  slow: 4,
  baseline: 100,
};

/** A 16-byte (32 hex char) OTLP/JSON trace id. */
const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
/** Matches the error thrown for a fragment with no tail_sampling block. */
const TAIL_SAMPLING_ERROR = /tail_sampling/;
/** The cap-exhausted settle must name the outcome, not merely fail. */
const INCONCLUSIVE_MESSAGE = /INCONCLUSIVE/;
/** …and carry the counts it last read, so the run can be diagnosed. */
const INCONCLUSIVE_LAST_READ = /last read [a-z-]+=\d+/;
/** A settled read that did not parse cleanly must say so. */
const UNPARSEABLE_LINE = /unparseable line/;

type SpanShape = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number };
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
};

const spansOf = (payload: OtlpTracePayload): SpanShape[] => {
  const rs = payload.resourceSpans[0] as Record<string, unknown>;
  const ss = (rs.scopeSpans as Record<string, unknown>[])[0];
  return ss.spans as SpanShape[];
};

const spanOf = (payload: OtlpTracePayload): SpanShape =>
  spansOf(payload)[0] as SpanShape;

const attr = (
  span: SpanShape,
  key: string
): Record<string, unknown> | undefined =>
  span.attributes.find((a) => a.key === key)?.value;

const scenarioOf = (span: SpanShape): string =>
  attr(span, SCENARIO_ATTRIBUTE_KEY)?.stringValue as string;

const durationMs = (span: SpanShape): number =>
  Number(
    (BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n
  );

describe("synthetic OTLP trace builder", () => {
  const { payloads, payloadDelaysMs, manifest, totalSent } =
    buildScenarioTraces(COUNTS, {
      baseTimeUnixNano: 1_700_000_000_000_000_000n,
    });

  const bySc = (s: Scenario): SpanShape[] =>
    payloads.flatMap(spansOf).filter((span) => scenarioOf(span) === s);

  it("emits one trace per requested scenario count", () => {
    expect(totalSent).toBe(
      COUNTS.errors + COUNTS.serverErrors + COUNTS.slow + COUNTS.baseline
    );
    // A slow trace is exported across TWO payloads (child, then the root when
    // it closes), so payload count exceeds trace count by exactly that many.
    expect(payloads).toHaveLength(totalSent + COUNTS.slow);
    expect(payloadDelaysMs).toHaveLength(payloads.length);
    expect(bySc(Scenario.Error)).toHaveLength(COUNTS.errors);
    expect(bySc(Scenario.ServerError)).toHaveLength(COUNTS.serverErrors);
    expect(new Set(bySc(Scenario.Slow).map((span) => span.traceId)).size).toBe(
      COUNTS.slow
    );
    expect(bySc(Scenario.Baseline)).toHaveLength(COUNTS.baseline);
  });

  it("shapes the error scenario as span status ERROR", () => {
    for (const span of bySc(Scenario.Error)) {
      expect(span.status.code).toBe(2);
      expect(
        attr(span, CollectorTailSamplingPolicy.serverErrorAttributeKey)
      ).toBeUndefined();
    }
  });

  it("shapes the server-error scenario with the 5xx status attribute from the SSOT", () => {
    for (const span of bySc(Scenario.ServerError)) {
      expect(span.status.code).toBe(0);
      expect(
        attr(span, CollectorTailSamplingPolicy.serverErrorAttributeKey)
      ).toEqual({
        intValue: String(
          CollectorTailSamplingPolicy.serverErrorStatusRange.min
        ),
      });
    }
  });

  it("shapes each slow trace as an ipc child exported before its cl-desktop root, which closes inside the decision window", () => {
    const closeDelayMs =
      CollectorTailSamplingPolicy.slowTraceLatencyThresholdMs + 1000;
    let childrenSeen = 0;

    for (const [index, payload] of payloads.entries()) {
      // Every payload carries exactly one span, slow ones included — the two
      // spans of a slow trace are two separate exports, which is the point.
      expect(spansOf(payload as OtlpTracePayload)).toHaveLength(1);
      const child = spanOf(payload as OtlpTracePayload);
      if (scenarioOf(child) !== Scenario.Slow || child.name !== "ipc.list") {
        continue;
      }
      childrenSeen += 1;
      const rootIndex = payloads.findIndex((candidate) => {
        const span = spanOf(candidate as OtlpTracePayload);
        return span.traceId === child.traceId && span.name === "cl-desktop";
      });
      const root = spanOf(payloads[rootIndex] as OtlpTracePayload);

      expect(child.traceId).toBe(root.traceId);
      expect(child.parentSpanId).toBe(root.spanId);
      // Delivery order is the property under test: the child lands first, the
      // root only when it closes.
      expect(rootIndex).toBeGreaterThan(index);
      expect(payloadDelaysMs[index]).toBe(0);
      expect(root.status.code).toBe(0);
      expect(durationMs(child)).toBeLessThan(
        CollectorTailSamplingPolicy.slowTraceLatencyThresholdMs
      );
      expect(durationMs(root)).toBe(closeDelayMs);
      // The whole point of the < decision-window rule: the root still arrives
      // in time to be voted on. A root that closed later would be decided on a
      // buffer holding only the 1ms child, and keep-slow would never fire.
      expect(durationMs(root)).toBeLessThan(
        CollectorTailSamplingPolicy.decisionWaitSeconds * 1000
      );
      expect(
        attr(root, CollectorTailSamplingPolicy.serverErrorAttributeKey)
      ).toBeUndefined();
    }

    expect(childrenSeen).toBe(COUNTS.slow);
    // One wait for the whole cohort, not one per root.
    expect(
      payloadDelaysMs.filter((delay) => delay === closeDelayMs)
    ).toHaveLength(1);
  });

  it("shapes baseline traces as fast, status-unset, no 5xx", () => {
    for (const span of bySc(Scenario.Baseline)) {
      expect(span.status.code).toBe(0);
      expect(durationMs(span)).toBeLessThan(
        CollectorTailSamplingPolicy.slowTraceLatencyThresholdMs
      );
      expect(
        attr(span, CollectorTailSamplingPolicy.serverErrorAttributeKey)
      ).toBeUndefined();
    }
  });

  it("assigns distinct, high-entropy hex ids to every trace", () => {
    const spans = payloads.flatMap(spansOf);
    const traceIds = spans.map((s) => s.traceId);
    expect(new Set(traceIds).size).toBe(totalSent);
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(spans.length);
    for (const id of traceIds) {
      expect(id).toMatch(HEX_TRACE_ID);
      // Not the degenerate near-zero ids that hash into a 0% bucket.
      expect(id.startsWith("00000000")).toBe(false);
    }
  });

  it("is deterministic across builds", () => {
    const again = buildScenarioTraces(COUNTS, {
      baseTimeUnixNano: 1_700_000_000_000_000_000n,
    });
    expect(again.payloads).toEqual(payloads);
    // Pin the first trace's ids to concrete SHA-256-derived values so a change to
    // the id-derivation algorithm or seed (which would silently shift the sampled
    // baseline rate) fails here, not just an in-process self-comparison.
    const first = spanOf(payloads[0] as OtlpTracePayload);
    expect(first.traceId).toBe("d362f5f05c7373d9e1302c3cd23c0053");
    expect(first.spanId).toBe("d2dd004725e8f654");
  });

  it("maps each scenario to its keep policy in the manifest", () => {
    const names = CollectorTailSamplingPolicy.policyNames;
    expect(manifest.map((m) => [m.scenario, m.policyName])).toEqual([
      [Scenario.Error, names.errorStatus],
      [Scenario.ServerError, names.serverErrors],
      [Scenario.Slow, names.slow],
      [Scenario.Baseline, names.baseline],
    ]);
    const baseline = manifest.find((m) => m.scenario === Scenario.Baseline);
    expect(baseline?.expectation).toEqual({
      kind: "sampled",
      samplingPercentage:
        CollectorTailSamplingPolicy.baselineSamplingPercentage,
    });
  });
});

describe("verification collector config", () => {
  it("embeds the committed tail_sampling block verbatim", () => {
    const config = YAML.parse(
      renderVerificationCollectorConfig(committedFragment)
    );
    expect(config.processors.tail_sampling).toEqual(
      parseTailSamplingProcessor(committedFragment)
    );
  });

  it.each([
    ["a scalar document", "42\n"],
    ["an empty document", ""],
    ["a mapping without a tail_sampling key", "batch: {}\n"],
    ["a tail_sampling key that is not a mapping", "tail_sampling: []\n"],
  ])("refuses %s as a tail-sampling fragment", (_label, source) => {
    expect(() => parseTailSamplingProcessor(source)).toThrow(
      'Committed tail-sampling fragment does not contain a "tail_sampling" block.'
    );
  });

  it("wires a minimal otlp → tail_sampling → file traces pipeline", () => {
    const config = YAML.parse(
      renderVerificationCollectorConfig(committedFragment)
    );
    expect(config.service.pipelines.traces).toEqual({
      receivers: ["otlp"],
      processors: ["tail_sampling"],
      exporters: ["file"],
    });
    expect(config.receivers.otlp.protocols.http.endpoint).toContain("4318");
    expect(config.exporters.file.path).toBe("/output/traces.json");
  });

  it("pins the file exporter's flush cadence instead of inheriting otelcol's 1s default", () => {
    const config = YAML.parse(
      renderVerificationCollectorConfig(committedFragment)
    );
    expect(config.exporters.file.flush_interval).toBe(
      `${VERIFICATION_EXPORT_FLUSH_INTERVAL_MS}ms`
    );
  });

  it("exposes the collector's own metrics on a prometheus endpoint", () => {
    const config = YAML.parse(
      renderVerificationCollectorConfig(committedFragment)
    );
    const reader = config.service.telemetry.metrics.readers[0];
    expect(reader.pull.exporter.prometheus.port).toBe(8888);
  });

  it("rejects a fragment without a tail_sampling block", () => {
    expect(() => renderVerificationCollectorConfig("redaction: {}\n")).toThrow(
      TAIL_SAMPLING_ERROR
    );
  });
});

describe("decision metrics parser", () => {
  const sample = [
    "# HELP otelcol_processor_tail_sampling_count_traces_sampled Count of traces",
    "# TYPE otelcol_processor_tail_sampling_count_traces_sampled counter",
    'otelcol_processor_tail_sampling_count_traces_sampled{policy="keep-error-status",sampled="true",service_name="x"} 5',
    'otelcol_processor_tail_sampling_count_traces_sampled{policy="keep-error-status",sampled="false",service_name="x"} 1010',
    'otelcol_processor_tail_sampling_count_traces_sampled{policy="baseline",sampled="true"} 106',
    'otelcol_processor_tail_sampling_count_traces_sampled{policy="baseline",sampled="false"} 909',
    'otelcol_receiver_accepted_spans{transport="http"} 1015',
  ].join("\n");

  it("groups sampled true/false counts by policy", () => {
    const metrics = parseDecisionMetrics(sample);
    expect(metrics.get("keep-error-status")).toEqual({
      sampledTrue: 5,
      sampledFalse: 1010,
    });
    expect(metrics.get("baseline")).toEqual({
      sampledTrue: 106,
      sampledFalse: 909,
    });
  });

  it("ignores unrelated metric lines", () => {
    expect(
      parseDecisionMetrics(sample).has("otelcol_receiver_accepted_spans")
    ).toBe(false);
  });

  it("tolerates a Prometheus _total counter suffix", () => {
    const withTotal =
      'otelcol_processor_tail_sampling_count_traces_sampled_total{policy="baseline",sampled="true"} 42';
    expect(parseDecisionMetrics(withTotal).get("baseline")?.sampledTrue).toBe(
      42
    );
  });

  it("tolerates an optional trailing Prometheus timestamp on the value", () => {
    const withTimestamp =
      'otelcol_processor_tail_sampling_count_traces_sampled{policy="baseline",sampled="true"} 106 1714000000000';
    expect(
      parseDecisionMetrics(withTimestamp).get("baseline")?.sampledTrue
    ).toBe(106);
  });

  it("returns an empty map for blank or malformed input", () => {
    expect(parseDecisionMetrics("").size).toBe(0);
    expect(parseDecisionMetrics("not a metric line").size).toBe(0);
  });
});

describe("exported scenario counter", () => {
  const line = (
    scenario: string,
    traceId: string,
    name = `synthetic-${scenario}`
  ): string =>
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  name,
                  attributes: [
                    {
                      key: SCENARIO_ATTRIBUTE_KEY,
                      value: { stringValue: scenario },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

  it("counts retained traces per scenario across newline-delimited batches", () => {
    const content = [
      line("error", "aa"),
      line("error", "bb"),
      line("error", "bb"),
      line("baseline", "cc"),
      "",
      "{ not json",
    ].join("\n");
    const counts = parseExportedScenarioCounts(content);
    expect(counts.get(Scenario.Error)).toBe(2);
    expect(counts.get(Scenario.Baseline)).toBe(1);
  });

  it("counts the builder's own output, so a producer/consumer shape change fails here", () => {
    // Deliberately NOT hand-fabricated JSONL. The collector's file exporter
    // writes the same payload shape `buildScenarioTraces` produces, so running
    // the builder's real output through the counter is the only thing that
    // catches a producer/consumer reshape — a hand-written fixture pins the
    // fixture, and stays green while the counter returns 0 for every slow
    // trace the builder actually emits.
    const { payloads } = buildScenarioTraces(COUNTS, {
      baseTimeUnixNano: 1_700_000_000_000_000_000n,
    });
    const counts = parseExportedScenarioCounts(
      payloads.map((payload) => JSON.stringify(payload)).join("\n")
    );
    expect(counts.get(Scenario.Slow)).toBe(COUNTS.slow);
    expect(counts.get(Scenario.Error)).toBe(COUNTS.errors);
    expect(counts.get(Scenario.ServerError)).toBe(COUNTS.serverErrors);
    expect(counts.get(Scenario.Baseline)).toBe(COUNTS.baseline);
  });

  it("does not count a slow trace whose cl-desktop root never arrived", () => {
    // The failure the `slowTraceLatencyThresholdMs < decisionWaitSeconds` rule
    // exists to prevent: a root that closes after the vote is never buffered,
    // so the collector decides on the 1ms child alone. Counting distinct trace
    // ids would score that as retained and pass the slow leg for a policy on
    // which keep-slow can never fire.
    const { payloads } = buildScenarioTraces(COUNTS, {
      baseTimeUnixNano: 1_700_000_000_000_000_000n,
    });
    const withoutRoots = payloads.filter(
      (payload) => spanOf(payload).name !== "cl-desktop"
    );
    expect(withoutRoots).toHaveLength(payloads.length - COUNTS.slow);

    const counts = parseExportedScenarioCounts(
      withoutRoots.map((payload) => JSON.stringify(payload)).join("\n")
    );
    expect(counts.get(Scenario.Slow)).toBe(0);
    // The other legs are unaffected, so a 0 here is the completeness check and
    // not an empty parse.
    expect(counts.get(Scenario.Error)).toBe(COUNTS.errors);
    expect(counts.get(Scenario.Baseline)).toBe(COUNTS.baseline);
  });

  it("returns an empty map for empty content", () => {
    expect(parseExportedScenarioCounts("").size).toBe(0);
  });
});

describe("leg evaluation", () => {
  const traffic = buildScenarioTraces(COUNTS, { baseTimeUnixNano: 0n });
  const { manifest, totalSent } = traffic;
  const names = CollectorTailSamplingPolicy.policyNames;

  const passingMetrics = new Map([
    [
      names.errorStatus,
      { sampledTrue: COUNTS.errors, sampledFalse: totalSent - COUNTS.errors },
    ],
    [
      names.serverErrors,
      {
        sampledTrue: COUNTS.serverErrors,
        sampledFalse: totalSent - COUNTS.serverErrors,
      },
    ],
    [
      names.slow,
      { sampledTrue: COUNTS.slow, sampledFalse: totalSent - COUNTS.slow },
    ],
    [names.baseline, { sampledTrue: 11, sampledFalse: totalSent - 11 }],
  ]);
  const passingFile = new Map([
    [Scenario.Error, COUNTS.errors],
    [Scenario.ServerError, COUNTS.serverErrors],
    [Scenario.Slow, COUNTS.slow],
    [Scenario.Baseline, 11],
  ]);

  it("passes when every keep leg is 100% and baseline is a strict subset", () => {
    const result = evaluateLegs({
      manifest,
      metrics: passingMetrics,
      fileRetention: passingFile,
      totalSent,
    });
    expect(result.pass).toBe(true);
    expect(result.legs.every((leg) => leg.pass)).toBe(true);
  });

  it("fails a keep leg that is not retained at 100%", () => {
    const file = new Map(passingFile);
    file.set(Scenario.Slow, COUNTS.slow - 1);
    const result = evaluateLegs({
      manifest,
      metrics: passingMetrics,
      fileRetention: file,
      totalSent,
    });
    expect(result.pass).toBe(false);
    expect(
      result.legs.find((leg) => leg.scenario === Scenario.Slow)?.pass
    ).toBe(false);
  });

  it("fails the baseline leg when sampling is a no-op (≈100%)", () => {
    const metrics = new Map(passingMetrics);
    metrics.set(names.baseline, { sampledTrue: totalSent, sampledFalse: 0 });
    const file = new Map(passingFile);
    file.set(Scenario.Baseline, COUNTS.baseline);
    const result = evaluateLegs({
      manifest,
      metrics,
      fileRetention: file,
      totalSent,
    });
    expect(
      result.legs.find((leg) => leg.scenario === Scenario.Baseline)?.pass
    ).toBe(false);
  });

  it("fails the baseline leg when nothing is sampled (0%)", () => {
    const metrics = new Map(passingMetrics);
    metrics.set(names.baseline, { sampledTrue: 0, sampledFalse: totalSent });
    const file = new Map(passingFile);
    file.set(Scenario.Baseline, 0);
    const result = evaluateLegs({
      manifest,
      metrics,
      fileRetention: file,
      totalSent,
    });
    expect(
      result.legs.find((leg) => leg.scenario === Scenario.Baseline)?.pass
    ).toBe(false);
  });
});

describe("export-file settle", () => {
  // The collector writes the same payload shape the builder emits, so the
  // frames a fake exporter serves are the builder's own output — a hand-written
  // fixture would pin the fixture, not the producer/consumer contract.
  const { payloads: exported } = buildScenarioTraces(COUNTS, {
    baseTimeUnixNano: 1_700_000_000_000_000_000n,
  });
  const jsonl = (batch: readonly OtlpTracePayload[]): string =>
    batch.map((payload) => JSON.stringify(payload)).join("\n");

  const lastSlowRoot = exported
    .filter((payload) => spanOf(payload).name === "cl-desktop")
    .at(-1);
  // One slow trace present as its `ipc.list` child only. Read as a snapshot this
  // is ambiguous: the root may be sitting in the exporter's buffer, or it may
  // never have reached the collector at all.
  const missingOneRoot = jsonl(
    exported.filter((payload) => payload !== lastSlowRoot)
  );
  const whole = jsonl(exported);

  /** Serve `frames` in order, repeating the last one forever. */
  const exporterServing = (frames: readonly string[]) => {
    let reads = 0;
    return {
      readCount: () => reads,
      readExportFile: () => {
        const frame = frames[Math.min(reads, frames.length - 1)] as string;
        reads += 1;
        return frame;
      },
    };
  };

  const SETTLE = { stableReads: 2, maxReads: 20 } as const;
  const noWait = (): Promise<void> => Promise.resolve();

  it("recovers the whole-trace count when the missing root was only still buffered", async () => {
    // What a single read taken the instant the vote landed would have scored.
    expect(parseExportedScenarioCounts(missingOneRoot).get(Scenario.Slow)).toBe(
      COUNTS.slow - 1
    );
    const exporter = exporterServing([missingOneRoot, whole]);

    const counts = await settleExportedScenarioCounts({
      ...SETTLE,
      wait: noWait,
      readExportFile: exporter.readExportFile,
    });

    expect(counts.get(Scenario.Slow)).toBe(COUNTS.slow);
    expect(exporter.readCount()).toBeGreaterThan(1);
  });

  it("settles short on the same clipped snapshot when the root never arrives, so the keep leg still fails", async () => {
    const exporter = exporterServing([missingOneRoot]);

    const counts = await settleExportedScenarioCounts({
      ...SETTLE,
      wait: noWait,
      readExportFile: exporter.readExportFile,
    });

    // Byte-identical to the first frame of the case above, and it must NOT be
    // rounded up: a root that was never exported is the delivery-order failure
    // the slow leg exists to catch, and settling cannot launder it into a pass.
    expect(counts.get(Scenario.Slow)).toBe(COUNTS.slow - 1);
    expect(counts.get(Scenario.Error)).toBe(COUNTS.errors);

    const traffic = buildScenarioTraces(COUNTS, { baseTimeUnixNano: 0n });
    const names = CollectorTailSamplingPolicy.policyNames;
    const result = evaluateLegs({
      manifest: traffic.manifest,
      metrics: new Map([
        [names.slow, { sampledTrue: COUNTS.slow, sampledFalse: 0 }],
        [names.errorStatus, { sampledTrue: COUNTS.errors, sampledFalse: 0 }],
        [
          names.serverErrors,
          { sampledTrue: COUNTS.serverErrors, sampledFalse: 0 },
        ],
        [
          names.baseline,
          { sampledTrue: 11, sampledFalse: traffic.totalSent - 11 },
        ],
      ]),
      fileRetention: counts,
      totalSent: traffic.totalSent,
    });
    const slowLeg = result.legs.find((leg) => leg.scenario === Scenario.Slow);
    expect(slowLeg?.pass).toBe(false);
    expect(slowLeg?.retainedInFile).toBe(COUNTS.slow - 1);
    // Not a blanket red: the legs whose traces all arrived still pass.
    expect(
      result.legs.find((leg) => leg.scenario === Scenario.Error)?.pass
    ).toBe(true);
  });

  it("refuses the cap-exhausted snapshot when the file never goes quiet", async () => {
    let call = 0;
    const settle = settleExportedScenarioCounts({
      stableReads: 2,
      maxReads: 4,
      wait: noWait,
      // A file that grows on every read: the cap is what bounds the run.
      readExportFile: () => {
        call += 1;
        return jsonl(exported.slice(0, call));
      },
    });

    // A still-moving read is not ground truth. Returning it would let a
    // draining exporter print the same `file N/M MISMATCH` a real
    // delivery-order failure prints (ISS-9913 review).
    await expect(settle).rejects.toBeInstanceOf(InconclusiveVerificationError);
    // Still bounded: the cap is what stops the run, not a hang.
    expect(call).toBe(4);
  });

  it("names the inconclusive run and its last counts, so it cannot read as a policy failure", async () => {
    let call = 0;
    const settle = settleExportedScenarioCounts({
      stableReads: 2,
      maxReads: 3,
      wait: noWait,
      readExportFile: () => {
        call += 1;
        return jsonl(exported.slice(0, call));
      },
    });

    await expect(settle).rejects.toThrow(INCONCLUSIVE_MESSAGE);
    await expect(settle).rejects.toThrow(INCONCLUSIVE_LAST_READ);
    expect(call).toBe(3);
  });

  // A truncated trailing line is what a read taken mid-write looks like, so the
  // two cases below are the same input at different moments: absorbed while the
  // file is still moving, refused once it has settled.
  const truncatedLine = JSON.stringify(exported[0]).slice(0, 40);

  it("refuses a settled read that still holds an unparseable line", async () => {
    const corrupt = `${whole}\n${truncatedLine}`;
    // The corrupt line contributes no spans, so the counts are byte-for-byte
    // those of the clean file — only the parse failure separates them, and
    // skipping it would score its trace as one that never arrived.
    expect(parseExportedScenarioCounts(corrupt)).toEqual(
      parseExportedScenarioCounts(whole)
    );

    const settle = settleExportedScenarioCounts({
      ...SETTLE,
      wait: noWait,
      readExportFile: exporterServing([corrupt]).readExportFile,
    });

    await expect(settle).rejects.toBeInstanceOf(InconclusiveVerificationError);
    await expect(settle).rejects.toThrow(UNPARSEABLE_LINE);
  });

  it("absorbs an unparseable line that the exporter finishes writing", async () => {
    const exporter = exporterServing([`${whole}\n${truncatedLine}`, whole]);

    // Mid-write truncation is normal, not corruption: the settle re-reads, so
    // it must not fail a run the exporter went on to complete.
    const counts = await settleExportedScenarioCounts({
      ...SETTLE,
      wait: noWait,
      readExportFile: exporter.readExportFile,
    });

    expect(counts.get(Scenario.Slow)).toBe(COUNTS.slow);
    expect(exporter.readCount()).toBeGreaterThan(1);
  });
});

const RECORD_PATH = new URL(
  "../collector-verification/VERIFICATION.md",
  import.meta.url
);

/** Render fixture: the prose under test is static, so no leg data is needed. */
const RENDER_ONLY_REPORT: VerificationReport = {
  image: "otel/opentelemetry-collector-contrib:fixture",
  counts: COUNTS,
  totalSent: 0,
  evaluation: { legs: [], pass: true },
  rawMetrics: new Map(),
};

describe("verification record", () => {
  it("emits the retention semantics into the record it generates", () => {
    expect(renderArtifact(RENDER_ONLY_REPORT, "2026-01-01")).toContain(
      RETENTION_SEMANTICS
    );
  });

  // Pins the record's STATIC prose to the generator only. The measured numbers
  // are not pinned here and change only under a real `--write` run.
  it("keeps the committed record's prose in lockstep with the generator", () => {
    expect(readFileSync(RECORD_PATH, "utf-8")).toContain(RETENTION_SEMANTICS);
  });
});
