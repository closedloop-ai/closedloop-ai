/**
 * ISS-10724 — the `review_result.json` envelope the `code-review` plugin
 * already writes, narrowed to the fields the findings funnel reads.
 *
 * ROUTE DECISION (ISS-10724 AC1): THE COLLECTOR RECOVERS. The two candidates
 * were "the plugin emits" (it posts the funnel here, or writes a sidecar the
 * desktop collector already walks) and "the collector recovers" (we read the
 * envelope the run left on disk and join it by reviewer name). We take the
 * second. The plugin is a separately versioned artifact this repo does not
 * deploy, so the first route makes an ingest that cannot ship until a peer
 * release lands, and then makes every older plugin build silently unmeasured
 * with no way to backfill — the envelope is already on disk for those runs. The
 * second route costs us a weaker join (reviewer display id rather than an
 * invocation id the producer stamped) and an envelope that is silently absent
 * once the gitignored run directory is cleaned up. Both costs are bounded and
 * VISIBLE: the join's failures are counted rather than read as zeros (see
 * `findings-funnel-attribution.ts`), and a run we cannot read is counted as
 * unreadable rather than as a run with no findings (see
 * `findings-funnel-ingest.ts`). A silently-unmeasured population, which is what
 * the rejected route buys, is the one cost that cannot be made visible.
 *
 * ONLY A CORRUPT BUCKET CAN REFUSE A RUN. This envelope is a peer artifact on
 * its own release train, so every field but the four buckets is ignored — a
 * newer plugin writing `"schema_version": "2"` or an unknown key must not cost
 * us the whole run's findings. Bucket ENTRIES are `unknown` for the same
 * reason: a finding whose `reviewer` is null (which this producer does write
 * for absent optional strings), a number, or not an object at all is counted as
 * unattributed by the attributor, never grounds to reject the file.
 *
 * Wire keys are the producer's own snake_case and are quoted verbatim rather
 * than renamed, per the third-party wire-format carve-out in the root
 * `AGENTS.md`.
 */
import { z } from "zod";

/** The four verdict buckets of the envelope. Every finding is in exactly one. */
export const CodeReviewResultBucket = {
  /** CONFIRMED + DOWNGRADE + TENTATIVE. */
  Verified: "verified",
  /** JUSTIFIED-VALID. */
  Justified: "justified",
  /** REJECTED + JUSTIFIED-INVALID-promoted. */
  Rejected: "rejected",
  /** Emitted but never adjudicated. */
  PendingVerification: "pending_verification",
} as const;
export type CodeReviewResultBucket =
  (typeof CodeReviewResultBucket)[keyof typeof CodeReviewResultBucket];

const CODE_REVIEW_RESULT_BUCKETS = [
  CodeReviewResultBucket.Verified,
  CodeReviewResultBucket.Justified,
  CodeReviewResultBucket.Rejected,
  CodeReviewResultBucket.PendingVerification,
] as const satisfies readonly CodeReviewResultBucket[];

export const CodeReviewResultEnvelopeRejection = {
  NotAnObject: "not_an_object",
  BucketNotAnArray: "bucket_not_an_array",
  /** None of the four verdict buckets is present — we cannot read this run. */
  NoKnownBucket: "no_known_bucket",
} as const;
export type CodeReviewResultEnvelopeRejection =
  (typeof CodeReviewResultEnvelopeRejection)[keyof typeof CodeReviewResultEnvelopeRejection];

const codeReviewResultEnvelopeSchema = z.object({
  review_id: z.unknown().optional(),
  [CodeReviewResultBucket.Verified]: z.array(z.unknown()).optional(),
  [CodeReviewResultBucket.Justified]: z.array(z.unknown()).optional(),
  [CodeReviewResultBucket.Rejected]: z.array(z.unknown()).optional(),
  [CodeReviewResultBucket.PendingVerification]: z.array(z.unknown()).optional(),
});

/** The envelope as this ingest reads it: every bucket present, possibly empty. */
export type CodeReviewResultEnvelope = {
  reviewId: string | null;
  buckets: Record<CodeReviewResultBucket, readonly unknown[]>;
};

export type CodeReviewResultEnvelopeParse =
  | { ok: true; envelope: CodeReviewResultEnvelope }
  | { ok: false; rejection: CodeReviewResultEnvelopeRejection };

function rejectionFromIssues(issues: readonly z.core.$ZodIssue[]): boolean {
  return issues.some((issue) =>
    CODE_REVIEW_RESULT_BUCKETS.some((bucket) => issue.path[0] === bucket)
  );
}

/**
 * The reviewer display id a finding names, or `""` when it names none.
 *
 * Deliberately total over `unknown`: the producer writes `null` for an absent
 * optional string, and a peer release could write something else again. Either
 * way the caller counts the finding as unattributed instead of guessing.
 */
export function codeReviewFindingReviewerId(finding: unknown): string {
  if (typeof finding !== "object" || finding === null) {
    return "";
  }
  const reviewer = (finding as { reviewer?: unknown }).reviewer;
  return typeof reviewer === "string" ? reviewer.trim() : "";
}

/**
 * Parse an already-decoded JSON value into the narrowed envelope.
 *
 * A MISSING bucket is an empty bucket — a plugin build that never wrote
 * `pending_verification` really had none. A bucket present but not an array is
 * a corrupt envelope and is REFUSED, because coercing it to empty would report
 * "no findings" for a run that produced some. An envelope carrying NONE of the
 * four is refused for the same reason: zero producers and "unreadable" are
 * different facts, and only the second is true of a value this shape.
 */
export function parseCodeReviewResultEnvelope(
  value: unknown
): CodeReviewResultEnvelopeParse {
  const parsed = codeReviewResultEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    const rejection = rejectionFromIssues(parsed.error.issues)
      ? CodeReviewResultEnvelopeRejection.BucketNotAnArray
      : CodeReviewResultEnvelopeRejection.NotAnObject;
    return { ok: false, rejection };
  }
  const data = parsed.data;
  // An envelope carrying none of the four buckets — a rename in a newer plugin,
  // a truncated write — would otherwise read as a run with zero producers and
  // be counted as READ. The finalizer always writes all four, so requiring one
  // costs nothing against the current producer and keeps the "we could not read
  // this" fact instead of losing it.
  if (
    CODE_REVIEW_RESULT_BUCKETS.every((bucket) => data[bucket] === undefined)
  ) {
    return {
      ok: false,
      rejection: CodeReviewResultEnvelopeRejection.NoKnownBucket,
    };
  }
  const reviewId = data.review_id;
  return {
    ok: true,
    envelope: {
      reviewId: typeof reviewId === "string" ? reviewId : null,
      buckets: {
        [CodeReviewResultBucket.Verified]:
          data[CodeReviewResultBucket.Verified] ?? [],
        [CodeReviewResultBucket.Justified]:
          data[CodeReviewResultBucket.Justified] ?? [],
        [CodeReviewResultBucket.Rejected]:
          data[CodeReviewResultBucket.Rejected] ?? [],
        [CodeReviewResultBucket.PendingVerification]:
          data[CodeReviewResultBucket.PendingVerification] ?? [],
      },
    },
  };
}

/**
 * The verifier verdict a finding carries, or `""` when it reached none.
 *
 * BUCKET MEMBERSHIP IS NOT A VERDICT. The plugin's finalizer drops three kinds
 * of finding into `verified[]` with `verifier_verdict` left null — one whose id
 * was missing, one the tier skipped, and one absent from the verify manifest
 * (`code_review_helpers.py`, the "Tier-skipped: verifier_verdict stays None.
 * Land in verified[]" branch and the unkeyed-finding branch above it). Reading
 * the bucket alone therefore claims a verdict nobody reached, which is exactly
 * what excluding `pending_verification` exists to prevent. Callers key on this.
 */
export function codeReviewFindingVerdict(finding: unknown): string {
  if (typeof finding !== "object" || finding === null) {
    return "";
  }
  const verdict = (finding as { verifier_verdict?: unknown }).verifier_verdict;
  return typeof verdict === "string" ? verdict.trim() : "";
}

/**
 * How many bucket entries this RAW, still-unvalidated value would ask the fold
 * to visit — read off each bucket's `length` and nothing else.
 *
 * DELIBERATELY BEFORE THE PARSE, AND DELIBERATELY O(1) PER BUCKET. The fold, and
 * `parseCodeReviewResultEnvelope`'s own `z.array(z.unknown())`, are both linear
 * in the number of entries, so a count read AFTER the parse bounds nothing: by
 * then the linear work is already spent. This is the count-side twin of the
 * `stat` that precedes the byte read in `component-invocation-findings-attribution.ts`
 * — "the size gate has to run before the bytes land, or it is not a gate".
 *
 * A bucket that is present but not an array contributes NOTHING here rather than
 * being guessed at. That is not a coercion to "no findings": the parse refuses
 * such an envelope outright as {@link CodeReviewResultEnvelopeRejection.BucketNotAnArray},
 * so the only consequence of not counting it is that a corrupt bucket cannot
 * inflate the budget a caller spends before reaching that refusal.
 *
 * The result is a count of array entries, so it is a non-negative integer by
 * construction and its four-term sum is bounded by `4 * (2**32 - 1)`, well
 * inside the safe-integer range. No caller has to re-validate it.
 */
export function codeReviewResultFindingsPresent(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  const buckets = value as Record<string, unknown>;
  let present = 0;
  for (const bucket of CODE_REVIEW_RESULT_BUCKETS) {
    const entries = buckets[bucket];
    if (Array.isArray(entries)) {
      present += entries.length;
    }
  }
  return present;
}

/**
 * The bucket-shape refusal {@link parseCodeReviewResultEnvelope} would make for
 * this RAW value, or `null` when no known bucket is misshapen — read off each
 * bucket's shape and nothing else.
 *
 * O(1) PER BUCKET, AND THAT IS WHY IT EXISTS SEPARATELY. A caller that bounds
 * its work by {@link codeReviewResultFindingsPresent} skips the parse for a run
 * it declines to fold, so without this check an envelope that is BOTH corrupt
 * and over-budget gets classified by its size instead of by its corruption:
 * reported as a run carrying an exact number of findings when one of its buckets
 * was never counted and the value was never readable at all. The other two
 * rejections need no such twin — both describe a value whose counted size is 0,
 * so a bounded caller reaches them through the parse either way.
 */
export function codeReviewResultBucketShapeRejection(
  value: unknown
): CodeReviewResultEnvelopeRejection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const buckets = value as Record<string, unknown>;
  for (const bucket of CODE_REVIEW_RESULT_BUCKETS) {
    const entries = buckets[bucket];
    if (entries !== undefined && !Array.isArray(entries)) {
      return CodeReviewResultEnvelopeRejection.BucketNotAnArray;
    }
  }
  return null;
}
