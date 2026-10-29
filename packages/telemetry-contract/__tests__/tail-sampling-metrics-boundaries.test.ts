import { describe, expect, it } from "vitest";
import { CollectorTailSamplingPolicy } from "../collector-tail-sampling-policy";
import {
  SCENARIO_ATTRIBUTE_KEY,
  Scenario,
  type ScenarioManifestEntry,
} from "../collector-verification/synthetic-otlp";
import {
  evaluateLegs,
  parseDecisionMetrics,
  parseExportedScenarioCounts,
} from "../collector-verification/tail-sampling-metrics";

// ISS-10129: the file exporter's JSONL and the collector's Prometheus text are
// both parse boundaries, so malformed shapes ARE reachable at runtime and each
// skip path is pinned here. The sibling collector-verification.unit.test.ts
// covers the well-formed contract and is already past the file-size smell.

const names = CollectorTailSamplingPolicy.policyNames;

const METRIC = "otelcol_processor_tail_sampling_count_traces_sampled";

/** A keep leg whose counts could not be read scores 0/N against both sources. */
const KEEP_LEG_BOTH_MISSING =
  /^expected 100% retention via keep-error-status: file 0\/3 \(MISMATCH\), decision sampled=true 0\/3 \(MISMATCH\)$/;
/** A baseline leg that sent nothing renders a 0.0% fraction, not NaN. */
const BASELINE_ZERO_SENT =
  /^expected a strict sampled subset \(target 10%\): file 0\/0 \(0\.0%, OUT OF BAND\), decision sampled=true 0\/50 \(OUT OF BAND\)$/;
/** A retained count with nothing sent is out of band on the sent guard alone. */
const BASELINE_RETAINED_WITHOUT_SENT =
  /^expected a strict sampled subset \(target 10%\): file 1\/0 \(0\.0%, OUT OF BAND\), decision sampled=true 5\/50 \(ok\)$/;
/** The cutoff is a strict `<`, so retaining exactly half fails on the file arm alone. */
const BASELINE_EXACTLY_HALF =
  /^expected a strict sampled subset \(target 10%\): file 50\/100 \(50\.0%, OUT OF BAND\), decision sampled=true 11\/109 \(ok\)$/;

const errorScenarioAttribute = {
  key: SCENARIO_ATTRIBUTE_KEY,
  value: { stringValue: Scenario.Error },
};

const exportLine = (span: unknown): string =>
  JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] });

const wellFormedSpan = (traceId: string) => ({
  traceId,
  name: `synthetic-${Scenario.Error}`,
  attributes: [errorScenarioAttribute],
});

describe("decision metrics parser boundaries", () => {
  it("skips a decision line that carries no policy label", () => {
    expect(parseDecisionMetrics(`${METRIC}{sampled="true"} 7`).size).toBe(0);
  });

  it("skips a decision line that carries no sampled label", () => {
    expect(parseDecisionMetrics(`${METRIC}{policy="baseline"} 7`).size).toBe(0);
  });

  it("skips a decision line whose value is not a finite number", () => {
    // `e` alone satisfies the metric regex's value class but is NaN.
    const text = [
      `${METRIC}{policy="baseline",sampled="true"} e`,
      `${METRIC}{policy="baseline",sampled="true"} 4`,
    ].join("\n");
    expect(parseDecisionMetrics(text).get("baseline")).toEqual({
      sampledTrue: 4,
      sampledFalse: 0,
    });
  });

  it("rounds a fractional value and adds a negative one as-is", () => {
    // Pins current behavior; looks odd because the only value guard is
    // Number.isFinite, so `0.6` scores a decision and `-1` subtracts one.
    const text = [
      `${METRIC}{policy="baseline",sampled="true"} 0.6`,
      `${METRIC}{policy="baseline",sampled="false"} -1`,
    ].join("\n");
    expect(parseDecisionMetrics(text).get("baseline")).toEqual({
      sampledTrue: 1,
      sampledFalse: -1,
    });
  });

  it("records a policy at zero when its sampled label is neither true nor false", () => {
    // Pins current behavior; looks odd because a third label value leaves the
    // policy present but counted at zero instead of being skipped.
    const metrics = parseDecisionMetrics(
      `${METRIC}{policy="baseline",sampled="maybe"} 9`
    );
    expect(metrics.size).toBe(1);
    expect(metrics.get("baseline")).toEqual({
      sampledTrue: 0,
      sampledFalse: 0,
    });
  });
});

describe("exported scenario counter boundaries", () => {
  it("counts nothing from a JSON line that has no spans array to walk", () => {
    const content = [
      "{}",
      JSON.stringify({ resourceSpans: "not-an-array" }),
      JSON.stringify({ resourceSpans: [{ scopeSpans: [{}] }] }),
    ].join("\n");
    expect(parseExportedScenarioCounts(content).size).toBe(0);
  });

  it("skips a span entry that is not an object", () => {
    const content = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [{ spans: [null, "span", 7, wellFormedSpan("aa")] }],
        },
      ],
    });
    const counts = parseExportedScenarioCounts(content);
    expect(counts.size).toBe(1);
    expect(counts.get(Scenario.Error)).toBe(1);
  });

  it("skips an attribute that is not an object", () => {
    const content = exportLine({
      traceId: "aa",
      name: "x",
      attributes: ["test.scenario=error", null, errorScenarioAttribute],
    });
    expect(parseExportedScenarioCounts(content).get(Scenario.Error)).toBe(1);
  });

  it("ignores a span whose attributes never name the scenario key", () => {
    const content = exportLine({
      traceId: "aa",
      name: "x",
      attributes: [{ key: "service.name", value: { stringValue: "error" } }],
    });
    expect(parseExportedScenarioCounts(content).size).toBe(0);
  });

  it("ignores a scenario attribute whose value is not a stringValue", () => {
    const content = exportLine({
      traceId: "aa",
      name: "x",
      attributes: [
        { key: SCENARIO_ATTRIBUTE_KEY, value: { stringValue: 5 } },
        { key: SCENARIO_ATTRIBUTE_KEY, value: { intValue: "1" } },
        { key: SCENARIO_ATTRIBUTE_KEY, value: null },
      ],
    });
    expect(parseExportedScenarioCounts(content).size).toBe(0);
  });

  it("counts a scenario string the manifest never names under that string", () => {
    // Pins current behavior; looks odd because `scenarioOf` only checks for a
    // string, so an unknown scenario escapes the parse as a map key.
    const content = exportLine({
      traceId: "aa",
      name: "x",
      attributes: [
        {
          key: SCENARIO_ATTRIBUTE_KEY,
          value: { stringValue: "not-a-scenario" },
        },
      ],
    });
    expect(Array.from(parseExportedScenarioCounts(content))).toEqual([
      ["not-a-scenario", 1],
    ]);
  });

  it("ignores a scenario span whose traceId or name is not a string", () => {
    const content = [
      exportLine({
        traceId: 1,
        name: "x",
        attributes: [errorScenarioAttribute],
      }),
      exportLine({
        traceId: "bb",
        name: undefined,
        attributes: [errorScenarioAttribute],
      }),
      exportLine(wellFormedSpan("cc")),
    ].join("\n");
    const counts = parseExportedScenarioCounts(content);
    expect(counts.size).toBe(1);
    expect(counts.get(Scenario.Error)).toBe(1);
  });
});

describe("leg evaluation boundaries", () => {
  const keepLeg: ScenarioManifestEntry = {
    scenario: Scenario.Error,
    sent: 3,
    policyName: names.errorStatus,
    expectation: { kind: "always" },
  };
  const baselineLeg = (sent: number): ScenarioManifestEntry => ({
    scenario: Scenario.Baseline,
    sent,
    policyName: names.baseline,
    expectation: {
      kind: "sampled",
      samplingPercentage:
        CollectorTailSamplingPolicy.baselineSamplingPercentage,
    },
  });

  it("scores a keep leg absent from both the file and the metric as 0 and fails it", () => {
    const result = evaluateLegs({
      manifest: [keepLeg],
      metrics: new Map(),
      fileRetention: new Map(),
      totalSent: 3,
    });
    expect(result.pass).toBe(false);
    expect(result.legs).toEqual([
      {
        scenario: Scenario.Error,
        policyName: names.errorStatus,
        sent: 3,
        retainedInFile: 0,
        decisionSampledTrue: 0,
        pass: false,
        detail: expect.stringMatching(KEEP_LEG_BOTH_MISSING),
      },
    ]);
  });

  it("fails a baseline leg that sent zero traces without dividing by zero", () => {
    const result = evaluateLegs({
      manifest: [baselineLeg(0)],
      metrics: new Map([
        [names.baseline, { sampledTrue: 0, sampledFalse: 50 }],
      ]),
      fileRetention: new Map([[Scenario.Baseline, 0]]),
      totalSent: 50,
    });
    const [leg] = result.legs;
    expect(result.pass).toBe(false);
    expect(leg?.pass).toBe(false);
    expect(leg?.retainedInFile).toBe(0);
    expect(leg?.detail).toMatch(BASELINE_ZERO_SENT);
  });

  it("fails a baseline leg that retained a trace while sending none", () => {
    const result = evaluateLegs({
      manifest: [baselineLeg(0)],
      metrics: new Map([
        [names.baseline, { sampledTrue: 5, sampledFalse: 45 }],
      ]),
      fileRetention: new Map([[Scenario.Baseline, 1]]),
      totalSent: 50,
    });
    const [leg] = result.legs;
    expect(leg?.pass).toBe(false);
    expect(leg?.retainedInFile).toBe(1);
    expect(leg?.detail).toMatch(BASELINE_RETAINED_WITHOUT_SENT);
  });

  it("fails a baseline leg on the file arm alone when it retains exactly half", () => {
    const result = evaluateLegs({
      manifest: [baselineLeg(100)],
      metrics: new Map([
        [names.baseline, { sampledTrue: 11, sampledFalse: 98 }],
      ]),
      fileRetention: new Map([[Scenario.Baseline, 50]]),
      totalSent: 109,
    });
    const [leg] = result.legs;
    expect(leg?.pass).toBe(false);
    expect(leg?.retainedInFile).toBe(50);
    expect(leg?.decisionSampledTrue).toBe(11);
    expect(leg?.detail).toMatch(BASELINE_EXACTLY_HALF);
  });
});
