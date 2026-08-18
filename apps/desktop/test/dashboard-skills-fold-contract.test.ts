import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * ISS-5629 contract test for the `getSkills` / `getPacks` SQL fold. A focused
 * sibling of `dashboard-queries-contract.test.ts`, which is at the
 * `noExcessiveLinesPerFile` ceiling — per `test/AGENTS.md`, new scenario
 * clusters go in their own suite rather than growing that file. Like its
 * sibling it runs through `openSqliteAgentDatabase` (the runtime + electron
 * load), so it is a CI guard rather than a dev-sandbox one.
 */

const NOW = "2026-06-22T00:00:00.000Z";
const T1 = "2026-06-20T10:00:00.000Z";
const T2 = "2026-06-20T11:00:00.000Z";
const T3 = "2026-06-20T12:00:00.000Z";

// ISS-5629: the per-skill fold moved from a JS Map over every Skill event to
// COUNT(*)/MAX(created_at)/GROUP BY in SQL, so the read ships one row per skill
// instead of the whole corpus. Pin the three semantics that move with it: rows
// group by (harness, name) and count, the descriptive columns come from the
// NEWEST event in the group (the bare-column-beside-MAX rule standing in for
// the former `ORDER BY created_at DESC` first-row-wins), and `sqlNonEmptyText`
// trims and falls through a whitespace-only candidate exactly as
// `nonEmptyString` did — a padded name must not split its group in two.
test("ISS-5629: getSkills aggregates per skill in SQL with newest-event fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-skill-fold-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  const insertSkillEvent = async (
    id: string,
    sessionId: string,
    data: unknown,
    createdAt: string
  ): Promise<void> => {
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, data, created_at)
       VALUES ($1, $2, 'PreToolUse', 'Skill', $3, $4)`,
      id,
      sessionId,
      JSON.stringify(data),
      createdAt
    );
  };
  try {
    for (const [id, harness] of [
      ["s-claude", "claude"],
      ["s-codex", "codex"],
    ]) {
      await db.run(
        `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
         VALUES ($1, $1, 'inactive', $2, $2, $3)`,
        id,
        T1,
        harness
      );
    }
    // Oldest event carries the description/installPath that must LOSE.
    await insertSkillEvent(
      "e1",
      "s-claude",
      { skillName: "core/foo", description: "stale", installPath: "/old" },
      T1
    );
    // Whitespace-padded spelling of the same skill: trimmed, so it joins the
    // same group rather than forming a second one.
    await insertSkillEvent("e2", "s-claude", { skillName: "  core/foo\n" }, T2);
    // Newest event in the group — its description/installPath must WIN.
    await insertSkillEvent(
      "e3",
      "s-claude",
      { skillName: "core/foo", description: "fresh", installPath: "/new" },
      T3
    );
    // Padded with an EM SPACE (U+2003) and an NBSP (U+00A0): `trim()` strips
    // both, so the SQL trim charset must too or this splits into its own group.
    await insertSkillEvent(
      "e6",
      "s-claude",
      { skillName: "\u2003core/foo\u00a0" },
      T2
    );
    // Same skill name on a different harness → its own row, not merged.
    await insertSkillEvent("e4", "s-codex", { skillName: "core/foo" }, T2);
    // Whitespace-only skillName falls THROUGH to the `skill` alias.
    await insertSkillEvent(
      "e5",
      "s-claude",
      { skillName: "   ", skill: "bar" },
      T1
    );

    const skills = await db.dashboard.getSkills();
    assert.deepEqual(
      skills.map((s) => [s.id, s.invocationCount, s.lastUsedAt]),
      [
        ["claude:core:core/foo", 4, T3],
        ["codex:core:core/foo", 1, T2],
        ["claude:standalone:bar", 1, T1],
      ]
    );
    const claudeFoo = skills[0];
    assert.equal(claudeFoo?.description, "fresh");
    assert.equal(claudeFoo?.installPath, "/new");
    // The pack rollup reads the same aggregated list.
    const packs = await db.dashboard.getPacks();
    assert.deepEqual(
      packs.map((p) => [p.id, p.skillCount, p.toolCallCount]),
      [["core", 2, 5]]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
