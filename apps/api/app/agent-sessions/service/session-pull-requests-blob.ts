/**
 * What one payload asks of the legacy `pullRequests` blob on `session_detail`:
 * its own list, an explicit CLEAR, an APPEND of one page, or nothing.
 *
 * Split out of `persist-session-children.ts` (ISS-9859) because the answer now
 * depends on the stored blob as well as the payload, and on the paginated-PR
 * predicate the session→PR link lane uses. One module keeps the four answers in
 * one place.
 */
import type {
  SessionPR,
  SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import type { Prisma } from "@repo/database";
import { sessionPrSchema } from "@/lib/desktop-agent-sessions-schema";
import { isPrRefContinuationPart } from "./artifact-links/session-pr-link-merge";
import { parseJsonArray } from "./coercion";

/**
 * The value the blob patch carries: the list to write, `null` to CLEAR, or
 * `undefined` to leave the column out of the patch (PRESERVE).
 *
 * WHOLE-SET PAYLOADS (ISS-4768). An omitted `prs` is not always "this build
 * does not send PRs": the desktop emits the field only when non-empty, so a
 * current session whose PR set recalculated to EMPTY also omits it. `prRefs`
 * tells the two apart, because every link-extracting build sends it on every
 * whole-set payload.
 *   - `prs` present → write it.
 *   - `prs` omitted, `prRefs` present → the set recalculated to empty. CLEAR,
 *     or the stored blob outlives the sync that retracted it while the same
 *     payload's `prRefs` deletes the links.
 *   - both omitted → a pre-link-extraction build, or a part of a chunk sequence
 *     that carries neither. PRESERVE.
 *
 * CONTINUATION PARTS (ISS-9859). A part {@link isPrRefContinuationPart} marks
 * carries one page of the session's `prs`, so the rules above are wrong for it:
 * writing its page would drop every earlier page, and it can legitimately carry
 * `prRefs` with no `prs` (its page held only links). It may only ADD.
 *   - `prs` non-empty → the stored blob with this page appended
 *     ({@link appendPullRequestsPage}).
 *   - `prs` omitted, null or empty → PRESERVE. Never CLEAR.
 * Page 0 of a sequence carries `prRefsPaginated: false`. It is not a
 * continuation, so it takes the whole-set path and does the one replacement the
 * sequence needs.
 *
 * `storedPullRequests` is the blob the row holds now; `null` when there is no
 * row or no blob. `undefined` means the caller did not read it, and then a
 * continuation part PRESERVES rather than writing its page alone, so a caller
 * that forgets to pass it loses a page instead of every earlier one.
 */
export function resolvePullRequestsBlobPatchInput(
  session: SyncedAgentSession,
  storedPullRequests: Prisma.JsonValue | undefined
): SyncedAgentSession["prs"] | undefined {
  if (isPrRefContinuationPart(session)) {
    if (
      !session.prs ||
      session.prs.length === 0 ||
      storedPullRequests === undefined
    ) {
      return undefined;
    }
    return appendPullRequestsPage(
      parseJsonArray(storedPullRequests, sessionPrSchema),
      session.prs
    );
  }
  if (session.prs !== undefined) {
    return session.prs;
  }
  return session.prRefs === undefined ? undefined : null;
}

/**
 * The stored entries in stored order, then each page entry not already there.
 *
 * "Already there" means `num`, `title` and `status` are all exactly equal, so
 * a redelivered page adds nothing. An entry whose status or title changed
 * between pages is kept as a second entry: the read path
 * (`toSessionPullRequestProjection`) dedupes by PR identity, and deciding which
 * of two observations is current is not this write's job.
 *
 * The stored side is read through the same schema the read path uses, so an
 * entry the read path would drop as malformed is not carried forward.
 */
export function appendPullRequestsPage(
  stored: readonly SessionPR[],
  page: readonly SessionPR[]
): SessionPR[] {
  const merged = [...stored];
  const present = new Set(merged.map(pullRequestEntryKey));
  for (const entry of page) {
    const key = pullRequestEntryKey(entry);
    if (!present.has(key)) {
      present.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

/** `num` keeps its JSON type, so `7` and `"7"` are different entries. */
function pullRequestEntryKey(entry: SessionPR): string {
  return JSON.stringify([entry.num, entry.title, entry.status]);
}
