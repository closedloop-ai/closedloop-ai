import { Harness } from "@repo/api/src/types/agent-component";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveTranscriptDisposition,
  MAIN_FILE_KEY,
} from "../transcript-availability";
import {
  isMixedEvidenceCoverage,
  reportSessionEvidenceCoverage,
  resetSessionEvidenceEmissionBudget,
  resolveSessionEvidenceCoverage,
  SESSION_EVIDENCE_METADATA_ONLY_EVENT,
  type SessionEvidenceInput,
  UNRECOGNIZED_EVIDENCE_HARNESS,
} from "./session-evidence-coverage";

const warn = vi.fn();
vi.mock("@repo/observability/log", () => ({
  log: {
    warn: (event: string, fields: unknown) => warn(event, fields),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const CONTEXT = {
  organizationId: "org_7427",
  sessionId: "019f8abb-46ad-711e-a54f-14c9905dfc3a",
  harness: "codex",
};

function input(overrides: Partial<SessionEvidenceInput>): SessionEvidenceInput {
  return {
    transcriptDisposition: TranscriptDisposition.FailedPermanent,
    derivedEventCount: 0,
    derivedEventsTruncated: false,
    readableSubagentTranscriptCount: 0,
    hasMetricRollup: false,
    hasSessionSpan: false,
    ...overrides,
  };
}

describe("resolveSessionEvidenceCoverage", () => {
  it("classifies a terminally absent main archive with NO derived rows as noEvidence", () => {
    expect(resolveSessionEvidenceCoverage(input({}))).toBe(
      SessionEvidenceCoverage.NoEvidence
    );
  });

  it("classifies a terminally absent main archive with valid independent metadata as metadataOnly", () => {
    expect(
      resolveSessionEvidenceCoverage(input({ hasMetricRollup: true }))
    ).toBe(SessionEvidenceCoverage.MetadataOnly);
  });

  /**
   * Isolated from the rollup and subagent clauses on purpose: all three are
   * independent OR arms, so a case that satisfies two of them proves nothing
   * about the third.
   */
  it("classifies a terminally absent main archive with only synced event rows as metadataOnly", () => {
    expect(
      resolveSessionEvidenceCoverage(input({ derivedEventCount: 216 }))
    ).toBe(SessionEvidenceCoverage.MetadataOnly);
  });

  it("classifies a terminally absent main archive with subagent archives as metadataOnly", () => {
    expect(
      resolveSessionEvidenceCoverage(
        input({ readableSubagentTranscriptCount: 286 })
      )
    ).toBe(SessionEvidenceCoverage.MetadataOnly);
  });

  /**
   * whitlockk, #5584: the session span is metadata-lane evidence on the same
   * footing as the rollup. `toSessionListItem` serves `startedAt`/`endedAt` and
   * the detail's Duration row renders elapsed time from them, so a terminally
   * absent main with ZERO tokens and ZERO events is still a read where the user
   * is shown a metadata-lane number the dead archive never backed. Counting it
   * as `noEvidence` undercounted exactly the cohort this fold measures.
   *
   * Deliberately isolated from every other OR arm — this case satisfies the
   * span clause and nothing else, so it cannot pass on a sibling's back.
   */
  it("classifies a terminally absent main archive with only a session span as metadataOnly", () => {
    const coverage = resolveSessionEvidenceCoverage(
      input({
        derivedEventCount: 0,
        readableSubagentTranscriptCount: 0,
        hasMetricRollup: false,
        hasSessionSpan: true,
      })
    );

    expect(coverage).toBe(SessionEvidenceCoverage.MetadataOnly);
    expect(coverage).not.toBe(SessionEvidenceCoverage.NoEvidence);
  });

  it("classifies a retryable upload failure as pending, not a terminal verdict", () => {
    expect(
      resolveSessionEvidenceCoverage(
        input({
          transcriptDisposition: TranscriptDisposition.FailedTransient,
          hasMetricRollup: true,
        })
      )
    ).toBe(SessionEvidenceCoverage.Pending);
  });

  it("moves an environmentally-abandoned transcript OUT of the mixed-evidence cohort into pending (ISS-9884 §8)", () => {
    // The cohort move §8 names, driven from the reason rather than restated at
    // the disposition: the same session with the same independent metadata was
    // `metadataOnly` while the reason derived `failedPermanent`, and is now
    // `pending` because the transcript may still arrive. `retries_exhausted` is
    // the control — an un-upgraded desktop's label must stay in the cohort.
    function coverageForReason(reason: TranscriptSkipReason) {
      return resolveSessionEvidenceCoverage(
        input({
          transcriptDisposition: deriveTranscriptDisposition([
            {
              fileKey: MAIN_FILE_KEY,
              availability: TranscriptAvailability.PermanentlyUnavailable,
              uploadedAt: null,
              permanentFailureReason: reason,
            },
          ]),
          hasMetricRollup: true,
        })
      );
    }

    expect(coverageForReason(TranscriptSkipReason.EnvironmentUnavailable)).toBe(
      SessionEvidenceCoverage.Pending
    );
    expect(coverageForReason(TranscriptSkipReason.RetriesExhausted)).toBe(
      SessionEvidenceCoverage.MetadataOnly
    );
  });

  it("classifies stale/partial archived bytes as mainReadable, not metadataOnly", () => {
    expect(
      resolveSessionEvidenceCoverage(
        input({
          transcriptDisposition: TranscriptDisposition.Stale,
          hasMetricRollup: true,
        })
      )
    ).toBe(SessionEvidenceCoverage.MainReadable);
  });

  /**
   * The collapse under repair: a reader that cannot tell these apart reads a
   * partial-coverage total as a measured one, or a measured zero as missing
   * data. All three are reachable with an identical rendered `0`.
   */
  it("keeps unavailable, a true zero, and a partial-coverage total as three distinct states", () => {
    const trueZero = resolveSessionEvidenceCoverage(
      input({ transcriptDisposition: TranscriptDisposition.Synced })
    );
    const unavailable = resolveSessionEvidenceCoverage(input({}));
    const partialCoverage = resolveSessionEvidenceCoverage(
      input({ derivedEventCount: 216, hasMetricRollup: true })
    );

    expect(trueZero).toBe(SessionEvidenceCoverage.MainReadable);
    expect(unavailable).toBe(SessionEvidenceCoverage.NoEvidence);
    expect(partialCoverage).toBe(SessionEvidenceCoverage.MetadataOnly);
    expect(new Set([trueZero, unavailable, partialCoverage]).size).toBe(3);
  });

  it("treats a session that never expected a transcript as notApplicable", () => {
    expect(
      resolveSessionEvidenceCoverage(
        input({
          transcriptDisposition: TranscriptDisposition.NeverExpected,
          hasMetricRollup: true,
        })
      )
    ).toBe(SessionEvidenceCoverage.NotApplicable);
  });

  it("marks only metadataOnly as the mixed cohort", () => {
    expect(isMixedEvidenceCoverage(SessionEvidenceCoverage.MetadataOnly)).toBe(
      true
    );
    for (const coverage of [
      SessionEvidenceCoverage.MainReadable,
      SessionEvidenceCoverage.Pending,
      SessionEvidenceCoverage.NoEvidence,
      SessionEvidenceCoverage.NotApplicable,
    ]) {
      expect(isMixedEvidenceCoverage(coverage)).toBe(false);
    }
  });
});

const METADATA_ONLY_EVENT_WIRE_NAME = "agent_session_evidence_metadata_only";

describe("reportSessionEvidenceCoverage", () => {
  beforeEach(() => {
    warn.mockClear();
    resetSessionEvidenceEmissionBudget();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSessionEvidenceEmissionBudget();
  });

  it("writes the structured log with the dimensions needed to identify the lane", () => {
    const evidence = input({
      derivedEventCount: 216,
      readableSubagentTranscriptCount: 286,
      hasMetricRollup: true,
    });

    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      CONTEXT,
      evidence
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(SESSION_EVIDENCE_METADATA_ONLY_EVENT, {
      organizationId: "org_7427",
      sessionId: "019f8abb-46ad-711e-a54f-14c9905dfc3a",
      harness: "codex",
      coverage: "metadataOnly",
      transcriptDisposition: "failedPermanent",
      derivedEventCount: 216,
      derivedEventsTruncated: false,
      readableSubagentTranscriptCount: 286,
      hasMetricRollup: true,
      hasSessionSpan: false,
    });
  });

  it("logs under the wire name the Datadog monitor queries", () => {
    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      CONTEXT,
      input({ hasMetricRollup: true })
    );

    expect(warn).toHaveBeenCalledWith(
      METADATA_ONLY_EVENT_WIRE_NAME,
      expect.any(Object)
    );
  });

  it("stays silent for every coverage state that is not the mixed cohort", () => {
    for (const coverage of [
      SessionEvidenceCoverage.MainReadable,
      SessionEvidenceCoverage.Pending,
      SessionEvidenceCoverage.NoEvidence,
      SessionEvidenceCoverage.NotApplicable,
    ]) {
      reportSessionEvidenceCoverage(coverage, CONTEXT, input({}));
    }

    expect(warn).not.toHaveBeenCalled();
  });

  it("charges one emission per org per window, then emits again once it lapses", () => {
    const evidence = input({ hasMetricRollup: true });

    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      CONTEXT,
      evidence
    );
    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      { ...CONTEXT, sessionId: "a-different-session" },
      evidence
    );
    expect(warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-08-21T00:01:00.001Z"));
    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      CONTEXT,
      evidence
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  /**
   * whitlockk, #5584: `SessionDetail.harness` is free-text sync input — a bare
   * `String` column the ingest schema trims but never caps or enumerates — so a
   * bad or version-skewed producer can push arbitrary high-cardinality text
   * straight into this payload. It must be folded to the closed
   * {@link Harness} set before it is recorded.
   */
  it("records an unrecognized harness as the bounded unknown value, never the raw text", () => {
    const hostileHarness = `claude-${"x".repeat(4096)}-\u0000-${Date.now()}`;

    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      { ...CONTEXT, harness: hostileHarness },
      input({ hasMetricRollup: true })
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const [, fields] = warn.mock.calls[0];
    expect(fields.harness).toBe(UNRECOGNIZED_EVIDENCE_HARNESS);
    expect(fields.harness).not.toContain("x");
  });

  /**
   * A prototype-polluting key is untrusted-input-as-lookup-key, the exact case
   * a bare `{}` membership table answers truthily.
   */
  it("does not treat an inherited Object member as a recognized harness", () => {
    for (const key of ["__proto__", "constructor", "toString"]) {
      warn.mockClear();
      resetSessionEvidenceEmissionBudget();

      reportSessionEvidenceCoverage(
        SessionEvidenceCoverage.MetadataOnly,
        { ...CONTEXT, harness: key },
        input({ hasMetricRollup: true })
      );

      const [, fields] = warn.mock.calls[0];
      expect(fields.harness).toBe(UNRECOGNIZED_EVIDENCE_HARNESS);
    }
  });

  it("passes a canonical harness through unchanged", () => {
    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      { ...CONTEXT, harness: `  ${Harness.Opencode}  ` },
      input({ hasMetricRollup: true })
    );

    const [, fields] = warn.mock.calls[0];
    expect(fields.harness).toBe(Harness.Opencode);
  });

  /**
   * tamsinb, #5584: the budget key must actually carry the disposition its
   * docstring claims. It is redundant today — `metadataOnly` is reachable from
   * only the `failedPermanent` arm — but a new {@link TranscriptDisposition}
   * hand-classified as `metadataOnly` at the exhaustive switch would otherwise
   * share `failedPermanent`'s bucket and be throttled away unseen.
   */
  it("gives each transcript disposition its own budget within one org", () => {
    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      CONTEXT,
      input({
        hasMetricRollup: true,
        transcriptDisposition: TranscriptDisposition.FailedPermanent,
      })
    );
    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      CONTEXT,
      input({
        hasMetricRollup: true,
        transcriptDisposition: TranscriptDisposition.FailedTransient,
      })
    );

    expect(warn).toHaveBeenCalledTimes(2);
    expect(
      warn.mock.calls.map((call) => call[1].transcriptDisposition)
    ).toEqual([
      TranscriptDisposition.FailedPermanent,
      TranscriptDisposition.FailedTransient,
    ]);
  });

  it("does not let one organization spend another's budget", () => {
    const evidence = input({ hasMetricRollup: true });

    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      CONTEXT,
      evidence
    );
    reportSessionEvidenceCoverage(
      SessionEvidenceCoverage.MetadataOnly,
      { ...CONTEXT, organizationId: "org_other" },
      evidence
    );

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
