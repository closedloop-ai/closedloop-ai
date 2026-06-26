/**
 * @file write-queue.ts
 * @description The desktop store's single-writer serialization queue.
 *
 * SQLite is single-connection for writes, so every write (raw `db.transaction`
 * and every `prisma.write(...)`) must serialize through ONE queue or a second
 * write opening while another's transaction is live fails with SQLITE_BUSY.
 * `createDesktopPrisma` takes a {@link WriteSerializer} and routes `write(fn)`
 * through it; `openSqliteAgentDatabase` builds the single queue and shares it
 * between the raw store path and the Prisma client.
 *
 * Extracted from `sqlite.ts` so it can be imported WITHOUT pulling that module's
 * electron-dependent boot graph — the Prisma test harness (`prisma-test-utils`'s
 * `openTestPrisma`) reuses this production queue, which keeps those tests (and the
 * conversion contract tests built on them) electron-free.
 */

export function createWriteQueue() {
  let tail = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(fn, fn);
      tail = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
    drain(): Promise<void> {
      return tail;
    },
  };
}
