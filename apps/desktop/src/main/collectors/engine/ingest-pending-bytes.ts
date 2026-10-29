/**
 * @file ingest-pending-bytes.ts
 * @description ISS-8346 — the BYTE half of the first-pass ingest ledger.
 *
 * `IngestProgressTracker` counts SOURCE FILES, which is what the import banner
 * renders. The analysis estimate (`transcript-sync/transcript-analysis-eta.ts`)
 * divides BYTES by a measured throughput, so it needs the same pass expressed in
 * the inventory's unit. This ledger is that translation and nothing else, and it
 * lives beside the tracker rather than inside it because this is a distinct
 * responsibility, not a slice of the tracker's.
 *
 * `null` IS AN ENTRY VALUE AND IT IS NOT ZERO. A batch collector's pending
 * sources carry no stat at all — `collector-pending-sources.ts` returns
 * `{ skip: false, stat: null }` for every source of one — so a pass whose byte
 * population could not be measured has to say so. Reporting 0 remaining there
 * would tell the estimate the corpus is fully parsed while the import is still
 * running, which is exactly the false completion the estimate exists to refuse.
 */

/**
 * One harness's remaining pending bytes for its tracked first pass, or `null`
 * when that pass's population could not be measured at all.
 */
type PendingByteEntry = number | null;

export type PendingByteLedger = {
  /**
   * Open (or re-open) a harness's pass with the bytes still pending for it.
   *
   * A SET, not an add: the scan recomputes the remaining population on every
   * cooperative re-entry, so the sum it arrives with is already the truth and
   * accumulating would double-count the part that has not moved.
   */
  begin: (key: string, pendingBytes: number | null) => void;
  /** One source finished durably; its bytes leave the remaining population. */
  consume: (key: string, bytes: number) => void;
  /**
   * Remaining bytes summed over `harnesses`, or `null` when no honest number can
   * be stated — a source scan is still running for one of them, one of their
   * passes was never measured, or none of them has a tracked pass at all.
   *
   * The last case is deliberately NOT zero here. "No pass was tracked" and
   * "nothing is left to parse" look identical from this ledger and differ only
   * by whether the boot import has finished, which is a fact its caller holds.
   */
  remaining: (
    harnesses: readonly string[],
    scanning: ReadonlySet<string>
  ) => number | null;
  clear: () => void;
};

/**
 * Whether a value may be summed as a byte count.
 *
 * The whole impossible set for this domain, not the two that come to mind: a
 * negative or non-finite size, a fractional one, and one past the safe-integer
 * range all render as a confident measurement once they reach the estimate's
 * arithmetic, and a wrong minute count is worse than a refusal.
 */
export function isMeasurableByteCount(
  value: number | null | undefined
): value is number {
  return (
    value !== null &&
    value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function createPendingByteLedger(): PendingByteLedger {
  // Bounded by construction: one small entry per harness, cleared on stop.
  const entries = new Map<string, PendingByteEntry>();

  const begin = (key: string, pendingBytes: number | null): void => {
    entries.set(key, isMeasurableByteCount(pendingBytes) ? pendingBytes : null);
  };

  const consume = (key: string, bytes: number): void => {
    const entry = entries.get(key);
    if (entry === undefined || entry === null) {
      return;
    }
    if (!isMeasurableByteCount(bytes)) {
      return;
    }
    entries.set(key, Math.max(0, entry - bytes));
  };

  const remaining = (
    harnesses: readonly string[],
    scanning: ReadonlySet<string>
  ): number | null => {
    let total = 0;
    let measured = false;
    for (const key of harnesses) {
      if (scanning.has(key)) {
        return null;
      }
      const entry = entries.get(key);
      if (entry === undefined) {
        continue;
      }
      if (entry === null) {
        return null;
      }
      measured = true;
      total += entry;
    }
    return measured ? total : null;
  };

  return {
    begin,
    consume,
    remaining,
    clear: () => entries.clear(),
  };
}
