/**
 * ISS-12552: the Related Sessions kind an evidence row stands for (PRD-800
 * "Related Sessions labels"). Creation, revision and implementation
 * are Contribution; a comment or review is Comment; usage is Usage; reference
 * and unresolved are Reference. Shared by the API's evidence reads and the
 * golden contract fixtures the metrics surfaces test against.
 */
import { AttributionRelationshipKind } from "./attribution-evidence";
import { ProvenanceRelationshipKind } from "./provenance-relationship";

/**
 * Evidence relationships, strongest first. A session-to-artifact pair is
 * labeled by the strongest it holds: the MCP resolved-link row, and Related
 * Sessions (PLN-2191 UI plan, "labeled by strongest class").
 */
export const RELATIONSHIP_STRENGTH: readonly AttributionRelationshipKind[] = [
  AttributionRelationshipKind.Creation,
  AttributionRelationshipKind.Revision,
  AttributionRelationshipKind.Implementation,
  AttributionRelationshipKind.CommentReview,
  AttributionRelationshipKind.Usage,
  AttributionRelationshipKind.Reference,
  AttributionRelationshipKind.Unresolved,
];

export const EVIDENCE_TO_PROVENANCE_KIND: Record<
  AttributionRelationshipKind,
  ProvenanceRelationshipKind
> = {
  [AttributionRelationshipKind.Creation]:
    ProvenanceRelationshipKind.Contribution,
  [AttributionRelationshipKind.Revision]:
    ProvenanceRelationshipKind.Contribution,
  [AttributionRelationshipKind.Implementation]:
    ProvenanceRelationshipKind.Contribution,
  [AttributionRelationshipKind.CommentReview]:
    ProvenanceRelationshipKind.Comment,
  [AttributionRelationshipKind.Usage]: ProvenanceRelationshipKind.Usage,
  [AttributionRelationshipKind.Reference]: ProvenanceRelationshipKind.Reference,
  [AttributionRelationshipKind.Unresolved]:
    ProvenanceRelationshipKind.Reference,
};

const KNOWN_EVIDENCE_KINDS: readonly string[] = Object.values(
  AttributionRelationshipKind
);

function isEvidenceKind(value: string): value is AttributionRelationshipKind {
  return KNOWN_EVIDENCE_KINDS.includes(value);
}

/** The provenance kind an evidence row stands for; undefined for an unknown kind. */
export function evidenceProvenanceKind(
  relationshipKind: string
): ProvenanceRelationshipKind | undefined {
  return isEvidenceKind(relationshipKind)
    ? EVIDENCE_TO_PROVENANCE_KIND[relationshipKind]
    : undefined;
}

/**
 * A Related Sessions kind's rank, lower is stronger: the position of the
 * strongest evidence relationship that maps to it. A kind no evidence maps to
 * ranks after every one that does.
 */
export function provenanceKindStrength(
  kind: ProvenanceRelationshipKind
): number {
  const index = RELATIONSHIP_STRENGTH.findIndex(
    (relationship) => EVIDENCE_TO_PROVENANCE_KIND[relationship] === kind
  );
  return index === -1 ? RELATIONSHIP_STRENGTH.length : index;
}
