import { Harness } from "@repo/api/src/types/agent-component";
import { isTranscriptBlobBehind } from "@repo/api/src/types/agent-session-cloud-sync-reconcile";
import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { log } from "@repo/observability/log";
import { FixedWindowRateLimiter } from "@/lib/fixed-window-rate-limiter";

/**
 * ISS-7427: the FOLD half — which transcript disposition, combined with which
 * independent evidence, means what.
 *
 * The five-state vocabulary itself moved to
 * `@repo/api/src/types/session-evidence-coverage-constants` when the verdict
 * became a wire value the reader is shown; see that module for why the split
 * falls here. This module keeps the read-path decision and the observability
 * breadcrumb, neither of which belongs on a client.
 */

export type SessionEvidenceInput = {
  transcriptDisposition: TranscriptDisposition;
  /**
   * Trace rows the detail read projected from synced Postgres rows — the SAME
   * quantity the reader sees in the Session Trace header, so the log and the
   * screen name one number.
   */
  derivedEventCount: number;
  /**
   * Whether the underlying event read hit its row ceiling. Without it a capped
   * read publishes a saturated count as if it were a measured one.
   */
  derivedEventsTruncated: boolean;
  /** Subagent transcript files whose archived bytes are readable. */
  readableSubagentTranscriptCount: number;
  /**
   * Whether the metadata lane carries a non-zero cost or token rollup. Separate
   * from the event count because the two are written by different slices of the
   * sync payload: a session can carry a rollup with zero synced event rows.
   */
  hasMetricRollup: boolean;
  /**
   * Whether the metadata lane wrote a session span — the `startedAt`/`endedAt`
   * pair `toSessionListItem` serves and the detail's Duration row renders from
   * (`resolveSessionDetailDurationWindow`).
   *
   * This is evidence on the SAME footing as the rollup, and it is the reason a
   * terminally-absent main with zero tokens and zero events is still the mixed
   * cohort rather than {@link SessionEvidenceCoverage.NoEvidence}: the reader is
   * looking at a rendered elapsed time drawn from the metadata lane, with
   * nothing saying the archive behind it is gone. Omitting it undercounted
   * exactly the population this instrument exists to measure (whitlockk, #5584).
   */
  hasSessionSpan: boolean;
};

/**
 * Fold a session's transcript disposition plus its independently-sourced
 * evidence into one coverage verdict.
 *
 * WHICH dispositions mean "still coming" is NOT re-decided here: it is read
 * from {@link isTranscriptBlobBehind}, the exported SSOT the Sessions
 * sync-status badges already key on. Re-stating that membership is how the
 * detail read and the list badge would come to disagree about one session. This
 * fold adds exactly one thing disposition alone cannot express: whether
 * anything independent survives a terminal absence.
 *
 * An exhaustive switch keeps the rest honest — a new
 * {@link TranscriptDisposition} fails typecheck here until it is classified.
 */
export function resolveSessionEvidenceCoverage(
  input: SessionEvidenceInput
): SessionEvidenceCoverage {
  if (isTranscriptBlobBehind(input.transcriptDisposition)) {
    return SessionEvidenceCoverage.Pending;
  }
  switch (input.transcriptDisposition) {
    case TranscriptDisposition.Synced:
    case TranscriptDisposition.Stale:
      return SessionEvidenceCoverage.MainReadable;
    case TranscriptDisposition.NeverExpected:
      return SessionEvidenceCoverage.NotApplicable;
    case TranscriptDisposition.FailedPermanent:
      return hasIndependentEvidence(input)
        ? SessionEvidenceCoverage.MetadataOnly
        : SessionEvidenceCoverage.NoEvidence;
    // Already returned above; kept so a new disposition still fails typecheck
    // here rather than falling through to whatever the predicate answers.
    case TranscriptDisposition.Syncing:
    case TranscriptDisposition.FailedTransient:
      return SessionEvidenceCoverage.Pending;
    default: {
      const exhaustive: never = input.transcriptDisposition;
      return exhaustive;
    }
  }
}

/** The cohort predicate: the one coverage state that presents undisclosed data. */
export function isMixedEvidenceCoverage(
  coverage: SessionEvidenceCoverage
): boolean {
  return coverage === SessionEvidenceCoverage.MetadataOnly;
}

export const SESSION_EVIDENCE_METADATA_ONLY_EVENT =
  "agent_session_evidence_metadata_only";

/**
 * One emission per `(coverage, transcript disposition, organization)` per
 * window.
 */
export const SESSION_EVIDENCE_EMISSION_WINDOW_MS = 60_000;

/** Distinct keys tracked before the limiter evicts in insertion order. */
export const SESSION_EVIDENCE_EMISSION_MAX_ENTRIES = 10_000;

/**
 * Recorded when a session's `harness` is not a member of the canonical
 * {@link Harness} contract. Matches `SessionDetail.harness`'s own column
 * default, so an unset harness and an unrecognized one read identically rather
 * than inventing a second spelling for "we don't know".
 */
export const UNRECOGNIZED_EVIDENCE_HARNESS = "unknown";

/**
 * The closed set this payload may report for `harness`.
 *
 * `SessionDetail.harness` is free-text sync input: the column is a bare
 * `String`, and the ingest schema trims it without capping or enumerating it, so
 * a version-skewed or malfunctioning producer can put arbitrary text there. Left
 * raw, that text becomes unbounded cardinality on a telemetry payload (whitlockk,
 * #5584).
 *
 * Derived from {@link Harness} rather than re-declaring its literals, so a
 * harness added to the canonical contract becomes recordable here automatically
 * instead of silently degrading to `unknown` (SSOT: `agent-component.ts`).
 */
export type SessionEvidenceHarness =
  | Harness
  | typeof UNRECOGNIZED_EVIDENCE_HARNESS;

export type SessionEvidenceContext = {
  organizationId: string;
  sessionId: string;
  harness: string;
};

/**
 * Write one structured log line when a detail read served the mixed cohort, or
 * stay silent for every other coverage state. What alerts on it, and where that
 * is declared: {@link SESSION_EVIDENCE_METADATA_ONLY_EVENT} and ISS-7517.
 *
 * The absence is persisted and never self-heals, so it is re-classified on
 * every detail read, including the branch merged-trace fan-out that hydrates
 * many sessions per request. Emission is bounded by a fixed-window budget keyed
 * on `(coverage, transcriptDisposition, organizationId)` for the reason the
 * sibling read-path emitter documents: a session-keyed budget is defeated by
 * exactly the traffic it bounds, because a caller cycling more distinct
 * sessions than the entry cap evicts its own key before reuse. All three key
 * segments are stable under that churn.
 *
 * `transcriptDisposition` is in the key even though it is REDUNDANT TODAY
 * (tamsinb, #5584): `metadataOnly` is reachable from exactly one arm of
 * {@link resolveSessionEvidenceCoverage}'s switch, so a mixed-cohort emission
 * currently implies `failedPermanent` and the segment is a constant prefix. It
 * is keyed anyway because a NEW {@link TranscriptDisposition} must be
 * hand-classified at that exhaustive switch, and one mapped to `metadataOnly`
 * would otherwise share `failedPermanent`'s bucket and be silently throttled
 * away — a suppression nobody would think to look for. Keying it costs nothing
 * now and makes the second disposition observable the day it exists.
 *
 * The budget is per org, not per session, so a suppressed emission inside a
 * window may be a DIFFERENT affected session rather than a repeat read of the
 * same one. That is the deliberate trade: this event answers "is this org
 * serving the mixed state", and the per-session population is the query on
 * ISS-7427, not this log.
 */
export function reportSessionEvidenceCoverage(
  coverage: SessionEvidenceCoverage,
  context: SessionEvidenceContext,
  input: SessionEvidenceInput
): void {
  if (!isMixedEvidenceCoverage(coverage)) {
    return;
  }
  if (
    !emissionBudget.attempt(
      [coverage, input.transcriptDisposition, context.organizationId].join(
        EMISSION_KEY_DELIMITER
      ),
      Date.now()
    )
  ) {
    return;
  }
  log.warn(SESSION_EVIDENCE_METADATA_ONLY_EVENT, {
    organizationId: context.organizationId,
    sessionId: context.sessionId,
    harness: classifyEvidenceHarness(context.harness),
    coverage,
    transcriptDisposition: input.transcriptDisposition,
    derivedEventCount: input.derivedEventCount,
    derivedEventsTruncated: input.derivedEventsTruncated,
    readableSubagentTranscriptCount: input.readableSubagentTranscriptCount,
    hasMetricRollup: input.hasMetricRollup,
    hasSessionSpan: input.hasSessionSpan,
  });
}

/**
 * Fold a raw `SessionDetail.harness` string into {@link SessionEvidenceHarness}.
 *
 * Membership is tested against {@link Harness}'s own values, so the payload's
 * cardinality is bounded by the canonical contract no matter what a producer
 * writes to the column. An unrecognized value is RECORDED as
 * {@link UNRECOGNIZED_EVIDENCE_HARNESS} rather than dropped: a version-skewed
 * producer sending a harness this build has never heard of is a fact worth
 * keeping, and silently omitting the field would make it indistinguishable from
 * a well-formed read.
 *
 * Iterates the canonical values instead of indexing a lookup object because the
 * key is untrusted input — a bare `{}` lookup on `__proto__`/`constructor`
 * returns a truthy inherited member (root `AGENTS.md`).
 */
function classifyEvidenceHarness(harness: string): SessionEvidenceHarness {
  const trimmed = harness.trim();
  for (const known of RECORDED_HARNESSES) {
    if (known === trimmed) {
      return known;
    }
  }
  return UNRECOGNIZED_EVIDENCE_HARNESS;
}

/**
 * Reset the process-local budget. For tests, which must not inherit another
 * spec's spent window.
 */
export function resetSessionEvidenceEmissionBudget(): void {
  emissionBudget.clear();
}

function hasIndependentEvidence(input: SessionEvidenceInput): boolean {
  return (
    input.derivedEventCount > 0 ||
    input.readableSubagentTranscriptCount > 0 ||
    input.hasMetricRollup ||
    input.hasSessionSpan
  );
}

/**
 * Process-local emission budget, one event per key per window. Best-effort and
 * ephemeral per serverless instance, exactly like the sibling limiters in
 * `apps/api/lib` — reused rather than reimplemented so this does not fork a
 * second copy of the fixed-window mechanism.
 */
const emissionBudget = new FixedWindowRateLimiter({
  maxEntries: SESSION_EVIDENCE_EMISSION_MAX_ENTRIES,
  maxRequests: 1,
  windowMs: SESSION_EVIDENCE_EMISSION_WINDOW_MS,
});

/**
 * Separates the two fixed-cardinality signature segments from the organization
 * id, IN THAT ORDER. Both `coverage` and `transcriptDisposition` are drawn from
 * closed sets, so the segments before the first two delimiters are unambiguous
 * no matter what an organization id contains, and the id — the only untrusted
 * segment — is last, where a delimiter it happens to contain can only ever
 * lengthen its own tail. Putting the id first would let a crafted value straddle
 * the delimiter and charge another organization's budget.
 */
const EMISSION_KEY_DELIMITER = "|";

/**
 * The canonical harness values, read from {@link Harness} so this module never
 * holds a second copy of the set.
 */
const RECORDED_HARNESSES: readonly Harness[] = Object.values(Harness);
