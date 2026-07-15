import type { DesktopPrismaReader } from "./prisma-client.js";

/**
 * Count rows in the local `sessions` table via a raw `COUNT(*)` on a reader-pool
 * connection — the single source of truth for "how many local sessions". Used by
 * BOTH the Sessions-list pagination total ({@link listSqliteSessionCursorPage})
 * and the FEA-1997 IPC perf `session_count` dimension, so the two can never
 * diverge.
 *
 * FEA-2211: the perf metric previously counted via the Prisma model-delegate
 * aggregate on the READER POOL (`prisma.read((r) => r.session.count())`), which
 * returned 0 on every span in packaged builds — a libSQL community-adapter quirk
 * for the aggregate delegate on the `query_only` reader connections that does NOT
 * reproduce in the clean test env (where the delegate returns the true count).
 * The list pagination total has always counted correctly in prod via this raw
 * `SELECT COUNT(*)` on the same reader pool, so both sites now share it. (The
 * writer-connection delegate — `prisma.client.session.count()` in
 * dashboard-queries.ts — is a different connection and is unaffected.) Do NOT
 * reintroduce a reader-pool model-delegate `count()` aggregate here.
 *
 * `clause`/`params` are an optional SQL-side filter (e.g. the list's date/search
 * window, which references the `s` alias). With no clause it returns the
 * unfiltered table total — what the perf-cliff dimension wants. The COUNT is
 * coerced to a JS number (libSQL can surface it as a `bigint`).
 */
export async function countSqliteSessions(
  reader: DesktopPrismaReader,
  clause = "",
  params: readonly unknown[] = []
): Promise<number> {
  const rows = await reader.$queryRawUnsafe<{ count: number | bigint }[]>(
    `SELECT COUNT(*) AS count FROM sessions s ${clause}`,
    ...params
  );
  return Number(rows[0]?.count ?? 0);
}
