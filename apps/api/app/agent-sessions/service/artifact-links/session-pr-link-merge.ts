/**
 * ISS-9859: folding one session's PR identities across the PARTS of a paginated
 * sync sequence.
 *
 * `mergePersistedSessionPrRefs` (branch-ref-aggregate.ts) is the canonical
 * identity-keyed fold and stays so — this module does not reimplement it. It
 * already resolves the evidence `method` correctly in both directions: an
 * incoming ref with no `method` deletes the stored one (command-derived wins),
 * and an incoming prose ref over a methodless stored ref leaves it strong.
 *
 * What that fold cannot express, and what pagination needs, is `relationTypes`.
 * It unions them unconditionally, which is right for a whole payload and wrong
 * across parts. `withProseDerivedPrRefs` mints prose refs from `artifactRefs` —
 * which ride EVERY part whole — minus only THAT part's own `prRefs`, so a part
 * carries a prose twin for every PR whose command-derived ref travelled on a
 * different part. Union those and the link keeps a `REFERENCED` that a
 * single-payload delivery never produces, because `proseDerivedSessionPrRefs`
 * subtracts the twin when both are in one payload.
 *
 * The rule is symmetric, and stating it per-identity rather than per-direction
 * is what makes it independent of which part arrived first: a prose-derived ref
 * contributes NO `relationTypes` to an identity that any strong ref claims.
 * Implemented by choosing which refs feed the canonical fold rather than by
 * post-processing its output, so the fold stays the single owner of identity
 * keying, `method` precedence and ordering.
 */
import {
  MAX_SESSION_SYNC_CHUNKS,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import type {
  PersistedSessionPrRef,
  SyncedBranchLifecycleEvent,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  isProseDerivedSessionPrRef,
  sessionPrIdentityKey,
  sessionPrRefsFromMetadata,
} from "@repo/api/src/types/session-artifact-link";
import {
  type BranchRefAggregate,
  hasPullRequestHeadPrIdentity,
  mergePersistedSessionPrRefs,
} from "./branch-ref-aggregate";
import {
  mergeBranchLifecycleEvents,
  readBranchLifecycleEventsFromMetadata,
} from "./shared";

/**
 * One branch's accumulated PR evidence for a single persist pass: the identities
 * that resolved to it, the union of their relation types, and any branch
 * association the PR-head lane materialized.
 *
 * Lives here rather than in `pr-links.ts` because the cross-page fold below is
 * its most intricate consumer, and the persist lane is already the largest file
 * in this directory.
 */
export type PrRefByBranch = {
  relationTypes: Set<SyncedSessionPrRef["relationType"]>;
  refs: Map<string, PrRefByIdentity>;
  branchLifecycleEvents: SyncedBranchLifecycleEvent[];
  branchAssociation?: BranchRefAggregate;
};

export type PrRefByIdentity = {
  relationTypes: Set<SyncedSessionPrRef["relationType"]>;
  repositoryFullName: string;
  prNumber: number;
  /**
   * ISS-5823: the `ArtifactRefMethod` behind this identity, present only for a
   * prose-derived ref. Absent means command-derived, which is what every ref
   * written before ISS-5823 was.
   */
  method?: string;
};

/**
 * ISS-9859: whether a payload's `prRefs` is the session's WHOLE set or one slice
 * of a set paginated across the parts of a chunk sequence.
 *
 * `Replace` is every ordinary payload and the FIRST slice part of a paginated
 * sequence: the declared set is the whole truth, so identities it omits are
 * retracted. `Merge` is a CONTINUATION part — it declares a slice, so it may
 * only add. Retraction for a whole paginated sequence therefore happens once, on
 * its first part, and the parts after it are purely additive. That is what lets
 * pagination work with no cross-request ledger and no commit-time sweep.
 */
export const SessionPrLinkWriteMode = {
  Replace: "replace",
  Merge: "merge",
} as const;
export type SessionPrLinkWriteMode =
  (typeof SessionPrLinkWriteMode)[keyof typeof SessionPrLinkWriteMode];

/**
 * Fold PR identities delivered across separate parts of one chunk sequence.
 *
 * Order-independent: passing the same groups in either order yields the same
 * result, which is what lets a continuation part merge against a stored link
 * without knowing which part wrote it.
 */
export function mergeSessionPrRefsAcrossPages(
  ...groups: readonly (readonly PersistedSessionPrRef[] | undefined)[]
): PersistedSessionPrRef[] {
  const byIdentity = new Map<
    string,
    { strong: PersistedSessionPrRef[]; prose: PersistedSessionPrRef[] }
  >();
  for (const group of groups) {
    for (const ref of group ?? []) {
      const identity = sessionPrIdentityKey(
        ref.repositoryFullName,
        ref.prNumber
      );
      const tiers = byIdentity.get(identity) ?? { strong: [], prose: [] };
      if (isProseDerivedSessionPrRef(ref)) {
        tiers.prose.push(ref);
      } else {
        tiers.strong.push(ref);
      }
      byIdentity.set(identity, tiers);
    }
  }
  // One identity contributes its strong refs when it has any, else its prose
  // refs — never both, which is the whole of the rule. The canonical fold then
  // does the keying, the `method` precedence and the ordering exactly as it does
  // for a whole payload.
  const selected = [...byIdentity.values()].flatMap((tiers) =>
    tiers.strong.length > 0 ? tiers.strong : tiers.prose
  );
  return mergePersistedSessionPrRefs(selected);
}

/**
 * The link-level `relationTypes` for a set of folded refs.
 *
 * Derived FROM the folded refs, never from the stored link's own
 * `relationTypes` — that column is the union the previous write computed, so
 * seeding from it would re-import the prose `REFERENCED` this fold just
 * withheld. Mirrors `mergePrIdentityMetadata` (session-branch-link-writer.ts),
 * which derives the same field the same way.
 */
export function relationTypesFromPrRefs(
  prRefs: readonly PersistedSessionPrRef[]
): PersistedSessionPrRef["relationTypes"] {
  return [...new Set(prRefs.flatMap((ref) => ref.relationTypes))].sort();
}

/** One branch's in-memory identities as the persisted, canonically-ordered shape. */
export function persistedPrRefs(ref: PrRefByBranch): PersistedSessionPrRef[] {
  return [...ref.refs.values()]
    .map((entry) => ({
      repositoryFullName: entry.repositoryFullName,
      prNumber: entry.prNumber,
      relationTypes: [...entry.relationTypes].sort(),
      ...(entry.method ? { method: entry.method } : {}),
    }))
    .sort((left, right) => {
      const repositoryOrder = sessionPrIdentityKey(
        left.repositoryFullName,
        0
      ).localeCompare(sessionPrIdentityKey(right.repositoryFullName, 0));
      return repositoryOrder || left.prNumber - right.prNumber;
    });
}

/**
 * ISS-9859: fold a stored link's identities and lifecycle events INTO the slice
 * a continuation part carries, so the upsert still writes a whole link.
 *
 * Three fields, and each is wrong in a different way if taken from the obvious
 * place:
 *
 * - `refs` go through {@link mergeSessionPrRefsAcrossPages} rather than a plain
 *   union, because a part mints a prose twin for every PR whose command-derived
 *   ref travelled on a DIFFERENT part. Union those and the link keeps a
 *   `REFERENCED` a single-payload delivery never produces.
 * - `relationTypes` are recomputed from the FOLDED refs by the caller, never
 *   copied from the stored link's own `relationTypes` — that column is the union
 *   a previous write computed, so seeding from it would re-import exactly the
 *   prose relation the fold just withheld.
 * - `branchLifecycleEvents` are seeded UNCONDITIONALLY, unlike
 *   `buildSessionPrLinkMetadata`, which re-reads them only when the link
 *   independently established its branch. On a PR-only link that condition is
 *   false, so a continuation part touching a branch an earlier part wrote would
 *   otherwise drop the events that part recorded.
 */
export function foldStoredLinkIntoBranchRef(
  ref: PrRefByBranch,
  storedMetadata: unknown
): void {
  replaceBranchRefIdentities(
    ref,
    mergeSessionPrRefsAcrossPages(
      sessionPrRefsFromMetadata(storedMetadata),
      persistedPrRefs(ref)
    )
  );
  ref.branchLifecycleEvents = mergeBranchLifecycleEvents(
    readBranchLifecycleEventsFromMetadata(storedMetadata),
    ref.branchLifecycleEvents
  );
}

/**
 * ISS-9859 (review, davetho): fold the PR-head association's identities into
 * the branch's refs under the same strong-over-prose rule, in BOTH write modes.
 *
 * The association is built from a provider-verifiable PR artifact ref (never a
 * prose one) and its refs carry no `method`, so the branch-link writer's
 * generic union (`mergePrIdentityMetadata`) reads them as strong and unions
 * their relation types into the link. When the only ref a part holds for that
 * identity is a prose twin, the union promotes the twin's `REFERENCED` to
 * strong evidence, and no later part can take it back. Paginated delivery hits
 * this whenever page 0 carries the twin and a later page carries the strong
 * ref. A whole payload never does: `proseDerivedSessionPrRefs` drops the twin
 * once the strong ref is in the same payload.
 *
 * After this fold every association identity in `ref.refs` is strong and holds
 * a superset of the association's relation types, so the writer's union adds
 * nothing. Gated on the writer's own acceptance predicate, so an association
 * the writer ignores is ignored here too.
 */
export function foldBranchAssociationIntoBranchRef(ref: PrRefByBranch): void {
  const association = ref.branchAssociation;
  if (!(association && hasPullRequestHeadPrIdentity(association))) {
    return;
  }
  replaceBranchRefIdentities(
    ref,
    mergeSessionPrRefsAcrossPages(persistedPrRefs(ref), association.prRefs)
  );
}

/**
 * ISS-9859: whether this payload is a CONTINUATION part of a paginated PR
 * sequence, carrying one page of the session's PR set rather than all of it.
 *
 * The ONE predicate both PR lanes read. The link lane merges on it
 * (`session-pr-link-persistence.ts`) and the `pullRequests` blob appends on it
 * (`session-pull-requests-blob.ts`). A part one lane treats as a page and the
 * other as the whole set leaves the blob and the links describing different PR
 * sets.
 *
 * Requires the producer's marker AND a chunk position a real sequence can have.
 * The non-zero index is not redundant: page 0 of a sequence carries `false`
 * (`isPaginatedPrListPageZero`), so it replaces and retracts for the whole
 * sequence, and a `true` payload with no chunk would otherwise never retract
 * anything. The `total`
 * ceiling is the producer's own. Both fields are client-controlled and the wire
 * schema bounds `total` from below only, so without the ceiling a chunk 0
 * declaring a huge `total` opens a sequence that never commits, and every
 * marked part after it merges with no retraction ever running (review,
 * davetho).
 *
 * Anything else falls back to Replace, never to a rejection. Rejecting the
 * payload would drop the session's events with it (agent-sessions `AGENTS.md`,
 * "Chunking"), while Replace retracts, so nothing accumulates.
 */
export function isPrRefContinuationPart(
  session: Pick<SyncedAgentSession, "prRefsPaginated" | "chunk">
): boolean {
  const chunk = session.chunk;
  return (
    session.prRefsPaginated === true &&
    isRealSequencePosition(chunk) &&
    chunk.index > 0
  );
}

/**
 * ISS-9859: whether this payload is PAGE 0 of a paginated PR list, the first
 * PR-list part of a sequence, which the producer marks `prRefsPaginated: false`
 * explicitly. Base parts and whole-set payloads carry no key.
 *
 * Page 0 is a whole-set replace for both PR lanes, like any payload without
 * the key.
 * What the explicit marker adds is admission at the freshness TIE
 * (`resolveSessionFreshnessGates`). Base parts land first and store the
 * sequence's `updatedAt`, so page 0 always ties; without admission its blob
 * CLEAR or empty link replace is skipped, and the next sync's pages append onto
 * a stale blob. The ISS-4946 tie rule guards a race between two snapshots from
 * legacy builds that share one `updatedAt`, and no such build sends `false`:
 * the marker exists only for a server that advertised
 * `agentSessionSyncPrRefChunking`.
 *
 * Index 0 is legal here, since page 0 may open the sequence. The other bounds
 * are the continuation predicate's, for the same reasons.
 */
export function isPaginatedPrListPageZero(
  session: Pick<SyncedAgentSession, "prRefsPaginated" | "chunk">
): boolean {
  return (
    session.prRefsPaginated === false && isRealSequencePosition(session.chunk)
  );
}

/** A chunk marker a sequence the producer can build actually has. */
function isRealSequencePosition(
  chunk: SyncedAgentSession["chunk"]
): chunk is NonNullable<SyncedAgentSession["chunk"]> {
  return (
    chunk != null &&
    Number.isInteger(chunk.index) &&
    Number.isInteger(chunk.total) &&
    chunk.index >= 0 &&
    chunk.index < chunk.total &&
    chunk.total <= MAX_SESSION_SYNC_CHUNKS
  );
}

function replaceBranchRefIdentities(
  ref: PrRefByBranch,
  folded: readonly PersistedSessionPrRef[]
): void {
  ref.refs = new Map(
    folded.map((entry) => [
      sessionPrIdentityKey(entry.repositoryFullName, entry.prNumber),
      {
        relationTypes: new Set(entry.relationTypes),
        repositoryFullName: entry.repositoryFullName,
        prNumber: entry.prNumber,
        ...(entry.method ? { method: entry.method } : {}),
      },
    ])
  );
  ref.relationTypes = new Set(relationTypesFromPrRefs(folded));
}
