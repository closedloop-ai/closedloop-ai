import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { CollectorTailSamplingPolicy } from "../collector-tail-sampling-policy";
import {
  parseTailSamplingProcessor,
  renderVerificationCollectorConfig,
} from "../collector-verification/otelcol-config";
import {
  buildScenarioTraces,
  type OtlpTracePayload,
  SCENARIO_ATTRIBUTE_KEY,
  Scenario,
  type ScenarioCounts,
} from "../collector-verification/synthetic-otlp";
import {
  evaluateLegs,
  parseDecisionMetrics,
  parseExportedScenarioCounts,
} from "../collector-verification/tail-sampling-metrics";

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

type SpanShape = {
  traceId: string;
  spanId: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number };
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
};

const spanOf = (payload: OtlpTracePayload): SpanShape => {
  const rs = payload.resourceSpans[0] as Record<string, unknown>;
  const ss = (rs.scopeSpans as Record<string, unknown>[])[0];
  return (ss.spans as SpanShape[])[0];
};

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
  const { payloads, manifest, totalSent } = buildScenarioTraces(COUNTS, {
    baseTimeUnixNano: 1_700_000_000_000_000_000n,
  });

  const bySc = (s: Scenario): SpanShape[] =>
    payloads.map(spanOf).filter((span) => scenarioOf(span) === s);

  it("emits one trace per requested scenario count", () => {
    expect(payloads).toHaveLength(
      COUNTS.errors + COUNTS.serverErrors + COUNTS.slow + COUNTS.baseline
    );
    expect(totalSent).toBe(payloads.length);
    expect(bySc(Scenario.Error)).toHaveLength(COUNTS.errors);
    expect(bySc(Scenario.ServerError)).toHaveLength(COUNTS.serverErrors);
    expect(bySc(Scenario.Slow)).toHaveLength(COUNTS.slow);
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

  it("shapes the slow scenario above the SSOT latency threshold", () => {
    for (const span of bySc(Scenario.Slow)) {
      expect(durationMs(span)).toBeGreaterThan(
        CollectorTailSamplingPolicy.slowLatencyThresholdMs
      );
    }
  });

  it("shapes baseline traces as fast, status-unset, no 5xx", () => {
    for (const span of bySc(Scenario.Baseline)) {
      expect(span.status.code).toBe(0);
      expect(durationMs(span)).toBeLessThan(
        CollectorTailSamplingPolicy.slowLatencyThresholdMs
      );
      expect(
        attr(span, CollectorTailSamplingPolicy.serverErrorAttributeKey)
      ).toBeUndefined();
    }
  });

  it("assigns distinct, high-entropy hex ids to every trace", () => {
    const spans = payloads.map(spanOf);
    const traceIds = spans.map((s) => s.traceId);
    expect(new Set(traceIds).size).toBe(traceIds.length);
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
  const line = (scenario: string, traceId: string): string =>
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
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

  it("counts retained spans per scenario across newline-delimited batches", () => {
    const content = [
      line("error", "aa"),
      line("error", "bb"),
      line("baseline", "cc"),
      "",
      "{ not json",
    ].join("\n");
    const counts = parseExportedScenarioCounts(content);
    expect(counts.get(Scenario.Error)).toBe(2);
    expect(counts.get(Scenario.Baseline)).toBe(1);
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
