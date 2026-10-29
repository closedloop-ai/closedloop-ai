/**
 * @file dashboard-recency-sql-coverage.test.ts
 * @description ISS-8730 coverage for `src/main/database/dashboard-recency-sql.ts`
 * — `TOOL_SUMMARY_SQL` (per-tool recency, partitioned by tool_name). Pins
 * CURRENT behavior.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import {
  type SqliteToolRow,
  TOOL_SUMMARY_SQL,
} from "../src/main/database/dashboard-recency-sql.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// Same mixed-format trio the sibling coverage files use — reused here (not
// imported, those constants are private) to prove this module's independent
// wiring of the same canonical-ranking helper.
const OFFSET_FORM_LATEST = "2026-06-22T09:00:00-05:30"; // 14:30Z, true latest
const WHOLE_SECOND_EARLIEST = "2026-06-22T10:00:00Z"; // 10:00Z, true earliest
const SUBSECOND_MIDDLE = "2026-06-22T10:00:00.500Z";
// SQLite cannot parse this BASIC-format offset, so it never canonicalizes.
const UNPARSEABLE_OFFSET = "2026-06-22T21:00:00.000+0530";

const openStores: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.allSettled(openStores.map((close) => close()));
});

async function openStore(): Promise<DesktopPrisma> {
  const { prisma, close } = await openTestPrisma();
  openStores.push(close);
  return prisma;
}

function runToolSummary(prisma: DesktopPrisma): Promise<SqliteToolRow[]> {
  return prisma.read((client) =>
    client.$queryRawUnsafe<SqliteToolRow[]>(TOOL_SUMMARY_SQL)
  );
}

async function seedEvent(
  prisma: DesktopPrisma,
  row: {
    id: string;
    sessionId?: string;
    toolName?: string | null;
    createdAt?: string | null;
  }
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ($1, $2, 'PostToolUse', $3, $4)`,
      row.id,
      row.sessionId ?? "s",
      row.toolName ?? null,
      row.createdAt ?? "2026-06-22T00:00:00.000Z"
    )
  );
}

function num(value: unknown): number {
  return Number(value);
}

function byTool(
  rows: SqliteToolRow[],
  toolName: string
): SqliteToolRow | undefined {
  return rows.find((row) => row.tool_name === toolName);
}

// ---------------------------------------------------------------------------
// TOOL_SUMMARY_SQL
// ---------------------------------------------------------------------------

test("TOOL_SUMMARY_SQL returns no rows against an empty store", async () => {
  const prisma = await openStore();
  assert.deepEqual(await runToolSummary(prisma), []);
});

test("TOOL_SUMMARY_SQL excludes NULL and empty-string tool_name, counting only real invocations", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, { id: "e-null", toolName: null });
  await seedEvent(prisma, { id: "e-empty", toolName: "" });
  await seedEvent(prisma, { id: "e-real-1", toolName: "Bash" });
  await seedEvent(prisma, { id: "e-real-2", toolName: "Bash" });
  const rows = await runToolSummary(prisma);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool_name, "Bash");
  assert.equal(num(rows[0].invocation_count), 2);
});

test("TOOL_SUMMARY_SQL counts DISTINCT sessions separately from raw invocation count", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, { id: "e1", sessionId: "s1", toolName: "Read" });
  await seedEvent(prisma, { id: "e2", sessionId: "s1", toolName: "Read" });
  await seedEvent(prisma, { id: "e3", sessionId: "s2", toolName: "Read" });
  const rows = await runToolSummary(prisma);
  const row = byTool(rows, "Read");
  assert.ok(row);
  assert.equal(num(row?.invocation_count), 3);
  assert.equal(num(row?.session_count), 2);
});

test("TOOL_SUMMARY_SQL picks last_used_at (a bare column) from the true-latest row among mixed timestamp forms", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e-offset",
    toolName: "Edit",
    createdAt: OFFSET_FORM_LATEST,
  });
  await seedEvent(prisma, {
    id: "e-whole",
    toolName: "Edit",
    createdAt: WHOLE_SECOND_EARLIEST,
  });
  await seedEvent(prisma, {
    id: "e-sub",
    toolName: "Edit",
    createdAt: SUBSECOND_MIDDLE,
  });
  const rows = await runToolSummary(prisma);
  const row = byTool(rows, "Edit");
  assert.ok(row);
  assert.equal(row?.last_used_at, OFFSET_FORM_LATEST);
});

test("TOOL_SUMMARY_SQL's per-tool PARTITION isolates a dissenting group from a clean one", async () => {
  const prisma = await openStore();
  // Clean group: every event canonicalizes, so its ranking is exact.
  await seedEvent(prisma, {
    id: "e-clean-offset",
    toolName: "CleanTool",
    createdAt: OFFSET_FORM_LATEST,
  });
  await seedEvent(prisma, {
    id: "e-clean-whole",
    toolName: "CleanTool",
    createdAt: WHOLE_SECOND_EARLIEST,
  });
  // Dissenting group: one un-canonicalizable event drops ONLY this tool's
  // group back to the raw byte-wise MAX — the partition scopes the guard to
  // the GROUP BY key, not the whole result set.
  await seedEvent(prisma, {
    id: "e-dissent-whole",
    toolName: "DissentTool",
    createdAt: WHOLE_SECOND_EARLIEST,
  });
  await seedEvent(prisma, {
    id: "e-dissent-unparseable",
    toolName: "DissentTool",
    createdAt: UNPARSEABLE_OFFSET,
  });
  const rows = await runToolSummary(prisma);
  assert.equal(byTool(rows, "CleanTool")?.last_used_at, OFFSET_FORM_LATEST);
  // Byte-wise winner of the two raw dissenting-group strings.
  assert.equal(byTool(rows, "DissentTool")?.last_used_at, UNPARSEABLE_OFFSET);
});

test("TOOL_SUMMARY_SQL orders by invocation_count DESC, tie-broken by tool_name ASC", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, { id: "e-most-1", toolName: "MostUsed" });
  await seedEvent(prisma, { id: "e-most-2", toolName: "MostUsed" });
  await seedEvent(prisma, { id: "e-most-3", toolName: "MostUsed" });
  await seedEvent(prisma, { id: "e-tie-b-1", toolName: "TieB" });
  await seedEvent(prisma, { id: "e-tie-a-1", toolName: "TieA" });
  const rows = await runToolSummary(prisma);
  assert.deepEqual(
    rows.map((row) => row.tool_name),
    ["MostUsed", "TieA", "TieB"]
  );
});

test("TOOL_SUMMARY_SQL's row shape carries last_used_sort alongside the fields getTools maps", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, { id: "e-shape", toolName: "ShapeTool" });
  const rows = await runToolSummary(prisma);
  const row = byTool(rows, "ShapeTool");
  assert.ok(row);
  assert.deepEqual(Object.keys(row as object).sort(), [
    "invocation_count",
    "last_used_at",
    "last_used_sort",
    "session_count",
    "tool_name",
  ]);
});
