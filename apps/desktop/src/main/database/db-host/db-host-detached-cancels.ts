/**
 * @file db-host-detached-cancels.ts
 * @description ISS-9802 — the cancellations main receives while it has NO child
 * to forward them to, extracted from `db-host-client.ts` so that file stays
 * under the size ceiling (the same reason, and the same ticket, that produced
 * `db-host-post-failure.ts`).
 *
 * A read parked on `DbHostClient.ready` during the crash-ladder backoff still
 * holds its token, but there is no process to post a `CancelRead` to. Dropping
 * the abort there was the hole whitlockk's review found: the ISS-5808 redrive then
 * issued the same read to the replacement child, which had never heard of the
 * cancel and re-ran the scan the user had already abandoned. The verdict is
 * retained here instead, and applied when the deferred invoke finally runs.
 *
 * An entry is NOT dropped when one invoke honours it: one token can name several
 * ops (`getSharedAgentSessionsPageData` fans out), so a sibling still queued on
 * `ready` must get the same answer. A renderer never reuses a token (a
 * per-instance prefix plus a counter), so a retained entry can never cancel a
 * later legitimate read.
 */

/** Cap on retained tokens. The key is renderer input, so it must be bounded. */
const DETACHED_CANCEL_LIMIT = 64;

export type DetachedCancelRing = {
  /** Retain `token`, evicting the oldest once the cap is exceeded. */
  remember(token: string): void;
  /** True when `token` was cancelled while the client had no child. */
  has(token: string): boolean;
};

/**
 * A bounded, FIFO-evicting set of tokens cancelled while detached.
 *
 * A `Set` iterates in insertion order, so its first entry IS the oldest, which
 * makes the eviction FIFO without a second structure to keep in step — the same
 * shape the store thread's pre-cancel ring uses.
 */
export function createDetachedCancelRing(): DetachedCancelRing {
  const tokens = new Set<string>();
  return {
    has(token: string): boolean {
      return tokens.has(token);
    },
    remember(token: string): void {
      if (tokens.has(token)) {
        return;
      }
      tokens.add(token);
      if (tokens.size <= DETACHED_CANCEL_LIMIT) {
        return;
      }
      const oldest = tokens.values().next();
      if (!oldest.done) {
        tokens.delete(oldest.value);
      }
    },
  };
}
