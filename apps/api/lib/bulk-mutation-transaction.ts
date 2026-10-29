import "server-only";

/**
 * The identity every receipt of ONE bulk mutation carries (ISS-9465): its
 * activity rows, its audit entries, and the `/v2` response body, so a reader
 * can join what a single user action produced across all three.
 *
 * A GROUPING key, not an idempotency key — a retry of the same batch mints a
 * new one, exactly as `commitGroupId` does for a status receipt. Minted
 * server-side and never read off a request body: it names one commit this
 * process made, so a caller-supplied value could make two unrelated batches
 * claim to be one action.
 */
export function newBulkTransactionId(): string {
  return crypto.randomUUID();
}

/**
 * Stamp `transactionId` onto an audit entry's `detail`.
 *
 * One spelling of the key for every emit point, because `detail` participates
 * in `AuditHashInput`: a typo at one route becomes a permanent field name in an
 * append-only hash chain that can never be renamed. Applied LAST so a domain
 * detail carrying its own `transactionId` cannot displace the real one.
 */
export function withBulkTransaction<T extends object>(
  detail: T,
  transactionId: string
): T & { transactionId: string } {
  return { ...detail, transactionId };
}

/**
 * Stamp the transaction an entry REVERSES onto its `detail` (ISS-10458).
 *
 * Separate from {@link withBulkTransaction} and applied on top of it, because
 * the two answer different questions: that one says which commit this entry
 * belongs to, this one says which commit that commit undid. Collapsing them
 * into a single id would make the pair one group in the ledger and still leave
 * a reader unable to say which half reversed the other.
 *
 * Absent when the caller reports no reference, so a batch that is not an undo
 * carries no key at all rather than a `null` a hash-chained row can never
 * later be cleaned of.
 */
export function withUndoneBulkTransaction<T extends object>(
  detail: T,
  undoOfTransactionId: string | undefined
): T {
  if (undoOfTransactionId === undefined) {
    return detail;
  }
  return { ...detail, undoOfTransactionId };
}
