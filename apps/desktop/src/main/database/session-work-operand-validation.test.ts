import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionListCursorSortKey } from "../agent-sync/agent-session-read-model.js";
import {
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "../session/shared-agent-sessions-api.js";
import { SESSION_STARTED_AT_BOUNDS_EXPR } from "./db-constants.js";
import { readNarrowedUsageRows } from "./session-narrowed-usage-query.js";
import { openSqliteAgentDatabase } from "./sqlite.js";

type LocalDatabase = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function withSessionDatabase<T>(
  read: (db: LocalDatabase) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prd728-operands-"));
  let db: LocalDatabase | undefined;
  try {
    db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "unknown",
      now: () => "2026-06-12T03:00:00.000Z",
    });
    await db.whenBootMaintenanceSettled();
    await db.run(
      `INSERT INTO sessions (id, name, status, harness, billing_mode, metadata, started_at, updated_at)
       VALUES ('one', 'One', 'inactive', 'claude', 'api', '{}',
         '2026-06-12T02:00:00.000Z', '2026-06-12T03:00:00.000Z')`
    );
    return await read(db);
  } finally {
    await db?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("DT-21 persisted Sessions work operands", () => {
  it("DT-39: an all-quality cursor validates only the returned page", async () => {
    await withSessionDatabase(async (db) => {
      await db.run(
        `INSERT INTO sessions (id, name, status, harness, billing_mode, metadata, started_at, updated_at)
         VALUES ('two', 'Two', 'inactive', 'claude', 'api', '{"userMessages":"0"}',
           '2026-06-12T01:00:00.000Z', '2026-06-12T02:00:00.000Z')`
      );
      const cursor = db.syncSource.listSessionCursorPage;
      if (!cursor) {
        throw new Error("production cursor unavailable");
      }
      const pageRequest = {
        quality: "all" as const,
        limit: 1,
        sortBy: SessionListCursorSortKey.Updated,
        sortDir: "desc" as const,
      };
      const first = await cursor({ ...pageRequest, offset: 0 });
      expect(first.rows.map((row) => row.id)).toEqual(["one"]);
      expect(first.total).toBe(2);
      await expect(cursor({ ...pageRequest, offset: 1 })).rejects.toThrow(
        "Invalid persisted turn count"
      );
      await expect(
        cursor({ ...pageRequest, quality: "substantive", offset: 0 })
      ).rejects.toThrow("Invalid persisted turn count");
    });
  });

  it("DT-40: numeric started_at never contributes a Julian bounds instant", async () => {
    await withSessionDatabase(async (db) => {
      await db.run("UPDATE sessions SET started_at = '0' WHERE id = 'one'");
      const [numeric] = await db.prisma.read((reader) =>
        reader.$queryRawUnsafe<{ instant: string | null }[]>(
          `SELECT ${SESSION_STARTED_AT_BOUNDS_EXPR} AS instant FROM sessions s WHERE s.id = 'one'`
        )
      );
      expect(numeric?.instant).toBeNull();
      await db.run(
        "UPDATE sessions SET started_at = '2026-06-12T02:00:00.000Z' WHERE id = 'one'"
      );
      const [iso] = await db.prisma.read((reader) =>
        reader.$queryRawUnsafe<{ instant: string | null }[]>(
          `SELECT ${SESSION_STARTED_AT_BOUNDS_EXPR} AS instant FROM sessions s WHERE s.id = 'one'`
        )
      );
      expect(iso?.instant).toBe("2026-06-12T02:00:00.000Z");
    });
  });

  it("accepts a missing turn as zero on compact list and usage reads", async () => {
    await withSessionDatabase(async (db) => {
      const idle = await getSharedAgentSessions(db.syncSource, {
        quality: "idle",
        limit: 25,
      });
      const usage = await getSharedAgentSessionUsage(db.syncSource, {
        quality: "idle",
      });
      expect(idle.items.map((item) => item.externalSessionId)).toEqual(["one"]);
      expect(idle.total).toBe(1);
      expect(usage.totalSessions).toBe(1);
      await db.run(
        `UPDATE sessions SET metadata = '{"assistantMessages":1}' WHERE id = 'one'`
      );
      expect(
        (
          await getSharedAgentSessions(db.syncSource, {
            quality: "substantive",
          })
        ).total
      ).toBe(1);
      await db.run("UPDATE sessions SET metadata = '{}' WHERE id = 'one'");
      expect(
        (await getSharedAgentSessions(db.syncSource, { quality: "idle" })).total
      ).toBe(1);
    });
  });

  it.each([
    '{"userMessages":null,"assistantMessages":1}',
    '{"userMessages":1,"assistantMessages":null}',
    '{"userMessages":"0"}',
    '{"userMessages":true}',
    '{"userMessages":-1}',
    '{"userMessages":1.5}',
    '{"userMessages":2147483648}',
  ])(
    "rejects malformed turn metadata %s instead of classifying it idle",
    async (metadata) => {
      await withSessionDatabase(async (db) => {
        await db.run(
          "UPDATE sessions SET metadata = $1 WHERE id = 'one'",
          metadata
        );
        await expect(
          getSharedAgentSessions(db.syncSource, { quality: "idle" })
        ).rejects.toThrow("Invalid persisted turn count");
        await expect(
          getSharedAgentSessionUsage(db.syncSource, { quality: "all" })
        ).rejects.toThrow("unavailable");
      });
    }
  );

  it.each([
    ["input_tokens", "baseline_input"],
    ["cache_write_tokens", "cache_write_1h_tokens"],
  ] as const)(
    "rejects all-quality +5/-5 cancellation across %s and %s",
    async (positive, negative) => {
      await withSessionDatabase(async (db) => {
        await db.run(
          `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
         VALUES ('one', 'small', 0, 0, 0, 0, 1)`
        );
        await db.run(
          `UPDATE token_usage SET ${positive} = 5, ${negative} = -5 WHERE session_id = 'one'`
        );
        await expect(
          getSharedAgentSessionUsage(db.syncSource, { quality: "all" })
        ).rejects.toThrow("unavailable");
        await expect(
          getSharedAgentSessions(db.syncSource, { quality: "substantive" })
        ).rejects.toThrow("Invalid token count");
      });
    }
  );

  it("refuses the one-hour operand inside narrowed usage even without list preflight", async () => {
    await withSessionDatabase(async (db) => {
      await db.run(
        `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens)
         VALUES ('one', 'small', 0, 0, 0, 0, -1)`
      );
      await expect(
        db.prisma.read((reader) =>
          readNarrowedUsageRows(reader, "WHERE s.id = 'one'", [])
        )
      ).rejects.toThrow("Invalid token count");
    });
  });

  it("rejects stored-cost cancellation on all-quality and narrowed usage reads", async () => {
    await withSessionDatabase(async (db) => {
      await db.run(
        `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
         VALUES ('one', 'positive', 1, 0, 0, 0, 5),
                ('one', 'negative', 1, 0, 0, 0, -5)`
      );
      await expect(
        getSharedAgentSessionUsage(db.syncSource, { quality: "all" })
      ).rejects.toThrow("unavailable");
      await expect(
        getSharedAgentSessionUsage(db.syncSource, {
          quality: "substantive",
        })
      ).rejects.toThrow("unavailable");
    });
  });

  it("rejects a one-hour subdivision above the effective cache-write total", async () => {
    await withSessionDatabase(async (db) => {
      await db.run(
        `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, baseline_cache_write, cache_write_1h_tokens)
         VALUES ('one', 'small', 0, 0, 0, 2, 1, 4)`
      );
      await expect(
        getSharedAgentSessionUsage(db.syncSource, { quality: "all" })
      ).rejects.toThrow("unavailable");
      await expect(
        getSharedAgentSessionUsage(db.syncSource, {
          quality: "substantive",
        })
      ).rejects.toThrow("unavailable");
    });
  });

  it("rejects a non-finite grouped cost instead of degrading it to zero", async () => {
    await withSessionDatabase(async (db) => {
      await db.run(
        `INSERT INTO sessions (id, name, status, harness, billing_mode, metadata, started_at, updated_at)
         VALUES ('two', 'Two', 'inactive', 'claude', 'api', '{}',
           '2026-06-12T02:00:00.000Z', '2026-06-12T03:00:00.000Z')`
      );
      await db.run(
        `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
         VALUES ('one', 'small', 1, 0, 0, 0, 1e308),
                ('two', 'small', 1, 0, 0, 0, 1e308)`
      );
      await expect(
        getSharedAgentSessionUsage(db.syncSource, { quality: "all" })
      ).rejects.toThrow("unavailable");
      await expect(
        getSharedAgentSessionUsage(db.syncSource, {
          quality: "substantive",
        })
      ).rejects.toThrow("unavailable");
    });
  });
});
