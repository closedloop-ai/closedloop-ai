/**
 * @file onboarding-parse-progress.test.ts
 * @description ISS-8346 — reading the boot import as the onboarding analysis
 * estimate needs it.
 *
 * Two questions, and the failure modes are opposite. The ACTIVITY decides
 * whether the estimate keeps counting down for a lane that has stopped. The
 * REMAINDER decides whether it says "done"; the case worth the most care is a
 * remainder nobody measured, because the tempting answer there — zero — reads as
 * a finished corpus and the estimate's high-water mark then holds it for the
 * life of the process.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { IngestProgressReport } from "../src/main/collectors/engine/collector-manager-ingest-progress.js";
import {
  PARSE_PROGRESS_UNMEASURED,
  readOnboardingParseProgress,
} from "../src/main/onboarding/onboarding-parse-progress.js";
import { SourceTimeoutStage } from "../src/shared/ingest-quarantine-contract.js";
import { AnalysisParserActivity } from "../src/shared/transcript-analysis-eta-contract.js";

const MIB = 1024 * 1024;

function reportWith(
  overrides: Partial<IngestProgressReport> = {}
): IngestProgressReport {
  return {
    byHarness: [],
    total: 0,
    processed: 0,
    preparing: false,
    drained: false,
    importParked: false,
    complete: false,
    timedOut: false,
    retriesExhausted: false,
    quarantinedCount: 0,
    quarantinedByStage: {
      [SourceTimeoutStage.Parse]: 0,
      [SourceTimeoutStage.Import]: 0,
    },
    ...overrides,
  };
}

describe("onboarding parse-progress reading (ISS-8346)", () => {
  test("a running import passes its measured remainder straight through", () => {
    const reading = readOnboardingParseProgress({
      remainingPendingBytes: 42 * MIB,
      report: reportWith(),
    });

    assert.equal(reading.remainingBytes, 42 * MIB);
    assert.equal(reading.activity, AnalysisParserActivity.Running);
  });

  test("a measured remainder survives every lifecycle flag", () => {
    // The remainder is a fact about the sources; the activity is a fact about
    // the lane. Dropping the first because of the second would withdraw a real
    // number on the exact reports that most need one.
    for (const overrides of [
      { importParked: true },
      { timedOut: true },
      { retriesExhausted: true },
      { complete: true },
    ]) {
      assert.equal(
        readOnboardingParseProgress({
          remainingPendingBytes: 9 * MIB,
          report: reportWith(overrides),
        }).remainingBytes,
        9 * MIB,
        `the remainder survives ${JSON.stringify(overrides)}`
      );
    }
  });

  test("an acknowledged pause is reported as paused, not as progress", () => {
    const reading = readOnboardingParseProgress({
      remainingPendingBytes: 1 * MIB,
      report: reportWith({ importParked: true }),
    });

    assert.equal(reading.activity, AnalysisParserActivity.Paused);
  });

  test("a timed-out or retry-exhausted import is reported as failed", () => {
    assert.equal(
      readOnboardingParseProgress({
        remainingPendingBytes: 0,
        report: reportWith({ timedOut: true }),
      }).activity,
      AnalysisParserActivity.Failed
    );
    assert.equal(
      readOnboardingParseProgress({
        remainingPendingBytes: 0,
        report: reportWith({ retriesExhausted: true }),
      }).activity,
      AnalysisParserActivity.Failed
    );
  });

  test("a degraded terminal outranks a pause", () => {
    // Both can hold at once and neither is the negation of the other. A lane
    // that spent its re-drive budget is not one a user can resume, so reporting
    // it as merely paused invites the estimate to wait for movement that is not
    // coming.
    const reading = readOnboardingParseProgress({
      remainingPendingBytes: 3 * MIB,
      report: reportWith({ importParked: true, retriesExhausted: true }),
    });

    assert.equal(reading.activity, AnalysisParserActivity.Failed);
  });

  test("nothing measured while the import is still running states no number", () => {
    const reading = readOnboardingParseProgress({
      remainingPendingBytes: null,
      report: reportWith(),
    });

    assert.equal(
      reading.remainingBytes,
      null,
      "the collectors have not opened a pass yet; zero here reads as finished"
    );
  });

  test("nothing measured while a source scan runs states no number", () => {
    const reading = readOnboardingParseProgress({
      remainingPendingBytes: null,
      report: reportWith({ complete: true, preparing: true }),
    });

    assert.equal(reading.remainingBytes, null);
  });

  test("nothing measured after a COMPLETED boot import means nothing to parse", () => {
    // The already-imported machine: no source is pending, so no pass is opened
    // and nothing is ever measured. Only the completed boot import distinguishes
    // that from the collectors not having started.
    const reading = readOnboardingParseProgress({
      remainingPendingBytes: null,
      report: reportWith({ complete: true }),
    });

    assert.equal(reading.remainingBytes, 0);
  });

  test("a degraded boot import is not a completed one", () => {
    for (const overrides of [
      { timedOut: true },
      { retriesExhausted: true },
      { importParked: true },
    ]) {
      assert.equal(
        readOnboardingParseProgress({
          remainingPendingBytes: null,
          report: reportWith(overrides),
        }).remainingBytes,
        null,
        `${JSON.stringify(overrides)} must not be read as nothing-to-parse`
      );
    }
  });

  test("no runtime at all states no number and accuses nothing", () => {
    // Before the dashboard runtime is composed there is nobody to ask. The
    // estimate withdraws on the missing remainder, so the activity decides
    // nothing here — and calling a lane that has not started `failed` would.
    assert.equal(PARSE_PROGRESS_UNMEASURED.remainingBytes, null);
    assert.equal(
      PARSE_PROGRESS_UNMEASURED.activity,
      AnalysisParserActivity.Running
    );
  });
});
