import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

const {
  emitCrossOrgProjectAssignees,
  emitIntegrationTokensUnencrypted,
  emitOffVocabularyArtifactStatuses,
  emitUnpricedTokenSessions,
} = await import("./data-invariant-metrics");
const { IntegrationTokenOwner } = await import(
  "./integration-token-plaintext-telemetry"
);

/** The label bound is 64 characters; this is one over. */
const OVERLONG_MODEL = "m".repeat(65);
/** Same bound, exercised on the other gauge's caller-influenced label. */
const OVERLONG_STATUS = "s".repeat(65);

function emittedModels(): Array<{ model: string; sessionCount: number }> {
  const [payload] = mocks.emitTelemetryMetric.mock.calls[0] as [
    { models: Array<{ model: string; sessionCount: number }> },
  ];
  return payload.models;
}

type EmittedStatus = {
  type: string;
  subtype: string | null;
  status: string;
  artifactCount: number;
};

function emittedStatuses(): EmittedStatus[] {
  const [payload] = mocks.emitTelemetryMetric.mock.calls[0] as [
    { statuses: EmittedStatus[] },
  ];
  return payload.statuses;
}

describe("emitUnpricedTokenSessions model label bounding", () => {
  beforeEach(() => {
    mocks.emitTelemetryMetric.mockClear();
  });

  it("emits the gauge total and passes a real model id through untouched", () => {
    emitUnpricedTokenSessions(3, [
      { model: "claude-opus-4-5", sessionCount: 3 },
    ]);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: FilterToken.DataInvariantUnpricedTokenSessions,
        value: 3,
      })
    );
    expect(emittedModels()).toEqual([
      { model: "claude-opus-4-5", sessionCount: 3 },
    ]);
  });

  it("caps an overlong producer-supplied model at the label bound", () => {
    emitUnpricedTokenSessions(1, [{ model: OVERLONG_MODEL, sessionCount: 1 }]);

    const [entry] = emittedModels();
    expect(entry.model).toHaveLength(64);
    expect(entry.sessionCount).toBe(1);
  });

  it("folds characters outside the model-id charset rather than dropping the row", () => {
    emitUnpricedTokenSessions(2, [
      { model: "gpt 5\n(preview)", sessionCount: 2 },
    ]);

    // Still legible as a model name — the gauge exists to name what it could not
    // price, so an unrecognised id must survive to the label.
    expect(emittedModels()).toEqual([
      { model: "gpt_5__preview_", sessionCount: 2 },
    ]);
  });

  it("reports an empty or blank model as unknown", () => {
    emitUnpricedTokenSessions(1, [{ model: "   ", sessionCount: 1 }]);

    expect(emittedModels()).toEqual([{ model: "unknown", sessionCount: 1 }]);
  });
});

/**
 * The audit cron's own tests mock this module, so nothing exercised the second
 * gauge's real payload: a wrong FilterToken, a dropped field, or a regression in
 * status-label bounding would have shipped green. `status` is the only
 * caller-influenced label of the three — `type` and `subtype` are Postgres enums
 * — and it is read straight off the freeform column this gauge audits, so it is
 * the one that has to be bounded and the one that has to stay legible.
 */
describe("emitOffVocabularyArtifactStatuses status label bounding", () => {
  beforeEach(() => {
    mocks.emitTelemetryMetric.mockClear();
  });

  it("emits the gauge total under its own token and passes a real status through untouched", () => {
    emitOffVocabularyArtifactStatuses(4, [
      {
        type: "DOCUMENT",
        subtype: "FEATURE",
        status: "OBSOLETE",
        artifactCount: 4,
      },
    ]);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: FilterToken.DataInvariantOffVocabularyArtifactStatuses,
        value: 4,
      })
    );
    expect(emittedStatuses()).toEqual([
      {
        type: "DOCUMENT",
        subtype: "FEATURE",
        status: "OBSOLETE",
        artifactCount: 4,
      },
    ]);
  });

  it("caps an overlong status at the label bound", () => {
    emitOffVocabularyArtifactStatuses(1, [
      {
        type: "SESSION",
        subtype: null,
        status: OVERLONG_STATUS,
        artifactCount: 1,
      },
    ]);

    const [entry] = emittedStatuses();
    expect(entry.status).toHaveLength(64);
    expect(entry.artifactCount).toBe(1);
  });

  it("folds characters outside the label charset rather than dropping the row", () => {
    emitOffVocabularyArtifactStatuses(2, [
      {
        type: "SESSION",
        subtype: null,
        status: "in review\n(x)",
        artifactCount: 2,
      },
    ]);

    // The gauge exists to NAME the word it could not place, so a corrupt status
    // must survive to the label rather than be erased.
    expect(emittedStatuses()).toEqual([
      {
        type: "SESSION",
        subtype: null,
        status: "in_review__x_",
        artifactCount: 2,
      },
    ]);
  });

  it("reports an empty or blank status as unknown", () => {
    emitOffVocabularyArtifactStatuses(1, [
      { type: "BRANCH", subtype: null, status: "   ", artifactCount: 1 },
    ]);

    expect(emittedStatuses()).toEqual([
      { type: "BRANCH", subtype: null, status: "unknown", artifactCount: 1 },
    ]);
  });

  it("leaves a null subtype null rather than bounding it into a label", () => {
    emitOffVocabularyArtifactStatuses(1, [
      { type: "SESSION", subtype: null, status: "waiting", artifactCount: 1 },
    ]);

    expect(emittedStatuses()[0].subtype).toBeNull();
  });
});

/**
 * ISS-7781: the audit cron's own tests mock this module, so nothing else
 * exercises the gauge's real payload. `owners` is a closed enum set rather
 * than a producer string, so there is no label bounding here to cover.
 */
describe("integration token encryption backlog gauge", () => {
  beforeEach(() => {
    mocks.emitTelemetryMetric.mockClear();
  });

  it("emits the unencrypted count under its own token, owners intact", () => {
    emitIntegrationTokensUnencrypted(5, [
      { owner: IntegrationTokenOwner.Google, unencrypted: 3 },
      { owner: IntegrationTokenOwner.Linear, unencrypted: 2 },
    ]);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: FilterToken.DataInvariantIntegrationTokensUnencrypted,
      value: 5,
      owners: [
        { owner: "google", unencrypted: 3 },
        { owner: "linear", unencrypted: 2 },
      ],
    });
  });

  it("emits the gauge at zero rather than falling silent", () => {
    // A monitor cannot tell a stopped cron from a healthy table if a zero
    // backlog stops emitting, which is the whole reason this is a gauge.
    emitIntegrationTokensUnencrypted(0, []);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: FilterToken.DataInvariantIntegrationTokensUnencrypted,
      value: 0,
      owners: [],
    });
  });
});

describe("emitCrossOrgProjectAssignees", () => {
  beforeEach(() => {
    mocks.emitTelemetryMetric.mockClear();
  });

  it("emits the count and sample ids under its own token", () => {
    emitCrossOrgProjectAssignees(1, ["project-a"]);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: FilterToken.DataInvariantCrossOrgProjectAssignees,
      value: 1,
      sampleIds: ["project-a"],
    });
  });
});
