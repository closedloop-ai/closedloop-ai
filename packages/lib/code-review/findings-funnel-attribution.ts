/**
 * ISS-10724 — join one `review_result.json` run to the components that produced
 * its findings, and fold each producer's buckets into the ISS-7796 funnel.
 *
 * A VERDICT IS READ FROM THE FINDING, NEVER FROM ITS BUCKET. `verified[]` is
 * not a synonym for adjudicated: the plugin's finalizer lands an unkeyed
 * finding, a tier-skipped one, and one absent from the verify manifest in
 * `verified[]` with `verifier_verdict` left null. So every finding is
 * classified by its own `verifier_verdict` first, and only an ADJUDICATED one
 * reaches a stored count:
 *
 * - `findingsEmitted`     = adjudicated `verified` + `justified` + `rejected`
 * - `findingsInvalidated` = adjudicated `rejected`
 * - `findingsProvenance`   = `plugin-emitted` (ISS-10739) — this join reads the
 *   plugin's own envelope, which is the high-fidelity route
 * - `findingsConfirmed` (derived at read) = emitted - invalidated
 * - a finding with NO verdict is in NEITHER count, whichever bucket holds it.
 *
 * That last line is the one that is easy to get wrong. A finding awaiting — or
 * never receiving — a verdict has not been refuted, so it is not invalidated;
 * but folding it into `emitted` alone would make the derived `confirmed` claim
 * it, which is a verdict nobody reached. It is excluded from both and surfaced
 * as a completeness caveat instead
 * ({@link CodeReviewRunFindingsAttribution.unadjudicatedFindings}).
 *
 * A PRODUCER WITH NO ADJUDICATED FINDING HAS NO FUNNEL, NOT A ZEROED ONE. Its
 * `funnel` is `null`, which reads UNKNOWN rather than a measured `{0, 0}` — a
 * reviewer that emitted six findings and had none verified did not emit zero.
 *
 * THE JOIN IS BY REVIEWER DISPLAY ID, AND ITS FAILURES ARE COUNTED. The
 * envelope keys findings by the reviewer id the agent wrote, which `SCHEMA.md`
 * defines as the ROLE vocabulary (`bug_hunter_a`, `unified_auditor`, …) and
 * which the plugin's filename fallback instead renders as the short display id
 * (`bha_p0`, `auditor`, …). Both spellings are accepted below. An invocation is
 * keyed by `componentKey` at `componentKind = subagent`. They are the same
 * thing in intent and NOT the same string, so the map is explicit and
 * everything it does not cover lands in one of two counted buckets rather than
 * being dropped. An unmatched reviewer is a producer we could not attribute —
 * never a producer with zero findings.
 *
 * A `componentKey` DOES NOT IDENTIFY AN INVOCATION, AND THE ENTRY SAYS SO.
 * Several reviewers run as one subagent type within a run — `bha_p0`, the
 * auditor and every domain critic are all `code-review:code-review-worker`, as
 * separate spawned invocations — and a role can span worker types across plugin
 * releases, since the graph-aware worker was split out later and older runs
 * record Bug Hunter B as the default worker. Either way the key alone cannot
 * tell a persistence consumer WHICH invocation owns the funnel, so every
 * candidate key is carried and the association is reported as
 * {@link CodeReviewComponentAssociation.Ambiguous} rather than presented as an
 * exact match. Entries are emitted PER REVIEWER and never summed: summing two
 * that share a key would report one invocation's funnel as another's.
 */

import type { AgentComponentFindingsFunnel } from "@repo/api/src/types/agent-component-findings-funnel";
import { AgentComponentFindingsProvenance } from "@repo/api/src/types/agent-component-findings-provenance";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import {
  CodeReviewResultBucket,
  type CodeReviewResultEnvelope,
  codeReviewFindingReviewerId,
  codeReviewFindingVerdict,
} from "./review-result-envelope.ts";

/** The two subagent types the plugin spawns every reviewer role as. */
const CODE_REVIEW_WORKER_COMPONENT_KEY = "code-review:code-review-worker";
const CODE_REVIEW_WORKER_GRAPH_COMPONENT_KEY =
  "code-review:code-review-worker-graph";

/**
 * A graph-aware role: the graph worker today, the default worker in runs that
 * predate the split. Both are carried so an older run is not read as unmatched.
 */
const GRAPH_ROLE_COMPONENT_KEYS: readonly string[] = [
  CODE_REVIEW_WORKER_GRAPH_COMPONENT_KEY,
  CODE_REVIEW_WORKER_COMPONENT_KEY,
];
const DEFAULT_ROLE_COMPONENT_KEYS: readonly string[] = [
  CODE_REVIEW_WORKER_COMPONENT_KEY,
];

/**
 * Reviewer id → the subagent `componentKey`s that role may be spawned as, for
 * the roles whose id is a fixed string. Sourced from the plugin's own
 * `spawn-reviewers` skill: the graph-aware worker takes Bug Hunter B, the
 * Impact Analyzer, the Design Critic and the fast path; every other role takes
 * the default worker. Each role appears twice — once under the `SCHEMA.md` role
 * name an agent writes for itself, once under the short display id the
 * filename fallback produces.
 */
const REVIEWER_COMPONENT_KEYS: ReadonlyMap<string, readonly string[]> = new Map(
  [
    ["auditor", DEFAULT_ROLE_COMPONENT_KEYS],
    ["unified_auditor", DEFAULT_ROLE_COMPONENT_KEYS],
    ["bug_hunter_a", DEFAULT_ROLE_COMPONENT_KEYS],
    ["test_quality", DEFAULT_ROLE_COMPONENT_KEYS],
    ["bhb", GRAPH_ROLE_COMPONENT_KEYS],
    ["bug_hunter_b", GRAPH_ROLE_COMPONENT_KEYS],
    ["impact", GRAPH_ROLE_COMPONENT_KEYS],
    ["design_critic", GRAPH_ROLE_COMPONENT_KEYS],
    ["fast", GRAPH_ROLE_COMPONENT_KEYS],
    ["fast_path_reviewer", GRAPH_ROLE_COMPONENT_KEYS],
  ]
);

/**
 * Every subagent `componentKey` a code-review funnel may ever be placed on,
 * DERIVED from the map above rather than re-listed beside it — the two worker
 * keys are already spelled once each at the top of this file, and a third worker
 * added to a role there must reach this set without anyone remembering to.
 *
 * ISS-11325 needs it because a WITHHELD run has no matched reviewer and so names
 * no component: to say on a row that its funnel was withheld, the write side has
 * to know which rows a code-review funnel could have landed on at all, without
 * having read the envelope that was withheld. Membership here is the necessary
 * condition — it says a funnel COULD have been placed here, never that one was.
 */
export const CODE_REVIEW_FUNNEL_COMPONENT_KEYS: ReadonlySet<string> = new Set(
  [...REVIEWER_COMPONENT_KEYS.values()].flat()
);

/** Bug Hunter A is partitioned, so its id carries the partition index. */
const BUG_HUNTER_A_REVIEWER_ID = /^bha_p\d+$/;
/** Domain critics are numbered monotonically at dispatch. */
const DOMAIN_CRITIC_REVIEWER_ID = /^domain_\d+$/;

/**
 * Producers that are deterministic helpers inside the plugin process, not
 * spawned subagents. They have no invocation to attribute to, which is a
 * different fact from a reviewer we failed to match — so they are classified,
 * not counted as join failures. `signal-extractor`, `coverage-critic` and
 * `foundation` write findings into the envelope exactly like the other four:
 * leaving them out makes every run with a failed prefix stage or a degraded
 * critic bump `unmatchedReviewerCount`, so the counter stops being a signal.
 */
const DETERMINISTIC_REVIEWER_IDS: ReadonlySet<string> = new Set([
  "hygiene",
  "injection-detector",
  "companion-validator",
  "coverage-verifier",
  "signal-extractor",
  "coverage-critic",
  "foundation",
]);

export const CodeReviewReviewerAttribution = {
  /** Joined to at least one subagent `componentKey`. */
  Matched: "matched",
  /** A deterministic helper: no invocation exists to carry this funnel. */
  Deterministic: "deterministic",
  /** A producer this join does not know. Counted, never read as a zero. */
  Unmatched: "unmatched",
} as const;
export type CodeReviewReviewerAttribution =
  (typeof CodeReviewReviewerAttribution)[keyof typeof CodeReviewReviewerAttribution];

export const CodeReviewComponentAssociation = {
  /** One candidate key, and no other reviewer in this run shares it. */
  Exact: "exact",
  /**
   * The key does not single out an invocation: the role spans worker types
   * across releases, or another reviewer in this run resolves to the same key.
   */
  Ambiguous: "ambiguous",
} as const;
export type CodeReviewComponentAssociation =
  (typeof CodeReviewComponentAssociation)[keyof typeof CodeReviewComponentAssociation];

/** One producer's funnel within one run. */
export type CodeReviewReviewerFunnel = {
  reviewerId: string;
  /**
   * `null` when no finding of this producer reached a verdict. Reads UNKNOWN,
   * never a measured zero — see the module docstring.
   */
  funnel: AgentComponentFindingsFunnel | null;
  /** Excluded from the funnel; carried so the caveat survives the fold. */
  unadjudicatedFindings: number;
};

/** A producer we joined to a component. */
export type CodeReviewMatchedReviewerFunnel = CodeReviewReviewerFunnel & {
  componentKind: typeof AgentComponentInvocationKind.Subagent;
  /** The likeliest candidate. NOT an invocation id — read `association`. */
  componentKey: string;
  /** Every key this role may have been spawned as, likeliest first. */
  componentKeys: readonly string[];
  association: CodeReviewComponentAssociation;
};

export type CodeReviewRunFindingsAttribution = {
  reviewId: string | null;
  matched: readonly CodeReviewMatchedReviewerFunnel[];
  deterministic: readonly CodeReviewReviewerFunnel[];
  unmatched: readonly CodeReviewReviewerFunnel[];
  /**
   * Findings whose envelope entry carried no reviewer at all. They belong to no
   * producer we can name, so they are counted here and nowhere else.
   */
  unattributedFindings: number;
  /** Across the whole run. Zero exactly when the run was fully adjudicated. */
  unadjudicatedFindings: number;
  /**
   * ISS-10724 AC4. False means at least one finding in this run never reached a
   * verdict, so every funnel above is a floor rather than a final count.
   */
  fullyAdjudicated: boolean;
};

type ReviewerTally = {
  emitted: number;
  invalidated: number;
  unadjudicated: number;
};

function emptyTally(): ReviewerTally {
  return { emitted: 0, invalidated: 0, unadjudicated: 0 };
}

/** Which of the three outcomes a reviewer display id falls into. */
export function classifyCodeReviewReviewer(reviewerId: string): {
  attribution: CodeReviewReviewerAttribution;
  componentKeys: readonly string[];
} {
  const exact = REVIEWER_COMPONENT_KEYS.get(reviewerId);
  if (exact !== undefined) {
    return {
      attribution: CodeReviewReviewerAttribution.Matched,
      componentKeys: exact,
    };
  }
  if (
    BUG_HUNTER_A_REVIEWER_ID.test(reviewerId) ||
    DOMAIN_CRITIC_REVIEWER_ID.test(reviewerId)
  ) {
    return {
      attribution: CodeReviewReviewerAttribution.Matched,
      componentKeys: DEFAULT_ROLE_COMPONENT_KEYS,
    };
  }
  if (DETERMINISTIC_REVIEWER_IDS.has(reviewerId)) {
    return {
      attribution: CodeReviewReviewerAttribution.Deterministic,
      componentKeys: [],
    };
  }
  return {
    attribution: CodeReviewReviewerAttribution.Unmatched,
    componentKeys: [],
  };
}

/**
 * Which stored count, if any, this finding belongs in. A finding with no
 * `verifier_verdict` is unadjudicated whatever bucket holds it.
 */
function tallyFinding(
  tally: ReviewerTally,
  bucket: CodeReviewResultBucket,
  finding: unknown
): void {
  if (codeReviewFindingVerdict(finding) === "") {
    tally.unadjudicated += 1;
    return;
  }
  tally.emitted += 1;
  if (bucket === CodeReviewResultBucket.Rejected) {
    tally.invalidated += 1;
  }
}

function tallyByReviewer(envelope: CodeReviewResultEnvelope): {
  tallies: Map<string, ReviewerTally>;
  unattributedFindings: number;
  unattributedUnadjudicatedFindings: number;
} {
  const tallies = new Map<string, ReviewerTally>();
  let unattributedFindings = 0;
  let unattributedUnadjudicatedFindings = 0;
  for (const bucket of [
    CodeReviewResultBucket.Verified,
    CodeReviewResultBucket.Justified,
    CodeReviewResultBucket.Rejected,
    CodeReviewResultBucket.PendingVerification,
  ] as const) {
    for (const finding of envelope.buckets[bucket]) {
      const reviewerId = codeReviewFindingReviewerId(finding);
      if (reviewerId === "") {
        unattributedFindings += 1;
        if (codeReviewFindingVerdict(finding) === "") {
          unattributedUnadjudicatedFindings += 1;
        }
        continue;
      }
      const tally = tallies.get(reviewerId) ?? emptyTally();
      tallyFinding(tally, bucket, finding);
      tallies.set(reviewerId, tally);
    }
  }
  return { tallies, unattributedFindings, unattributedUnadjudicatedFindings };
}

function reviewerFunnel(
  reviewerId: string,
  tally: ReviewerTally
): CodeReviewReviewerFunnel {
  return {
    reviewerId,
    funnel:
      tally.emitted === 0
        ? null
        : {
            findingsEmitted: tally.emitted,
            findingsInvalidated: tally.invalidated,
            // This module reads the plugin's own `review_result.json`
            // envelope, so every funnel it produces is the producer's own
            // count. A collector reconstructing findings from session text
            // labels its own route instead; neither may omit the label.
            findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
          },
    unadjudicatedFindings: tally.unadjudicated,
  };
}

/**
 * How many reviewers in this run resolve to each primary candidate key. A key
 * two reviewers share cannot identify either one's invocation.
 */
function primaryKeyOccupancy(
  reviewerIds: readonly string[]
): ReadonlyMap<string, number> {
  const occupancy = new Map<string, number>();
  for (const reviewerId of reviewerIds) {
    const [primary] = classifyCodeReviewReviewer(reviewerId).componentKeys;
    if (primary !== undefined) {
      occupancy.set(primary, (occupancy.get(primary) ?? 0) + 1);
    }
  }
  return occupancy;
}

/** Fold one parsed envelope into per-producer funnels plus its join failures. */
export function attributeCodeReviewFindings(
  envelope: CodeReviewResultEnvelope
): CodeReviewRunFindingsAttribution {
  const { tallies, unattributedFindings, unattributedUnadjudicatedFindings } =
    tallyByReviewer(envelope);
  const matched: CodeReviewMatchedReviewerFunnel[] = [];
  const deterministic: CodeReviewReviewerFunnel[] = [];
  const unmatched: CodeReviewReviewerFunnel[] = [];
  let unadjudicatedFindings = unattributedUnadjudicatedFindings;
  const ordered = [...tallies.entries()].sort(([left], [right]) =>
    left < right ? -1 : 1
  );
  const occupancy = primaryKeyOccupancy(
    ordered.map(([reviewerId]) => reviewerId)
  );
  for (const [reviewerId, tally] of ordered) {
    const entry = reviewerFunnel(reviewerId, tally);
    unadjudicatedFindings += entry.unadjudicatedFindings;
    const { attribution, componentKeys } =
      classifyCodeReviewReviewer(reviewerId);
    const [primary] = componentKeys;
    if (
      attribution === CodeReviewReviewerAttribution.Matched &&
      primary !== undefined
    ) {
      const shared = (occupancy.get(primary) ?? 0) > 1;
      matched.push({
        ...entry,
        componentKind: AgentComponentInvocationKind.Subagent,
        componentKey: primary,
        componentKeys,
        association:
          componentKeys.length > 1 || shared
            ? CodeReviewComponentAssociation.Ambiguous
            : CodeReviewComponentAssociation.Exact,
      });
      continue;
    }
    if (attribution === CodeReviewReviewerAttribution.Deterministic) {
      deterministic.push(entry);
      continue;
    }
    unmatched.push(entry);
  }
  return {
    reviewId: envelope.reviewId,
    matched,
    deterministic,
    unmatched,
    unattributedFindings,
    unadjudicatedFindings,
    fullyAdjudicated: unadjudicatedFindings === 0,
  };
}
