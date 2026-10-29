/**
 * ISS-10739 (PRD-753 R7) — HOW a findings count was obtained.
 *
 * A count lifted out of a transcript by a collector heuristic and a count read
 * straight from the `code-review` plugin's `review_result.json` envelope are
 * not equally trustworthy, and must not share one column unlabelled. This is
 * the `AgentComponentInvocationUsageMeasurement` discipline (ISS-7795) applied
 * to the numerator: a value travels with the statement of how it was arrived
 * at, so a reader never folds unlike with unlike.
 *
 * WHICH UNION IT KEYS ON, AND WHY. It keys on the INGEST ROUTE that produced
 * the count — not on `AgentComponentInvocationKind` and not on the component's
 * identity. Both routes are live simultaneously and are reachable by the SAME
 * kind (ISS-7796): a `code-review` fleet reviewer is a `subagent` with a plugin
 * envelope behind it, while `logical-qa`, `metal-ottilie`, `visual-qa` and
 * `review-soul` emit findings into a transcript and nothing else. Keying on
 * kind would therefore label two counts identically that were obtained
 * differently, which is the defect this module exists to prevent. The route is
 * also the thing that actually varies per ingested row, so it is the only
 * union that can be recorded at the moment the number is produced.
 *
 * THREE VALUES, NOT TWO. `FlameExtentSource` (DOC-37 §2) is the same discipline
 * one dimension over and carries a third value for the same reason: a row the
 * derivation cannot place is LISTED, never dropped and never promoted to the
 * stronger label. {@link AgentComponentFindingsProvenance.Unresolved} is that
 * value here, and it is also what a legacy row with counts and no label reads
 * as — never `PluginEmitted`, because silently upgrading an unlabelled row to
 * the trustworthy source is the defect wearing a different hat.
 *
 * DELIBERATELY ZOD-FREE. Pinned by `agent-component-findings-provenance.zod-free.test.ts`
 * so a bundle-sensitive `"use client"` surface can import the label for a cell
 * (ISS-10727) without pulling the validator graph in behind it. Keep folds that
 * need zod in the funnel sibling.
 */

export const AgentComponentFindingsProvenance = {
  /**
   * Read from the `code-review` plugin's `review_result.json` envelope. The
   * count is the producer's own statement of what it emitted.
   */
  PluginEmitted: "plugin-emitted",
  /**
   * Reconstructed by a collector from session text. A real number and a weaker
   * claim: the heuristic can miss a finding the producer counted, and can
   * count text that was never adjudicated.
   */
  TranscriptRecovered: "transcript-recovered",
  /**
   * What a count the READ could not place reads as — an unlabelled legacy row,
   * or one carrying a label this build has no descriptor for. Present so such a
   * row is listed rather than dropped or silently promoted to a stronger label,
   * and NOT declarable at ingest: a producer allowed to write it would be
   * indistinguishable from the rows it exists to describe.
   */
  Unresolved: "unresolved",
} as const;

export type AgentComponentFindingsProvenance =
  (typeof AgentComponentFindingsProvenance)[keyof typeof AgentComponentFindingsProvenance];

type AgentComponentFindingsProvenanceDescriptor = {
  /**
   * The words a surface says beside the count. ISS-10727 renders this rather
   * than re-spelling a label at its call site.
   */
  label: string;
  /**
   * True only when the number is the producing component's own count. A
   * collector's reconstruction and an unplaceable row are both false, and they
   * are false for different reasons — which is why they stay separate members
   * rather than collapsing into one "not trusted" flag.
   */
  producerStated: boolean;
  /**
   * Whether an INGEST may declare this route. False for
   * {@link AgentComponentFindingsProvenance.Unresolved}, which is what a row
   * the READ could not place becomes — never something a producer writes. A
   * producer allowed to write it could not be told apart from a legacy
   * unlabelled row, which would lose the one distinction the member exists to
   * carry.
   */
  declarableAtIngest: boolean;
};

/**
 * Keyed by the union, so a fourth provenance fails `tsc` here until someone
 * says what it is called and whether its count is the producer's own. Every
 * list, set and bucket below is DERIVED from this record — a side inventory
 * would accept a new member silently and fall to a default, which is the
 * failure this record exists to make impossible.
 */
const AGENT_COMPONENT_FINDINGS_PROVENANCE_DESCRIPTORS: Record<
  AgentComponentFindingsProvenance,
  AgentComponentFindingsProvenanceDescriptor
> = {
  [AgentComponentFindingsProvenance.PluginEmitted]: {
    label: "Plugin-emitted",
    producerStated: true,
    declarableAtIngest: true,
  },
  [AgentComponentFindingsProvenance.TranscriptRecovered]: {
    label: "Transcript-recovered",
    producerStated: false,
    declarableAtIngest: true,
  },
  [AgentComponentFindingsProvenance.Unresolved]: {
    label: "Source unknown",
    producerStated: false,
    declarableAtIngest: false,
  },
};

/**
 * Whether `value` is a recorded provenance. Derived from the descriptor record,
 * so a new member is accepted the moment it is described and never before.
 */
export function isAgentComponentFindingsProvenance(
  value: unknown
): value is AgentComponentFindingsProvenance {
  return (
    typeof value === "string" &&
    Object.hasOwn(AGENT_COMPONENT_FINDINGS_PROVENANCE_DESCRIPTORS, value)
  );
}

/**
 * Every provenance, derived from the record rather than re-listed beside it,
 * and narrowed by this module's own guard rather than by an assertion — a cast
 * here would be the one place a key that is not a member could pass unnoticed.
 * The order is the descriptor literal's; nothing may depend on it.
 */
export const AGENT_COMPONENT_FINDINGS_PROVENANCE_VALUES: readonly AgentComponentFindingsProvenance[] =
  Object.keys(AGENT_COMPONENT_FINDINGS_PROVENANCE_DESCRIPTORS).filter(
    isAgentComponentFindingsProvenance
  );

/** What a surface says beside a count of this provenance. */
export function agentComponentFindingsProvenanceLabel(
  provenance: AgentComponentFindingsProvenance
): string {
  return AGENT_COMPONENT_FINDINGS_PROVENANCE_DESCRIPTORS[provenance].label;
}

/**
 * Whether a count of this provenance is the producing component's own. An
 * absent label reads {@link AgentComponentFindingsProvenance.Unresolved} and is
 * therefore false — a count with no recorded source must never present as the
 * trustworthy one.
 */
export function isAgentComponentFindingsProducerStated(
  provenance: AgentComponentFindingsProvenance
): boolean {
  return AGENT_COMPONENT_FINDINGS_PROVENANCE_DESCRIPTORS[provenance]
    .producerStated;
}

/**
 * Whether `value` is a route an INGEST may declare — every recorded provenance
 * except the read-side fallback. Derived from the descriptor record, so a
 * fourth member has to say which side it is on before it can pass either guard.
 *
 * Separate from {@link isAgentComponentFindingsProvenance} because the two
 * boundaries accept different sets on purpose: a READ must survive anything a
 * column holds, including {@link AgentComponentFindingsProvenance.Unresolved},
 * while an ingest that wrote that value would make a fresh unplaceable row
 * indistinguishable from a legacy unlabelled one.
 */
export function isAgentComponentFindingsIngestRoute(
  value: unknown
): value is AgentComponentFindingsProvenance {
  return (
    isAgentComponentFindingsProvenance(value) &&
    AGENT_COMPONENT_FINDINGS_PROVENANCE_DESCRIPTORS[value].declarableAtIngest
  );
}
