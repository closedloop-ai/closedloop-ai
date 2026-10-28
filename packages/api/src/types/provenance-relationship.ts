/**
 * ISS-7234 — the canonical vocabulary for how a session relates to an artifact.
 *
 * Deliberately import-free: S2 renders these labels from a `"use client"`
 * surface, and the persisted evidence this vocabulary classifies lives behind
 * Zod-heavy modules (`session-artifact-link.ts`). Same split as
 * `session-status.ts` / `session-status-display.ts` — the words ship without the
 * parsers. The classifier that maps persisted rows onto these kinds is server
 * side (`apps/api/app/agent-sessions/service/provenance-eligibility.ts`), per
 * the `packages/api` rule that database provenance internals stay in `apps/api`.
 */

export const ProvenanceRelationshipKind = {
  /** The session wrote or revised the artifact. */
  Contribution: "contribution",
  /** The session left review feedback on the artifact. */
  Comment: "comment",
  /**
   * The session invoked the artifact (an agent component). Runtime evidence,
   * NOT authorship — the distinction ISS-7234 exists to preserve.
   */
  Invocation: "invocation",
  /** The session read the artifact as input or held it in its workspace. */
  Usage: "usage",
  /** The artifact produced, or was produced by, the other endpoint. */
  Production: "production",
  /** The artifact was named in prose or by URL. A mention is not authorship. */
  Reference: "reference",
} as const;
export type ProvenanceRelationshipKind =
  (typeof ProvenanceRelationshipKind)[keyof typeof ProvenanceRelationshipKind];

/**
 * Exhaustive by construction: a seventh kind with no entry here fails `tsc`
 * rather than falling through to a default label at render time.
 */
export const PROVENANCE_RELATIONSHIP_KIND_LABELS: Record<
  ProvenanceRelationshipKind,
  string
> = {
  [ProvenanceRelationshipKind.Contribution]: "Contributed",
  [ProvenanceRelationshipKind.Comment]: "Commented",
  [ProvenanceRelationshipKind.Invocation]: "Invoked",
  [ProvenanceRelationshipKind.Usage]: "Used",
  [ProvenanceRelationshipKind.Production]: "Produced",
  [ProvenanceRelationshipKind.Reference]: "Referenced",
};

/**
 * The kinds that make a session a Related Session: it wrote/revised the
 * artifact, or it commented on it. Invocation, usage, and reference are
 * deliberately absent — they are evidence that a session TOUCHED the artifact,
 * not that it contributed to it.
 */
export const RELATED_SESSION_ELIGIBLE_KINDS: readonly ProvenanceRelationshipKind[] =
  [ProvenanceRelationshipKind.Contribution, ProvenanceRelationshipKind.Comment];

/**
 * Every kind — the set for a surface that shows each session with ANY
 * provenance evidence, invocation-only ones included. It exists so such a
 * surface widens the SAME eligibility query rather than adding a second
 * derivation. The artifact Sessions tab that will consume it is S2; today the
 * only wired consumer is Related Sessions, on the narrower set above.
 */
export const ARTIFACT_SESSIONS_TAB_ELIGIBLE_KINDS: readonly ProvenanceRelationshipKind[] =
  [
    ProvenanceRelationshipKind.Contribution,
    ProvenanceRelationshipKind.Comment,
    ProvenanceRelationshipKind.Invocation,
    ProvenanceRelationshipKind.Usage,
    ProvenanceRelationshipKind.Production,
    ProvenanceRelationshipKind.Reference,
  ];

/**
 * Forward-compatibility: the predicate the S2 Related Sessions renderer needs to
 * decide whether a kind it holds belongs in that list. Exported ahead of that
 * consumer so the rule has one owner from the start rather than being
 * reimplemented at the render site.
 */
export function isRelatedSessionEligibleKind(
  kind: ProvenanceRelationshipKind
): boolean {
  return RELATED_SESSION_ELIGIBLE_KINDS.includes(kind);
}
