import type { TransactionClient } from "@repo/database";

/**
 * The transaction client a route-level `withDb.tx` hands its callback in a unit
 * test. Opaque: every store a route reaches is mocked in these suites, so
 * nothing calls a method on it — what an assertion pins is that the SAME client
 * the route opened reaches the activity capture, which is what makes the receipt
 * commit with the mutation (ISS-10993).
 */
export const MOCK_TRANSACTION_CLIENT = {
  __brand: "mock-transaction-client",
} as unknown as TransactionClient;

/**
 * A stand-in for `@repo/database`'s `withDb` that runs its callback inline on
 * {@link MOCK_TRANSACTION_CLIENT} instead of opening a connection.
 *
 * Route unit suites mock every service the handler calls, so the only thing the
 * real `withDb` would add is a live Postgres the `apps/api` unit lane does not
 * have. Use it in a PARTIAL mock so the rest of `@repo/database` — the Prisma
 * enums these suites compare against — stays real:
 *
 * ```ts
 * vi.mock("@repo/database", async (importOriginal) => ({
 *   ...(await importOriginal<object>()),
 *   withDb: (await import("../utils/mock-with-db")).mockWithDb(),
 * }));
 * ```
 */
export function mockWithDb() {
  const run = <T>(fn: (client: TransactionClient) => T): T =>
    fn(MOCK_TRANSACTION_CLIENT);
  return Object.assign(run, { tx: run });
}
