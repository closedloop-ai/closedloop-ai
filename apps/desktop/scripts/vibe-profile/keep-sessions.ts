import { vibeCorpusSessionOwner } from "@repo/api/src/vibe-seed-corpus";
import { openSqliteAgentDatabase } from "../../src/main/database/sqlite.js";

/**
 * ISS-12135: a vibe Desktop profile holds only its signed-in person's corpus
 * sessions. The web seed attributes every corpus session to the teammate whose
 * home directory it ran in (`vibeCorpusSessionOwner`), on that teammate's own
 * machine; a Desktop holding a teammate's session would sync it again under
 * the signed-in person's machine and show it twice.
 *
 * Every row keyed by a removed session goes with it: each table's
 * `session_id` or `external_session_id` column, then the session itself
 * (whose delete cascades its agents).
 */

const SESSION_KEY_COLUMNS: ReadonlySet<string> = new Set([
  "session_id",
  "external_session_id",
]);

export type KeptSessions = { readonly kept: number; readonly removed: number };

export async function keepSessionsOf(
  storePath: string,
  login: string,
  log: (message: string) => void
): Promise<KeptSessions> {
  const db = await openSqliteAgentDatabase({
    dataDir: storePath,
    detectBillingMode: () => "metered_api",
    log,
  });
  try {
    const sessions = await db.prisma.client.session.findMany({
      select: { id: true, cwd: true },
    });
    const removed = sessions
      .filter((session) => vibeCorpusSessionOwner(session.cwd) !== login)
      .map((session) => session.id);
    if (removed.length === 0) {
      return { kept: sessions.length, removed: 0 };
    }
    const keyed = await db.prisma.client.$queryRawUnsafe<
      { tableName: string; columnName: string }[]
    >(
      `SELECT m.name AS tableName, p.name AS columnName
         FROM sqlite_master m JOIN pragma_table_info(m.name) p
        WHERE m.type = 'table' AND m.name NOT IN ('sessions', 'sqlite_sequence')`
    );
    const placeholders = removed.map(() => "?").join(", ");
    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        for (const { tableName, columnName } of keyed) {
          if (SESSION_KEY_COLUMNS.has(columnName)) {
            await tx.$executeRawUnsafe(
              `DELETE FROM "${tableName}" WHERE "${columnName}" IN (${placeholders})`,
              ...removed
            );
          }
        }
        await tx.$executeRawUnsafe(
          `DELETE FROM sessions WHERE id IN (${placeholders})`,
          ...removed
        );
      })
    );
    return { kept: sessions.length - removed.length, removed: removed.length };
  } finally {
    await db.close();
  }
}
