import type { DesktopPrisma } from "../src/main/database/prisma-client.js";

/**
 * A `DesktopPrisma` stand-in that records the raw SQL a read path emits instead
 * of executing it.
 *
 * Shared (ISS-7579) rather than re-declared per suite: it must expose BOTH
 * `client` and `read`, because the readers under test reach the raw hatch as
 * `prisma.read((reader) => reader.$queryRawUnsafe(...))`. A stub carrying only
 * one of the two fails at the call boundary rather than at the assertion, which
 * reads as a broken test instead of a missing seam.
 *
 * Extracted from `branch-metric-event-provenance.test.ts`, where it was a local
 * `makePrisma`, when `canonical-instant-guard-partition.test.ts` needed the same
 * capture to read a production predicate rather than transcribe one.
 */
export function makeSqlCapturePrisma(
  query: (sql: string, parameters: unknown[]) => unknown[]
): DesktopPrisma {
  const client = {
    $queryRawUnsafe: (sql: string, ...parameters: unknown[]) =>
      Promise.resolve(query(sql, parameters)),
  };
  return {
    client,
    read: (read: (reader: typeof client) => Promise<unknown>) => read(client),
  } as unknown as DesktopPrisma;
}

/**
 * Every statement a read path emits, in order.
 *
 * Returns them all rather than the last, so a caller asserting against
 * PRODUCTION text can select the statement it means by content and fail loudly
 * when zero or several match — picking "the last one" silently binds to
 * whichever query happens to run last.
 */
export async function captureEmittedStatements(
  run: (prisma: DesktopPrisma) => Promise<unknown>,
  rows: (sql: string, parameters: unknown[]) => unknown[] = () => []
): Promise<string[]> {
  const statements: string[] = [];
  const prisma = makeSqlCapturePrisma((sql, parameters) => {
    statements.push(sql);
    return rows(sql, parameters);
  });
  await run(prisma);
  if (statements.length === 0) {
    throw new Error("no SQL was emitted by the read under capture");
  }
  return statements;
}
