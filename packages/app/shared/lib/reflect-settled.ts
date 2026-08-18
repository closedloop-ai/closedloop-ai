/**
 * Reflect a promise into a `PromiseSettledResult` that never rejects, WITHOUT
 * joining it to a sibling promise the way `Promise.allSettled([a, b])` does.
 *
 * `Promise.allSettled([required, optional])` waits for BOTH inputs before it
 * resolves, so a required read that has already failed cannot surface its
 * rejection while an optional read stalls — the caller hangs on the slow half
 * (wongk review, FEA-4177). Use this to reflect the OPTIONAL half to a settled
 * result immediately, then `await` the REQUIRED half directly so its rejection
 * propagates the instant it lands; inspect the optional result only after the
 * required half resolves.
 */
export function reflectToSettled<T>(
  promise: Promise<T>
): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value): PromiseSettledResult<T> => ({ status: "fulfilled", value }),
    (reason): PromiseSettledResult<T> => ({ status: "rejected", reason })
  );
}
