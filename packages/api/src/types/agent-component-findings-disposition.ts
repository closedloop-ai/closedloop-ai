/**
 * ISS-11325 (from PR #7993's findings) — WHY a findings row reads what it reads.
 *
 * ISS-10739's sibling, one axis over, and the same discipline: a value travels
 * with the statement of how it was arrived at. `AgentComponentFindingsProvenance`
 * answers WHICH ROUTE produced a count that IS there. This answers the question
 * that route cannot: whether the row has a count at all, whether the count
 * describes THIS run, and — when there is none — WHICH of the ingest's three
 * withholding outcomes took it away.
 *
 * WHY IT IS A SECOND VOCABULARY AND NOT A FOURTH PROVENANCE MEMBER. A
 * provenance is a property of a count, so every member of that union presupposes
 * one; three of the members here describe a row with NO count. Adding them there
 * would put values into `AgentComponentFindingsProvenanceBreakdown`'s keyed
 * buckets that can never carry a finding, and would make
 * `isAgentComponentFindingsProducerStated` answer a question that does not
 * apply. The two axes are independent and compose: a row can be
 * `plugin-emitted` AND `carried-forward`.
 *
 * THE TWO FACTS THIS EXISTS TO SEPARATE, both pre-existing and both surfaced by
 * #7993:
 *
 *  1. THREE INGEST OUTCOMES COLLAPSED TO ONE NULL. `@repo/lib/code-review`'s
 *     ingest already distinguishes a run it sized exactly and declined to fold
 *     (the ISS-11310 count cap), a file it refused to open on size (the #7978
 *     byte gate), and a run it could not read at all — and only a desktop log
 *     line carried the difference. At the row all three were `null`/`null`, so a
 *     cloud reader saw "not measured" and could not tell too-big from too-many
 *     from corrupt.
 *  2. A STALE FUNNEL READ AS CURRENT. `preserveStrongerEvidence` carries a prior
 *     run's real measurement forward so a run that could not produce one does
 *     not erase it (ISS-10725), and it must keep doing that — but the reader saw
 *     a number with nothing saying it describes a previous run. A null is an
 *     honest absence; a stale number presented as current is a confident wrong
 *     measurement.
 *
 * A WITHHELD MEMBER IS A STATEMENT ABOUT THE PASS, NOT A PROVEN CAUSE OF THIS
 * ROW'S ABSENCE, and its label says so out loud rather than leaving the
 * qualification in a comment no consumer can read (review-soul, class A). A
 * withheld envelope names no reviewer and therefore no invocation, so the ingest
 * cannot say WHICH rows it would have covered; and a row can hold no funnel for
 * causes that are not withholdings at all — a reviewer id this build cannot
 * place, a reviewer whose every finding went unadjudicated, or a worker
 * invocation no envelope ever described. "Withheld this pass — evidence too
 * large to open" is therefore the whole of what a row may claim: the pass
 * withheld for that reason, and this row is one a withheld funnel COULD have
 * described. A label reading "evidence too large to open" full stop would be a
 * confident, specific and possibly false statement about this row's evidence,
 * which is the defect the ambiguity member below refuses to commit one axis over.
 *
 * AMBIGUITY IS A MEMBER, NOT A PRECEDENCE RULE. A pass can withhold for more
 * than one reason, and which withheld envelope would have covered a given row is
 * NOT recoverable from the evidence (the envelope names no invocation — see
 * `component-invocation-findings-attribution.ts`). Picking a winner by precedence
 * would state a reason that may be false for that row, so
 * {@link AgentComponentFindingsDisposition.WithheldAmbiguousReason} says exactly
 * what is known: withheld, and the reason is not uniquely attributable. It is
 * reached ONLY when more than one reason genuinely applied — never as a fallback
 * for a reason this module failed to classify.
 *
 * DELIBERATELY ZOD-FREE, like the provenance sibling, so a bundle-sensitive
 * `"use client"` surface can render the label for a cell without pulling the
 * validator graph in behind it. Pinned by the `.zod-free` test.
 */

export const AgentComponentFindingsDisposition = {
  /**
   * This run read the producer's evidence and the counts on this row are its
   * own. The only member that claims the number describes the run that wrote it.
   */
  MeasuredThisRun: "measured-this-run",
  /**
   * The counts are a PRIOR run's measurement, preserved because this run could
   * not produce one (ISS-10725's `preserveMeasuredFindings`). A real number, and
   * not this run's — which is the whole reason the member exists.
   */
  CarriedForward: "carried-forward",
  /**
   * Withheld by the ISS-11310 findings-count fold budget. The one withholding
   * member whose evidence was SIZED EXACTLY before being declined, so the
   * shortfall is a known quantity even though the per-producer split it stands
   * in for is not computable within the bound.
   */
  WithheldCountCapped: "withheld-count-capped",
  /**
   * Withheld by the #7978 envelope byte gate: the file was never opened, so its
   * size in bytes is known and its finding count is not.
   */
  WithheldByteGated: "withheld-byte-gated",
  /**
   * Withheld because the evidence could not be read at all — missing, corrupt,
   * a shape this build rejects, or a read the pass abandoned. Nothing is sayable
   * about what it held, which is precisely what separates it from the two above.
   */
  WithheldUnreadable: "withheld-unreadable",
  /**
   * Withheld, with more than one of the three reasons above in play for this
   * pass and no way to say which one covered THIS row. A precise statement of a
   * genuine ambiguity, never a bucket for an unclassified reason.
   */
  WithheldAmbiguousReason: "withheld-ambiguous-reason",
  /**
   * What a READ resolves an absent or unplaceable cell to: a row written before
   * this column existed, or one carrying a member this build has no descriptor
   * for. Present so such a row is LISTED rather than dropped or promoted to a
   * stronger statement, and NOT declarable at ingest — a producer allowed to
   * write it would be indistinguishable from the rows it exists to describe.
   */
  Unrecorded: "unrecorded",
} as const;

export type AgentComponentFindingsDisposition =
  (typeof AgentComponentFindingsDisposition)[keyof typeof AgentComponentFindingsDisposition];

/**
 * The members an INGEST may declare — every recorded disposition except the
 * read-side fallback (@whitlockk review).
 *
 * A SECOND TYPE AND NOT A COMMENT, because the wire schema already refuses
 * `unrecorded` and a wire field typed over the full union let a producer build a
 * type-correct item that only dies at the `.strict()` boundary — where a refusal
 * costs the whole part and dead-letters the generation. Derived by `Exclude`
 * over the const rather than re-listed, so an eighth member is admitted here the
 * moment it is added and never by a side inventory going stale.
 */
export type AgentComponentFindingsIngestDisposition = Exclude<
  AgentComponentFindingsDisposition,
  typeof AgentComponentFindingsDisposition.Unrecorded
>;

type AgentComponentFindingsDispositionDescriptor = {
  /**
   * OPERATOR WORDING, not product copy (@tamsinb review). The only consumer
   * today is the desktop ingest log line in
   * `component-invocation-findings-attribution.ts`, and nobody has signed these
   * strings off as user-facing text. A surface that wants to render a
   * disposition beside the counts gets its copy approved first rather than
   * importing these — the wording is deliberately not part of the contract this
   * module ships.
   */
  label: string;
  /** True only where the row's counts are THIS run's own measurement. */
  statesThisRunMeasured: boolean;
  /** True only where the row's counts are a preserved earlier measurement. */
  statesFunnelCarriedForward: boolean;
  /**
   * True on every member that says the row has no counts because THE PASS hit an
   * ingest outcome. Read it as pass-scoped: see the docblock above for why the
   * row cannot claim the withholding was its own, and why the labels say so.
   */
  statesFunnelWithheld: boolean;
  /**
   * Whether an INGEST may declare this member. False only for
   * {@link AgentComponentFindingsDisposition.Unrecorded}, for the reason its own
   * docblock gives.
   */
  declarableAtIngest: boolean;
};

/**
 * Keyed by the union, so an eighth member fails `tsc` here until someone says
 * what it is called and which of the questions above it answers. Every list,
 * set and fold below is DERIVED from this record — a side inventory would accept
 * a new member silently and fall to a default, which is the failure this record
 * exists to make impossible.
 */
const AGENT_COMPONENT_FINDINGS_DISPOSITION_DESCRIPTORS: Record<
  AgentComponentFindingsDisposition,
  AgentComponentFindingsDispositionDescriptor
> = {
  [AgentComponentFindingsDisposition.MeasuredThisRun]: {
    label: "Measured this run",
    statesThisRunMeasured: true,
    statesFunnelCarriedForward: false,
    statesFunnelWithheld: false,
    declarableAtIngest: true,
  },
  [AgentComponentFindingsDisposition.CarriedForward]: {
    label: "Carried forward from an earlier run",
    statesThisRunMeasured: false,
    statesFunnelCarriedForward: true,
    statesFunnelWithheld: false,
    declarableAtIngest: true,
  },
  [AgentComponentFindingsDisposition.WithheldCountCapped]: {
    label: "Withheld this pass — too many findings to fold",
    statesThisRunMeasured: false,
    statesFunnelCarriedForward: false,
    statesFunnelWithheld: true,
    declarableAtIngest: true,
  },
  [AgentComponentFindingsDisposition.WithheldByteGated]: {
    label: "Withheld this pass — evidence too large to open",
    statesThisRunMeasured: false,
    statesFunnelCarriedForward: false,
    statesFunnelWithheld: true,
    declarableAtIngest: true,
  },
  [AgentComponentFindingsDisposition.WithheldUnreadable]: {
    label: "Withheld this pass — evidence unreadable",
    statesThisRunMeasured: false,
    statesFunnelCarriedForward: false,
    statesFunnelWithheld: true,
    declarableAtIngest: true,
  },
  [AgentComponentFindingsDisposition.WithheldAmbiguousReason]: {
    label: "Withheld this pass — more than one reason applied",
    statesThisRunMeasured: false,
    statesFunnelCarriedForward: false,
    statesFunnelWithheld: true,
    declarableAtIngest: true,
  },
  [AgentComponentFindingsDisposition.Unrecorded]: {
    label: "Disposition not recorded",
    statesThisRunMeasured: false,
    statesFunnelCarriedForward: false,
    statesFunnelWithheld: false,
    declarableAtIngest: false,
  },
};

/** The three withholding outcomes an ingest can report, as a set of facts. */
export type AgentComponentFindingsWithholdingReasons = {
  /** At least one envelope was sized exactly and refused by the fold budget. */
  countCapped: boolean;
  /** At least one envelope was refused by the byte gate before being opened. */
  byteGated: boolean;
  /** At least one envelope could not be read, parsed, or was never reached. */
  unreadable: boolean;
};

/**
 * The member each single reason reads as, keyed by the reason so a FOURTH
 * withholding outcome fails `tsc` here rather than falling silently into the
 * ambiguous member — which would turn a precise statement of ambiguity into the
 * unclassified bucket its docblock refuses to be.
 */
const WITHHOLDING_REASON_DISPOSITIONS: Record<
  keyof AgentComponentFindingsWithholdingReasons,
  AgentComponentFindingsDisposition
> = {
  countCapped: AgentComponentFindingsDisposition.WithheldCountCapped,
  byteGated: AgentComponentFindingsDisposition.WithheldByteGated,
  unreadable: AgentComponentFindingsDisposition.WithheldUnreadable,
};

/**
 * Whether `value` is a recorded disposition. Derived from the descriptor record,
 * so a new member is accepted the moment it is described and never before.
 */
export function isAgentComponentFindingsDisposition(
  value: unknown
): value is AgentComponentFindingsDisposition {
  return (
    typeof value === "string" &&
    Object.hasOwn(AGENT_COMPONENT_FINDINGS_DISPOSITION_DESCRIPTORS, value)
  );
}

/**
 * Whether `value` is a member an INGEST may declare — every recorded disposition
 * except the read-side fallback. Separate from
 * {@link isAgentComponentFindingsDisposition} because the two boundaries accept
 * different sets on purpose: a READ must survive anything a column holds.
 */
export function isAgentComponentFindingsIngestDisposition(
  value: unknown
): value is AgentComponentFindingsIngestDisposition {
  return (
    isAgentComponentFindingsDisposition(value) &&
    AGENT_COMPONENT_FINDINGS_DISPOSITION_DESCRIPTORS[value].declarableAtIngest
  );
}

/**
 * How an operator log line names this disposition. NOT approved user-facing
 * copy — see the descriptor's `label` above before rendering it anywhere.
 */
export function agentComponentFindingsDispositionLabel(
  disposition: AgentComponentFindingsDisposition
): string {
  return AGENT_COMPONENT_FINDINGS_DISPOSITION_DESCRIPTORS[disposition].label;
}

/**
 * The disposition a set of withholding reasons reads as, or `undefined` when
 * nothing was withheld.
 *
 * Exactly one reason reads as that reason. MORE THAN ONE reads as
 * {@link AgentComponentFindingsDisposition.WithheldAmbiguousReason}, because the
 * envelope names no invocation and so which withheld run would have covered a
 * given row is not recoverable — naming one of them would state a reason that
 * may be false for that row.
 */
export function agentComponentFindingsWithheldDisposition(
  reasons: AgentComponentFindingsWithholdingReasons
): AgentComponentFindingsDisposition | undefined {
  const applied = (
    Object.keys(
      WITHHOLDING_REASON_DISPOSITIONS
    ) as (keyof AgentComponentFindingsWithholdingReasons)[]
  ).filter((reason) => reasons[reason]);
  const [only] = applied;
  if (only === undefined) {
    return;
  }
  return applied.length === 1
    ? WITHHOLDING_REASON_DISPOSITIONS[only]
    : AgentComponentFindingsDisposition.WithheldAmbiguousReason;
}

/**
 * Whether `disposition` can describe a row whose funnel presence is
 * `funnelPresent`.
 *
 * The two halves of the contract cannot disagree: a disposition that states a
 * measurement must sit beside counts, and one that states a withholding must sit
 * beside none. Checked at the write so a label and a pair can never be persisted
 * contradicting each other — a "withheld" row carrying counts, or a "measured"
 * one whose pair the writer had to refuse as inadmissible, would each be a
 * confident statement about the wrong thing.
 */
export function isAgentComponentFindingsDispositionConsistentWithFunnel(
  disposition: AgentComponentFindingsDisposition,
  funnelPresent: boolean
): boolean {
  const descriptor =
    AGENT_COMPONENT_FINDINGS_DISPOSITION_DESCRIPTORS[disposition];
  if (descriptor.statesFunnelWithheld) {
    return !funnelPresent;
  }
  if (
    descriptor.statesThisRunMeasured ||
    descriptor.statesFunnelCarriedForward
  ) {
    return funnelPresent;
  }
  // Unrecorded makes no claim either way, and is refused at ingest regardless.
  return true;
}

/**
 * Fold a stored cell into what a read surface renders: a recorded member, or
 * {@link AgentComponentFindingsDisposition.Unrecorded} for a legacy row and for
 * a member this build cannot place. A row the derivation cannot place is LISTED,
 * never dropped.
 */
export function readAgentComponentFindingsDisposition(
  value: unknown
): AgentComponentFindingsDisposition {
  return isAgentComponentFindingsDisposition(value)
    ? value
    : AgentComponentFindingsDisposition.Unrecorded;
}
