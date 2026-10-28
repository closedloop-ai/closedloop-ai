/**
 * @file agent-session-sync-pr-ref-chunking.ts
 * @description ISS-9859 — the pieces of the PR-list pagination decision that
 * are not the chunker itself, kept out of `agent-session-sync-payload.ts` so
 * that file stays under the 1,000-line ceiling.
 *
 * A session states its PRs in two lists: `prRefs` (the link identities) and the
 * legacy `prs` blob. The producer caps neither, so either one alone can grow
 * past what a part can replicate. Both ride EVERY part whole, exactly as they
 * always have, and are split across parts only when all three hold: the server
 * advertised `agentSessionSyncPrRefChunking` (it merges a part marked
 * `prRefsPaginated` instead of replacing), the session carries PR data at all,
 * and the PR lists are why the replicated split failed. That last condition is
 * what {@link prListsCausedTheSplitFailure} answers, and it matters: a session
 * that fails on the event or tiling chunk budget is not helped by paginating a
 * handful of PRs, and paginating it anyway would put it on the merge path for no
 * gain.
 *
 * The two lists page together because paginating one alone leaves the other
 * replicated whole into every part, and a session with enough PRs then
 * dead-letters on that list despite the negotiated capability.
 */
import type { SessionPR } from "@repo/api/src/types/agent-session";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";

/**
 * `session` with `prRefs` and `prs` both OMITTED (keys absent, not `[]`).
 *
 * The replicated base of a paginated split. Absent is the cloud's "this part
 * makes no claim": the link lane early-returns on an undefined `prRefs`, and an
 * undefined `prs` leaves the stored blob alone. An explicit `[]` on an unmarked
 * part would mean the opposite, a retraction of every PR, which on a part that
 * carries no slice would wipe the links before the first slice landed.
 */
export function sessionWithoutPrLists(
  session: SyncedAgentSession
): SyncedAgentSession {
  const { prRefs: _omittedRefs, prs: _omittedPrs, ...rest } = session;
  return rest;
}

/** Does this session have PR data a capable server could merge across parts? */
export function canPaginatePrLists(
  session: SyncedAgentSession,
  prRefChunkingSupported: boolean
): boolean {
  return (
    prRefChunkingSupported &&
    ((session.prRefs?.length ?? 0) > 0 || (session.prs?.length ?? 0) > 0)
  );
}

/**
 * Were the PR lists the reason the replicated split produced no chunk?
 *
 * Answered by re-splitting the same session with both lists removed: if that
 * still produces nothing, the session is unchunkable for some other reason
 * (its events or tiling exhausted the chunk budget, or the base alone exceeds
 * the cap) and pagination cannot rescue it.
 */
export function prListsCausedTheSplitFailure(
  splitWithoutPrLists: readonly SyncedAgentSession[]
): boolean {
  return splitWithoutPrLists.length > 0;
}

/**
 * Settle the `prRefsPaginated` marker on a split's PR-list parts, in place: the
 * FIRST keeps `false`, every later one becomes `true`.
 *
 * The first part is page 0. An explicit `false` with a chunk marker is the
 * cloud's "page 0 of a paginated sequence": a whole-set REPLACE of both PR
 * lists, admitted even at a freshness tie. An absent marker is not enough. The
 * base parts land first and store the sequence's `updatedAt`, so page 0 always
 * arrives at a tie, and the ISS-4946 tie rule skips a destructive write from a
 * part with no evidence of its own. The skipped clear would let the later parts
 * append onto a stale blob, which shows as phantom PRs after a re-sync.
 *
 * When the session declared `prRefs`, page 0 always carries the key (a slice,
 * or `[]` when the refs are empty or already behind it), so it prunes,
 * downgrades and deletes the link identities the session no longer declares.
 * Its `prs` replaces the stored blob, or, omitted, clears it for the later
 * parts to union theirs back in. That is why this design needs no
 * cross-request ledger and no commit-time sweep.
 *
 * Every PR-list part is BUILT with `false`, the wider value, so sizing
 * reserves its bytes and flipping a continuation to `true` only shrinks its
 * JSON. Base parts carry no marker, so the scan finds only PR-list parts,
 * wherever they fall: normally after the event parts, at index 0 for a session
 * with no events and no paginated tiling. A split that paginates nothing has
 * no marked part and is left byte-identical.
 *
 * Correctness rests on the desktop draining a sequence SERIALLY in index order
 * (`resolvePendingChunkTransition` shifts one chunk per tick and the next is not
 * sent until the previous acks), so page 0 is always applied before the parts
 * that merge onto it.
 *
 * Applied AFTER packing rather than inside the chunk builder because the packer
 * calls `buildChunk([])` to measure an empty chunk before it fills one; a
 * builder that decided markedness from call order would mark the wrong part.
 */
export function markPrListContinuations(chunks: SyncedAgentSession[]): void {
  const prListParts = chunks.filter((chunk) => chunk.prRefsPaginated === false);
  for (const continuation of prListParts.slice(1)) {
    continuation.prRefsPaginated = true;
  }
}

/**
 * The two PR-list streams a split packs: the session's own lists when this
 * split paginates them, which the caller does only after proving they are why
 * the replicated split produced no chunk, and empty otherwise, which packs
 * nothing.
 */
export function paginatedPrListStreams(
  session: SyncedAgentSession,
  paginating: boolean
): {
  prRefs: NonNullable<SyncedAgentSession["prRefs"]>;
  prs: SessionPR[];
} {
  return paginating
    ? { prRefs: session.prRefs ?? [], prs: session.prs ?? [] }
    : { prRefs: [], prs: [] };
}
