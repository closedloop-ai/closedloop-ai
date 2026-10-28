/**
 * @file dashboard-skill-sql-coverage.test.ts
 * @description ISS-8730 coverage for `src/main/database/dashboard-skill-sql.ts`
 * — the `SKILL_SUMMARY_SQL` read behind `getSkills`. Pins CURRENT behavior of
 * the exported constant and the `SqliteSkillRow` shape it produces; no
 * internal helper (`skillDataTextExpr`, `sqlNonEmptyText`) is exported, so
 * they are exercised only through the public query.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import {
  SKILL_SUMMARY_SQL,
  type SqliteSkillRow,
} from "../src/main/database/dashboard-skill-sql.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// Same mixed-format trio `component-usage-invoked-at-mixed-format.test.ts`
// pins for the usage rollup — reused here (not imported, that file's
// constants are private) to prove this query's independent wiring of the
// same canonical-ranking helper.
const OFFSET_FORM_LATEST = "2026-06-22T09:00:00-05:30"; // 14:30Z, true latest
const WHOLE_SECOND_EARLIEST = "2026-06-22T10:00:00Z"; // 10:00Z, true earliest
const SUBSECOND_MIDDLE = "2026-06-22T10:00:00.500Z";
// SQLite cannot parse this BASIC-format offset, so it never canonicalizes and
// drops its whole group back to the raw byte-wise MAX.
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

function runSkillSummary(prisma: DesktopPrisma): Promise<SqliteSkillRow[]> {
  return prisma.read((client) =>
    client.$queryRawUnsafe<SqliteSkillRow[]>(SKILL_SUMMARY_SQL)
  );
}

async function seedSession(
  prisma: DesktopPrisma,
  id: string,
  harness: string | null
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO sessions (id, status, harness) VALUES ($1, 'inactive', $2)`,
      id,
      harness
    )
  );
}

type SkillEventSeed = {
  id: string;
  sessionId?: string;
  toolName?: string;
  data?: unknown;
  rawData?: string;
  summary?: string | null;
  createdAt?: string | null;
};

function skillEventDataColumn(row: SkillEventSeed): string | null {
  if (row.rawData !== undefined) {
    return row.rawData;
  }
  if (row.data === undefined) {
    return null;
  }
  return JSON.stringify(row.data);
}

async function seedEvent(
  prisma: DesktopPrisma,
  row: SkillEventSeed
): Promise<void> {
  const data = skillEventDataColumn(row);
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO events (id, session_id, event_type, tool_name, summary, data, created_at)
       VALUES ($1, $2, 'PostToolUse', $3, $4, $5, $6)`,
      row.id,
      row.sessionId ?? "no-matching-session",
      row.toolName ?? "Skill",
      row.summary ?? null,
      data,
      row.createdAt ?? "2026-06-22T00:00:00.000Z"
    )
  );
}

function byNameAndHarness(
  rows: SqliteSkillRow[],
  name: string,
  harness: string
): SqliteSkillRow | undefined {
  return rows.find((row) => row.name === name && row.harness === harness);
}

test("SKILL_SUMMARY_SQL returns no rows against an empty store", async () => {
  const prisma = await openStore();
  assert.deepEqual(await runSkillSummary(prisma), []);
});

test("resolves the skill name through skillName, then skill, then name, then the event summary", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e-priority",
    sessionId: "priority-session",
    data: { skillName: "wins-skillName", skill: "loses", name: "loses-too" },
  });
  await seedEvent(prisma, {
    id: "e-skill",
    sessionId: "skill-fallback-session",
    data: { skill: "wins-skill", name: "loses" },
  });
  await seedEvent(prisma, {
    id: "e-name",
    sessionId: "name-fallback-session",
    data: { name: "wins-name" },
  });
  await seedEvent(prisma, {
    id: "e-summary",
    sessionId: "summary-fallback-session",
    data: null,
    summary: "wins-summary",
  });
  const rows = await runSkillSummary(prisma);
  assert.ok(byNameAndHarness(rows, "wins-skillName", "unknown"));
  assert.ok(byNameAndHarness(rows, "wins-skill", "unknown"));
  assert.ok(byNameAndHarness(rows, "wins-name", "unknown"));
  assert.ok(byNameAndHarness(rows, "wins-summary", "unknown"));
});

test("a whitespace-only field value falls through to the next COALESCE candidate", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e-whitespace",
    sessionId: "whitespace-session",
    data: { skillName: "   ", skill: "real-name" },
  });
  const rows = await runSkillSummary(prisma);
  assert.ok(byNameAndHarness(rows, "real-name", "unknown"));
  assert.equal(byNameAndHarness(rows, "   ", "unknown"), undefined);
});

test("a non-string JSON field extracts as NULL and falls through to the next candidate", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e-nonstring",
    sessionId: "nonstring-session",
    data: { skillName: { nested: true }, skill: "fallback-name" },
  });
  const rows = await runSkillSummary(prisma);
  assert.ok(byNameAndHarness(rows, "fallback-name", "unknown"));
});

test("malformed JSON in data yields no name and the event is excluded", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e-malformed",
    sessionId: "malformed-session",
    rawData: "{not-json",
  });
  const rows = await runSkillSummary(prisma);
  assert.equal(rows.filter((row) => row.harness === "unknown").length, 0);
});

test("events whose tool_name is not 'Skill' are excluded entirely", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e-non-skill",
    sessionId: "non-skill-session",
    toolName: "Bash",
    data: { skillName: "should-not-appear" },
  });
  const rows = await runSkillSummary(prisma);
  assert.equal(
    byNameAndHarness(rows, "should-not-appear", "unknown"),
    undefined
  );
});

test("install_path falls back from installPath to path", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e-install-path",
    sessionId: "install-path-session",
    data: { skillName: "install-path-primary", installPath: "/a" },
  });
  await seedEvent(prisma, {
    id: "e-path",
    sessionId: "path-session",
    data: { skillName: "install-path-fallback", path: "/b" },
  });
  const rows = await runSkillSummary(prisma);
  assert.equal(
    byNameAndHarness(rows, "install-path-primary", "unknown")?.install_path,
    "/a"
  );
  assert.equal(
    byNameAndHarness(rows, "install-path-fallback", "unknown")?.install_path,
    "/b"
  );
});

test("harness comes from the LEFT JOINed session, defaulting to 'unknown' when no session matches", async () => {
  const prisma = await openStore();
  await seedSession(prisma, "known-session", "claude");
  await seedEvent(prisma, {
    id: "e-known-harness",
    sessionId: "known-session",
    data: { skillName: "harness-known" },
  });
  await seedEvent(prisma, {
    id: "e-unknown-harness",
    sessionId: "no-such-session",
    data: { skillName: "harness-unknown" },
  });
  const rows = await runSkillSummary(prisma);
  assert.equal(
    byNameAndHarness(rows, "harness-known", "claude")?.harness,
    "claude"
  );
  assert.equal(
    byNameAndHarness(rows, "harness-unknown", "unknown")?.harness,
    "unknown"
  );
});

test("groups by (harness, name), counting invocations and picking last_used_at from the true-latest row", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e-offset",
    sessionId: "recency-session",
    data: { skillName: "recency-skill" },
    createdAt: OFFSET_FORM_LATEST,
  });
  await seedEvent(prisma, {
    id: "e-whole",
    sessionId: "recency-session",
    data: { skillName: "recency-skill" },
    createdAt: WHOLE_SECOND_EARLIEST,
  });
  await seedEvent(prisma, {
    id: "e-sub",
    sessionId: "recency-session",
    data: { skillName: "recency-skill" },
    createdAt: SUBSECOND_MIDDLE,
  });
  const rows = await runSkillSummary(prisma);
  const row = byNameAndHarness(rows, "recency-skill", "unknown");
  assert.ok(row);
  assert.equal(row?.invocation_count, 3);
  // Bare column beside MAX(last_used_sort): the RAW text of the winning row.
  assert.equal(row?.last_used_at, OFFSET_FORM_LATEST);
});

test("one un-canonicalizable event drops its (harness, name) group back to the raw byte-wise MAX", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e2-offset",
    sessionId: "dissent-session",
    data: { skillName: "dissent-skill" },
    createdAt: OFFSET_FORM_LATEST,
  });
  await seedEvent(prisma, {
    id: "e2-whole",
    sessionId: "dissent-session",
    data: { skillName: "dissent-skill" },
    createdAt: WHOLE_SECOND_EARLIEST,
  });
  await seedEvent(prisma, {
    id: "e2-sub",
    sessionId: "dissent-session",
    data: {
      skillName: "dissent-skill",
      description: "desc-for-subsecond",
    },
    createdAt: SUBSECOND_MIDDLE,
  });
  await seedEvent(prisma, {
    id: "e2-unparseable",
    sessionId: "dissent-session",
    data: {
      skillName: "dissent-skill",
      description: "desc-for-unparseable",
    },
    createdAt: UNPARSEABLE_OFFSET,
  });
  const rows = await runSkillSummary(prisma);
  const row = byNameAndHarness(rows, "dissent-skill", "unknown");
  assert.ok(row);
  // Byte-wise winner among all four RAW strings — the pre-canonicalization
  // expression, verbatim, because one operand could not be canonicalized.
  assert.equal(row?.last_used_at, UNPARSEABLE_OFFSET);
  assert.equal(row?.description, "desc-for-unparseable");
});

test("orders groups by recency DESC, tie-breaking equal instants by name ASC", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e3-newest",
    sessionId: "order-session",
    data: { skillName: "z-newest" },
    createdAt: "2026-06-22T12:00:00.000Z",
  });
  await seedEvent(prisma, {
    id: "e3-tie-b",
    sessionId: "order-session",
    data: { skillName: "b-tied" },
    createdAt: "2026-06-22T10:00:00.000Z",
  });
  await seedEvent(prisma, {
    id: "e3-tie-a",
    sessionId: "order-session",
    data: { skillName: "a-tied" },
    createdAt: "2026-06-22T10:00:00.000Z",
  });
  await seedEvent(prisma, {
    id: "e3-oldest",
    sessionId: "order-session",
    data: { skillName: "oldest" },
    createdAt: "2026-06-22T08:00:00.000Z",
  });
  const rows = await runSkillSummary(prisma);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["z-newest", "a-tied", "b-tied", "oldest"]
  );
});

test("the row shape carries last_used_sort alongside the fields getSkills maps", async () => {
  const prisma = await openStore();
  await seedEvent(prisma, {
    id: "e-shape",
    sessionId: "shape-session",
    data: { skillName: "shape-skill" },
  });
  const rows = await runSkillSummary(prisma);
  const row = byNameAndHarness(rows, "shape-skill", "unknown");
  assert.ok(row);
  assert.deepEqual(Object.keys(row as object).sort(), [
    "description",
    "harness",
    "install_path",
    "invocation_count",
    "last_used_at",
    "last_used_sort",
    "name",
  ]);
});
