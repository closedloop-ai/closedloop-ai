/**
 * @file artifact-ref-budget.ts
 * @description ISS-4448+4449 — the desktop PRODUCER budgeting for a session's
 * non-commit `artifactRefs` (the `closedloop_artifact` / `branch` /
 * `pull_request` kinds) before they are emitted on the sync wire.
 *
 * Extracted from the grandfathered `sync-source.ts` (shrink-only) as a pure,
 * unit-testable helper. The whole non-commit array shares a single producer
 * budget (`MAX_SYNCED_ARTIFACT_REFS_PRODUCER`, 100) that stays well under the
 * raised cloud validator cap (`MAX_SYNCED_ARTIFACT_REFS`, 500) so a new desktop
 * never emits an array an old `.max(100)` cloud would reject and dead-letter.
 *
 * The bug this closes: the old code sliced the combined non-commit array with a
 * single `slice(0, 100)`. Refs are ordered oldest-first and PR refs frequently
 * arrive ahead of document refs, so a PR-heavy session (e.g. 88 PR refs then 23
 * document refs) consumed all 100 slots with PRs and dropped every document ref
 * past slot 100 — real linked documents silently lost before they ever reached
 * the cloud, while the post-persist `linkedArtifactsTotal` reported the
 * survivors as complete.
 *
 * The fix keeps the same 100-slot producer total (deploy-order-safe) but
 * guarantees `closedloop_artifact` (document) refs a floor of slots
 * (`MIN_SYNCED_DOCUMENT_REFS_PRODUCER`) so they cannot be starved to zero.
 * PR-kind refs also ride the dedicated `prRefs` channel, so reserving a
 * document floor here costs nothing that isn't recoverable on the PR side.
 */
import {
  ArtifactRefMethod,
  ArtifactRefTargetKind,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
  MIN_SYNCED_DOCUMENT_REFS_PRODUCER,
  PROSE_MENTION_REF_METHODS,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";

/**
 * Bound the combined non-commit `artifactRefs` to the desktop producer total
 * (`MAX_SYNCED_ARTIFACT_REFS_PRODUCER`), guaranteeing `closedloop_artifact`
 * (document) refs a floor of `MIN_SYNCED_DOCUMENT_REFS_PRODUCER` slots so a
 * ref-heavy session of any other kind cannot starve document links to zero.
 *
 * Input MUST already be commit-free (the caller filters commits out first —
 * commit refs are lowest priority and fill only the remaining total budget).
 * Input order is preserved (oldest-first), so the earliest refs of each kind
 * are the ones kept. Returns at most `MAX_SYNCED_ARTIFACT_REFS_PRODUCER` refs.
 */
export function boundNonCommitArtifactRefs(
  nonCommitRefs: readonly SyncedArtifactRef[],
  commitRefCount = 0
): SyncedArtifactRef[] {
  // A caller always passes an array length, but clamp anyway: a negative would
  // INFLATE the prose `spare` below rather than fail loudly.
  const reservedForCommits = Math.max(0, commitRefCount);
  // ISS-5764 (review): the pass-through must account for the caller's commits,
  // not just the non-commit array. Gating on `nonCommitRefs.length` alone let a
  // set that fits on its own skip the shedding path entirely, so 60 documents +
  // 10 command refs + 20 prose (90 ≤ 100) returned all 90 and left the caller
  // only 10 of its 30 commit slots — 20 commit refs evicted by prose mentions,
  // the exact inversion of the priority this function exists to enforce. With
  // no prose refs present the shedding path is a no-op, so this only ever
  // changes the case it is meant to.
  if (
    nonCommitRefs.length + reservedForCommits <=
    MAX_SYNCED_ARTIFACT_REFS_PRODUCER
  ) {
    return [...nonCommitRefs];
  }

  const documentRefs = nonCommitRefs.filter(
    (ref) => ref.kind === ArtifactRefTargetKind.ClosedloopArtifact
  );
  // ISS-5764: weakest-evidence refs are budgeted SEPARATELY, not as ordinary
  // "other" refs. They are purely additive, so they must never take a slot
  // another kind would have used. Folding them into `otherRefs` was measurably
  // destructive: a session with 60 documents, 10 command PR refs and 30 commits
  // — 70 refs, comfortably UNDER the budget today — dropped to 50 documents and
  // ZERO commits once a few hundred prose mentions joined the array, because
  // `otherBudget` saturated and both the document budget and the caller's
  // commit remainder collapsed. That is the exact silent-loss class
  // ISS-4448+4449 fixed, re-entering through the commit/document door.
  //
  // ISS-6479: the tier is keyed on WEAKEST_EVIDENCE_REF_METHODS, not on
  // PROSE_MENTION_REF_METHODS, so the equally weak `url_in_message` PR/branch
  // refs shed here too instead of starving commits from the top tier. The kind
  // guard matters for that method: it is also how a `closedloop_artifact`
  // document URL ref is minted, and those belong to the document floor above,
  // never to this tier.
  const weakestEvidenceRefs = nonCommitRefs.filter(
    (ref) =>
      ref.kind !== ArtifactRefTargetKind.ClosedloopArtifact &&
      WEAKEST_EVIDENCE_REF_METHODS.has(ref.method)
  );
  const otherRefs = nonCommitRefs.filter(
    (ref) =>
      ref.kind !== ArtifactRefTargetKind.ClosedloopArtifact &&
      !WEAKEST_EVIDENCE_REF_METHODS.has(ref.method)
  );

  // Reserve the document floor, then let non-document refs fill whatever the
  // documents did not actually need. Clamp the floor to the total budget and to
  // how many document refs actually exist so a document-light session hands its
  // spare reserved slots back to the other kinds.
  const reservedForDocuments = Math.min(
    MIN_SYNCED_DOCUMENT_REFS_PRODUCER,
    documentRefs.length,
    MAX_SYNCED_ARTIFACT_REFS_PRODUCER
  );
  const otherBudget = Math.max(
    0,
    MAX_SYNCED_ARTIFACT_REFS_PRODUCER - reservedForDocuments
  );
  const keptOther = otherRefs.slice(0, otherBudget);
  // Documents may exceed their reserved floor when other refs left the budget
  // under-filled — grant them the leftover slots too.
  const documentBudget = Math.max(
    0,
    MAX_SYNCED_ARTIFACT_REFS_PRODUCER - keptOther.length
  );
  const keptDocuments = documentRefs.slice(0, documentBudget);

  // Weakest-evidence refs get ONLY what documents, command refs, and the
  // caller's commit refs all left unused. `commitRefCount` is reserved rather
  // than ignored because the caller appends commits from whatever this function
  // did not spend, so a mention taken here is a commit ref deleted there.
  const spare = Math.max(
    0,
    MAX_SYNCED_ARTIFACT_REFS_PRODUCER -
      keptOther.length -
      keptDocuments.length -
      Math.min(reservedForCommits, MAX_SYNCED_ARTIFACT_REFS_PRODUCER)
  );
  const keptWeakestEvidence = weakestEvidenceRefs.slice(0, spare);

  // Re-interleave into the original oldest-first order so the kept set is a
  // stable subsequence of the input (the projection/consumer order does not
  // depend on kind grouping).
  const kept = new Set<SyncedArtifactRef>([
    ...keptDocuments,
    ...keptOther,
    ...keptWeakestEvidence,
  ]);
  return nonCommitRefs.filter((ref) => kept.has(ref));
}

/**
 * ISS-6479: the methods THIS budget sheds last — a ref whose only evidence is a
 * passive mention, so admitting one as an ordinary "other" ref DELETES a
 * stronger ref rather than merely adding a weak one.
 *
 * `PROSE_MENTION_REF_METHODS` alone is not that set. ISS-6060 added
 * `url_in_message` PR/branch refs (`addHumanUrlRefs` — a GitHub link pasted in
 * a human message, one ref per URL per message) carrying exactly the prose
 * tier's evidence (`confidence: url_match`, `relation: referenced`,
 * `isPrimary: false`), but they landed in `otherRefs`, the tier filled FIRST.
 * Their own carrier caps them at `MAX_SYNCED_ARTIFACT_REFS_PRODUCER`, which is
 * no protection here: one cap's worth alone fills this whole budget, and the
 * caller's `commitRefs.slice` then gets nothing.
 *
 * Shedding these is a real loss of monitored-session-activity evidence, not a
 * free win — every one of them is an ISS-6060 activity carrier. It is the
 * ordering ISS-6479 asks for because commit refs carry the
 * `linesAdded`/`linesRemoved`/`filesChanged` that branch and PR LOC attribution
 * reads, and a mention that outranks them inverts the priority this whole
 * function exists to enforce.
 *
 * Deliberately local rather than folded into `PROSE_MENTION_REF_METHODS`: that
 * set has three other consumers whose semantics this shedding order does not
 * speak for (the adjudicating `prRefs` carrier in `sync-source.ts`, the
 * non-delivery SQL predicate in `non-delivery-artifacts.ts`, and the cloud
 * branch-link reader). `ArtifactRefMethod.UrlInMessage` is also how a
 * `closedloop_artifact` document URL ref is minted — the extractor's
 * second-strongest primary-selection method, not a mention — so membership here
 * is only ever read together with the non-document kind guard at the call site.
 */
const WEAKEST_EVIDENCE_REF_METHODS: ReadonlySet<string> = new Set<string>([
  ...PROSE_MENTION_REF_METHODS,
  ArtifactRefMethod.UrlInMessage,
]);
