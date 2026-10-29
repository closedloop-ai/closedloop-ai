"use client";

import { Badge } from "@repo/design-system/components/ui/badge";

/**
 * ISS-8597 (PRD-699 §5 D2): what a comment whose cloud delivery was permanently
 * rejected shows its author — the failed badge, and the one action that can move
 * it.
 *
 * NO FLAG READ, by operator ruling 2026-09-16, and the absence is the point. A
 * second read here could only ever SUBTRACT — hiding the recovery door from a row
 * that is already terminal, which is the violation
 * `apps/desktop/src/main/sync/AGENTS.md` invariant 5 forbids.
 *
 * The DESKTOP terminal write is gated on `trace-comment-sync-abandoned`, so on
 * that path `syncAbandoned` can only be set by the feature itself. ISS-10382
 * added a cloud writer (`POST .../sync-abandoned`) which is authenticated and
 * author-scoped but NOT flag-gated, so "closed by construction" now rests on
 * that endpoint having no caller rather than on a server-side key. Once
 * ISS-10827 wires the desktop producer, the flag-gated drain is again the only
 * thing that calls it.
 *
 * ISS-10383 moved it here, to the module owning the trace-comments port, so the
 * Sessions rail and the Branches comment card reach ONE implementation and
 * cannot drift about what a dead letter looks like or who offers a way out.
 *
 * Its CALLER decides whether the comment is dead-lettered; this decides what
 * that looks like. A badge with no retry button is the honest render for a
 * source that cannot re-pend, not a reason to hide the failure.
 *
 * ## ISS-10827: the badge is SCOPED, and that is a copy change, not a gate
 *
 * `syncAbandoned` is served to every viewer of the thread, not only its author,
 * and ISS-10827 is what makes a cloud row carry it at all — so from here on a
 * READER opens somebody else's session and sees this. The approved wording was
 * written for the author, who can act on it; to a reader "Sync failed" asserts a
 * failure about the comment they are reading successfully out of the cloud, and
 * that reading is simply false.
 *
 * What actually failed is narrower and sayable. The cloud can only carry this on
 * a comment whose root already LANDED — a dead-lettered create never reached the
 * cloud, so no row exists there to mark (`packages/api/src/types/comment.ts`) —
 * so the badge on a reader's screen always means the AUTHOR'S EDIT did not
 * arrive, and the body below it is the last version that did. The reader copy
 * says that: whose delivery failed, of what, and by carrying no control, that it
 * is not theirs to fix.
 *
 * "NEVER synced" rather than "not synced", because the state is TERMINAL. The
 * lane has stopped; nothing will deliver that edit unless its author acts. "not
 * synced" reads as in-flight — the state this row was in for its whole retry
 * ladder and is no longer in — and would leave a reader waiting for a correction
 * that is not coming, or quoting a body believing the newer one is about to land.
 *
 * THE CLOUD IS WHERE THIS CLAIM IS EXACT. The desktop shell derives
 * `syncAbandoned` from its own local queue, where an abandoned CREATE is
 * representable and "edit" would be the wrong noun — but the queue holds only
 * rows this machine authored, whose `canEdit` is true, so that shell takes the
 * author's wording. The reader string is a statement about the cloud-backed
 * read, which is the only place a non-author can see this field at all.
 *
 * NOT A SECOND GATE. Both viewers get a badge, in the same slot, with the same
 * `variant` and `role`, off the same field and with no flag read. Hiding it from
 * readers is the subtraction the operator ruling of 2026-09-16 forbids, and this
 * deliberately is not that.
 *
 * `isAuthor` is REQUIRED rather than defaulted, so a third render site cannot
 * silently inherit one audience's wording for the other's. It is the authorship
 * the SERVER computes (`canEdit`), which is also what the retry route enforces —
 * not "did this surface hand me a retry handler", which is additionally false
 * for an author whose source cannot re-pend.
 */
export function SyncAbandonedNotice({
  commentId,
  isAuthor,
  onRetrySync,
}: Readonly<{
  commentId: string;
  isAuthor: boolean;
  onRetrySync?: (commentId: string) => void;
}>) {
  return (
    <>
      {/*
       * `role="status"` so a screen reader is told when the badge APPEARS after
       * a failed retry, and when it leaves after a successful one. Without it
       * the only non-visual feedback is the error toast, which says nothing on
       * success.
       */}
      <Badge role="status" variant="error">
        {isAuthor ? "Sync failed" : "Author's edit never synced"}
      </Badge>
      {onRetrySync ? (
        <button
          aria-label="Retry syncing trace note"
          className="fp-retry-btn"
          onClick={(event) => {
            // `stopPropagation` alone, matching the Sessions rail's Edit /
            // Delete / Reply controls, whose card IS click-to-jump. A no-op on
            // the Branches card, which is not. The composers' extra
            // `data-comment-control` marker is a SECOND mechanism, and carrying
            // both would leave either one free to rot untested.
            event.stopPropagation();
            onRetrySync(commentId);
          }}
          title="Retry sync"
          type="button"
        >
          Retry
        </button>
      ) : null}
    </>
  );
}
