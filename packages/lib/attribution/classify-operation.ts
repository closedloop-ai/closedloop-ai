/**
 * ISS-12552: the one mapping from an operation's evidence to
 * the relationship a session has with an artifact. The classes and their
 * rules are ISS-12552's "Classify by explicit tool/route semantics" table;
 * committed writes that table does not name (links, tags, attachments, moves,
 * project writes, deletes, ratings, live-draft resets and the machine writes)
 * are unresolved.
 */
import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
  UnresolvedReason,
} from "@repo/api/src/types/attribution-evidence";

/** The classifier's version, stored on every evidence row. */
export const ATTRIBUTION_POLICY_VERSION = 1 as const;

export type OperationClassificationInput = {
  operationKind: OperationKind;
  outcome: OperationEvidenceOutcome;
  /**
   * The artifact is the operation's own target. A slug nested in a response
   * or named in prose is a reference, whatever the operation did.
   */
  targetMatched: boolean;
  /** A version's content digest changed. */
  contentChanged?: boolean;
  /** Persisted fields an update changed. */
  changedFields?: readonly string[];
};

export type OperationClassification = {
  kind: AttributionRelationshipKind;
  unresolvedReason?: UnresolvedReason;
};

const UNRESOLVED_REASON_BY_OUTCOME: Record<
  Exclude<OperationEvidenceOutcome, typeof OperationEvidenceOutcome.Committed>,
  UnresolvedReason
> = {
  [OperationEvidenceOutcome.NoOp]: UnresolvedReason.NoOp,
  [OperationEvidenceOutcome.Rejected]: UnresolvedReason.Rejected,
  [OperationEvidenceOutcome.Errored]: UnresolvedReason.Errored,
  [OperationEvidenceOutcome.Canceled]: UnresolvedReason.Canceled,
  [OperationEvidenceOutcome.MissingResult]: UnresolvedReason.MissingResult,
  [OperationEvidenceOutcome.Truncated]: UnresolvedReason.SourceTruncated,
  [OperationEvidenceOutcome.Ambiguous]: UnresolvedReason.MultipleCandidates,
  [OperationEvidenceOutcome.AwaitingReceipt]: UnresolvedReason.AwaitingReceipt,
  [OperationEvidenceOutcome.DuplicateInLineage]:
    UnresolvedReason.DuplicateInLineage,
};

type CommittedRule = (
  input: OperationClassificationInput
) => OperationClassification;

const usage: CommittedRule = () => ({
  kind: AttributionRelationshipKind.Usage,
});
const unsupported: CommittedRule = () =>
  unresolved(UnresolvedReason.UnsupportedOperation);

/** What a committed operation of each kind proves about its target. */
const COMMITTED_RULE_BY_KIND: Record<OperationKind, CommittedRule> = {
  [OperationKind.Read]: usage,
  [OperationKind.List]: usage,
  [OperationKind.Search]: usage,
  [OperationKind.Create]: () => ({
    kind: AttributionRelationshipKind.Creation,
  }),
  [OperationKind.CreateVersion]: (input) =>
    input.contentChanged === true
      ? { kind: AttributionRelationshipKind.Revision }
      : unresolved(UnresolvedReason.NoOp),
  [OperationKind.UpdateFields]: (input) =>
    (input.changedFields?.length ?? 0) > 0
      ? { kind: AttributionRelationshipKind.Revision }
      : unresolved(UnresolvedReason.NoOp),
  [OperationKind.Comment]: () => ({
    kind: AttributionRelationshipKind.CommentReview,
  }),
  [OperationKind.LinkCreate]: unsupported,
  [OperationKind.LinkDelete]: unsupported,
  [OperationKind.Tag]: unsupported,
  [OperationKind.Untag]: unsupported,
  [OperationKind.Attach]: unsupported,
  [OperationKind.Detach]: unsupported,
  [OperationKind.Move]: unsupported,
  [OperationKind.ProjectWrite]: unsupported,
  [OperationKind.Delete]: unsupported,
  [OperationKind.Rate]: unsupported,
  [OperationKind.LiveDraftReset]: unsupported,
  [OperationKind.DesktopSync]: unsupported,
  [OperationKind.Telemetry]: unsupported,
  [OperationKind.SettingsWrite]: unsupported,
  [OperationKind.OrganizationWrite]: unsupported,
  [OperationKind.LoopWrite]: unsupported,
  [OperationKind.SessionMeshWrite]: unsupported,
  [OperationKind.Unsupported]: unsupported,
};

export function classifyOperation(
  input: OperationClassificationInput
): OperationClassification {
  if (!input.targetMatched) {
    return { kind: AttributionRelationshipKind.Reference };
  }
  if (input.outcome === OperationEvidenceOutcome.Committed) {
    return COMMITTED_RULE_BY_KIND[input.operationKind](input);
  }
  return unresolved(UNRESOLVED_REASON_BY_OUTCOME[input.outcome]);
}

/** Only a creation counts toward what a session produced. */
export function qualifiesForProduction(
  kind: AttributionRelationshipKind
): boolean {
  return kind === AttributionRelationshipKind.Creation;
}

/** Creation and revision are the writing a session's cost can be split over. */
export function qualifiesForWritingCost(
  kind: AttributionRelationshipKind
): boolean {
  return (
    kind === AttributionRelationshipKind.Creation ||
    kind === AttributionRelationshipKind.Revision
  );
}

function unresolved(reason: UnresolvedReason): OperationClassification {
  return {
    kind: AttributionRelationshipKind.Unresolved,
    unresolvedReason: reason,
  };
}
