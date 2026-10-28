/**
 * ISS-12552: the kernel's one residual rule, shared by its
 * token and micro-dollar steps. Each entry gets the floor of its exact share;
 * the leftover units go one each to the largest exact remainders, ties to the
 * smaller key. Arithmetic is BigInt, so the result is exact and does not
 * depend on input order.
 *
 * Kernel-local on purpose: `packages/app/shared/lib/largest-remainder.ts`
 * breaks ties toward the larger raw value, a shipped rule this kernel does not
 * share.
 */

export type ApportionEntry = {
  key: string;
  weight: bigint;
};

/**
 * Splits `total` across `entries` in proportion to their weights, summing to
 * exactly `total`. The caller guarantees a non-negative total, non-negative
 * weights, at least one positive weight, and unique keys.
 */
export function apportion(
  total: bigint,
  entries: readonly ApportionEntry[]
): Map<string, bigint> {
  const weightSum = entries.reduce((sum, entry) => sum + entry.weight, 0n);
  const shares = new Map<string, bigint>();
  const remainders: { key: string; remainder: bigint }[] = [];
  let assigned = 0n;
  for (const entry of entries) {
    const product = total * entry.weight;
    const floor = product / weightSum;
    shares.set(entry.key, floor);
    assigned += floor;
    remainders.push({ key: entry.key, remainder: product % weightSum });
  }
  remainders.sort(compareRemainders);
  let leftover = total - assigned;
  for (const { key } of remainders) {
    if (leftover === 0n) {
      break;
    }
    shares.set(key, (shares.get(key) ?? 0n) + 1n);
    leftover -= 1n;
  }
  return shares;
}

function compareRemainders(
  left: { key: string; remainder: bigint },
  right: { key: string; remainder: bigint }
): number {
  if (left.remainder !== right.remainder) {
    return left.remainder > right.remainder ? -1 : 1;
  }
  return compareKeys(left.key, right.key);
}

/** Code-unit order, so the tie rule does not depend on the runtime locale. */
export function compareKeys(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
