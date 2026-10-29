import { isIssueLifecycleSubtype } from "@closedloop-ai/loops-api/document";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  IssueStatus,
  isTerminalStatusForSubtype,
  statusOptionsForSubtype,
  TERMINAL_DOCUMENT_STATUSES,
  TERMINAL_ISSUE_STATUSES,
} from "@repo/api/src/types/document";
import { ArtifactSubtype, type Prisma } from "@repo/database";

/**
 * Decision core for auto-clearing a stale `BLOCKED` artifact (ISS-9632).
 *
 * `BLOCKS` edges carried no status semantics before this: when the artifact on
 * the source side of the edge reached a terminal status, nothing moved what it
 * had been blocking, so the dependent stayed `BLOCKED` forever. A stale
 * `BLOCKED` row is invisible to everything that reads `TODO`, so the work
 * behind it stops with no signal — it reads as an empty queue, not a failure.
 *
 * Pure on purpose: every rule below is decided from plain rows, so the DB
 * wiring in `blocked-dependent-unblock-service.ts` stays thin and these rules
 * are testable without a database or a query mock.
 */

/**
 * The status a dependent moves to once its last blocker resolves.
 *
 * `Artifact.status` is one freeform `String` column shared by two disjoint
 * vocabularies (PRD-495), and `TODO` belongs only to the Issue lifecycle. A
 * Document-lifecycle artifact carrying a stray `BLOCKED` — reachable, because
 * the column has no DB-level enum — has no `TODO` to move to, so
 * {@link acceptsUnblockDestination} gates the write rather than persisting a
 * value the artifact's own vocabulary rejects.
 */
export const UNBLOCKED_STATUS = IssueStatus.Todo;

/** The status a dependent must currently hold to be eligible to move. */
export const BLOCKED_STATUS = IssueStatus.Blocked;

/**
 * One inbound `BLOCKS` edge, paired with the artifact it comes from.
 *
 * `source` is null when that artifact could not be resolved inside the
 * dependent's own organization. `ArtifactLink.organizationId` is a plain column
 * with nothing forcing it to agree with its endpoints' orgs, so a link stamped
 * with one org can point at another org's artifact; such a source is never read
 * and never trusted. It is treated as STILL BLOCKING — see
 * {@link selectUnblockableIds}.
 */
export type InboundBlockerRow = {
  targetId: string;
  source: { subtype: string | null; status: string } | null;
};

/** A dependent already narrowed to `status = BLOCKED` by the caller's query. */
export type BlockedCandidateRow = {
  id: string;
  subtype: string | null;
};

/**
 * Whether {@link UNBLOCKED_STATUS} is a legal destination for this subtype,
 * asked of the canonical vocabulary selector rather than re-derived here. This
 * is the guard that keeps a Document-lifecycle artifact from being written to
 * `TODO`.
 */
export function acceptsUnblockDestination(
  subtype: string | null | undefined
): boolean {
  return statusOptionsForSubtype(subtype).includes(UNBLOCKED_STATUS);
}

/**
 * Of `candidates` (all currently `BLOCKED`), the ids whose blockers have ALL
 * resolved and whose vocabulary accepts `TODO`.
 *
 * A candidate is unblockable when every one of these holds:
 *
 * 1. Its subtype accepts {@link UNBLOCKED_STATUS} (see above).
 * 2. It has AT LEAST ONE inbound `BLOCKS` edge in `inboundBlockers`. An
 *    artifact somebody parked in `BLOCKED` with no edge at all is not evidence
 *    of the defect this fixes — it is an unmodelled manual block — and moving
 *    it would be an unrequested, destructive reinterpretation of a human's
 *    status. Requiring an edge keeps the sweep to the population the ticket
 *    describes.
 * 3. Every one of those edges comes from a terminal source, per
 *    `isTerminalStatusForSubtype` — the canonical, subtype-aware predicate. A
 *    blocker that was resolved by DELETING the edge instead of terminalizing
 *    the artifact needs no special case: the row is simply absent from
 *    `inboundBlockers`, so it cannot hold the dependent.
 * 4. An edge whose `source` is null — unresolvable inside the dependent's own
 *    organization — counts as STILL BLOCKING. Failing the other way would let
 *    an artifact we cannot even read decide that someone else's work is ready,
 *    and would make a cross-org link row a lever on this org's data. Anything
 *    we cannot prove terminal keeps the dependent blocked.
 *
 * Cycles are representable (A blocks B, B blocks A) and need no cycle
 * detection: the only status this ever writes is {@link UNBLOCKED_STATUS},
 * which is NOT terminal for any vocabulary, so an unblock can never make some
 * other artifact's blocker terminal and no cascade is reachable. One pass is
 * the whole fixpoint.
 */
export function selectUnblockableIds(params: {
  candidates: readonly BlockedCandidateRow[];
  inboundBlockers: readonly InboundBlockerRow[];
}): string[] {
  const stillBlocked = new Set<string>();
  const hasAnyBlocker = new Set<string>();
  for (const edge of params.inboundBlockers) {
    hasAnyBlocker.add(edge.targetId);
    if (
      edge.source === null ||
      !isTerminalStatusForSubtype(edge.source.subtype, edge.source.status)
    ) {
      stillBlocked.add(edge.targetId);
    }
  }

  return params.candidates
    .filter(
      (candidate) =>
        acceptsUnblockDestination(candidate.subtype) &&
        hasAnyBlocker.has(candidate.id) &&
        !stillBlocked.has(candidate.id)
    )
    .map((candidate) => candidate.id);
}

/**
 * The subtypes on the Issue (delivery) vocabulary, derived from the canonical
 * discriminator rather than listed. {@link liveBlockerEdgeFilter} has to express
 * that discriminator to Postgres, which cannot call the TypeScript predicate, so
 * this enumerates it over the whole persisted enum — adding a subtype to either
 * vocabulary changes this list with no edit here.
 */
const ISSUE_LIFECYCLE_SUBTYPES: ArtifactSubtype[] = Object.values(
  ArtifactSubtype
).filter((subtype) => isIssueLifecycleSubtype(subtype));

/**
 * "This inbound edge is a LIVE blocker" — the negation of the rule
 * {@link selectUnblockableIds} applies to `inboundBlockers`, expressed as a
 * Prisma predicate over `ArtifactLink` so the DATABASE can answer it.
 *
 * This exists so the unblock write can re-assert the blocker rule inside its own
 * `WHERE` instead of trusting ids a separate, earlier statement produced (whitlockk,
 * ISS-9632 review). Between that read and the write a blocker can be reopened,
 * or a brand-new `BLOCKS` edge inserted, either of which would otherwise leave
 * the dependent sitting in `TODO` with a live blocker — irrecoverably, since
 * nothing reconsiders a row that has left `BLOCKED`. Asked as part of the update
 * it is a `NOT EXISTS` the planner evaluates against the rows as they are at
 * write time, not a lock on anything.
 *
 * Matched by the `targetLinks` RELATION, deliberately not by
 * `ArtifactLink.organizationId`: that stamp is a plain column with nothing
 * tying it to either endpoint, so filtering on it would hide a mis-stamped edge,
 * and an edge the guard cannot see cannot decline the write. The edge is found
 * by its endpoint and judged by its SOURCE's own org — a source outside the
 * dependent's organization is a live blocker, the same fail-closed direction
 * rule 4 above takes.
 *
 * The three status clauses partition `subtype` exhaustively: Issue subtypes,
 * other non-null subtypes, and `null`. The null clause is not redundant — SQL
 * `NOT IN` never matches `NULL`, so without it a subtype-less blocker would fall
 * out of every clause and read as resolved.
 */
export function liveBlockerEdgeFilter(
  organizationId: string
): Prisma.ArtifactLinkWhereInput {
  const terminalIssueStatuses = [...TERMINAL_ISSUE_STATUSES];
  const terminalDocumentStatuses = [...TERMINAL_DOCUMENT_STATUSES];

  return {
    linkType: LinkType.Blocks,
    source: {
      OR: [
        { organizationId: { not: organizationId } },
        {
          subtype: { in: ISSUE_LIFECYCLE_SUBTYPES },
          status: { notIn: terminalIssueStatuses },
        },
        {
          subtype: { notIn: ISSUE_LIFECYCLE_SUBTYPES },
          status: { notIn: terminalDocumentStatuses },
        },
        { subtype: null, status: { notIn: terminalDocumentStatuses } },
      ],
    },
  };
}
