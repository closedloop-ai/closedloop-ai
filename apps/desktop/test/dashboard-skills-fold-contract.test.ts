import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
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

// ISS-6414: `events.created_at` is TEXT holding raw harness text, and is
// deliberately outside the FEA-3743 heal's `HEALED_COLUMNS`, so one skill's
// events can carry BOTH a whole-second and a sub-second spelling of the same
// second. A byte-wise `MAX` over that text returns the EARLIER instant (`Z`
// 0x5A sorts after `.` 0x2E) and drags that row's description/install_path
// along as the bare columns. A fixture written in one consistent format passes
// while that is live, so the groups below MIX the formats — in MIRRORED
// insertion order, so no "first row" / "last row" accident can satisfy them
// all.
const SUB_SECOND_AT = "2026-06-20T10:00:00.500Z";
const WHOLE_SECOND_AT = "2026-06-20T10:00:00Z";
// The third group is the OTHER half of the ISS-5497 rule: a basic-format offset
// SQLite cannot parse, three days LATER than its canonical sibling. It is the
// genuine winner and a byte-wise fold already gets it right, so a fold that
// canonicalized what it could and dropped what it could not would move this
// group's last-used three days BACKWARD — a regression on a shape the store is
// known to hold (ISS-5497 measured it there). The group must therefore fall
// back whole to the pre-ISS-6414 answer.
const UNPARSEABLE_LATER_AT = "2026-06-25T10:00:00.000+0530";
const CANONICAL_EARLIER_AT = "2026-06-22T10:00:00.000Z";
// `core/mix` is the FIRST half of that rule, and the only group that fails a
// fold which MIXES a canonicalized operand with a raw one. Canonicalizing lowers
// a value's text whenever it applies a positive offset — 23:00+05:00 becomes
// 18:00Z — so beside an un-canonicalizable 15:30Z sibling that still reads
// `T21:00`, the sibling out-sorts the true winner and last-used moves 2.5h back.
// ISS-5497 measured exactly this pair. `core/c` cannot catch it: its
// un-canonicalizable row wins byte-wise too, so a mixed fold gets it right by
// luck.
const OFFSET_LATER_AT = "2026-06-22T23:00:00+05:00";
const UNPARSEABLE_EARLIER_AT = "2026-06-22T21:00:00.000+0530";
// `core/nullstamp` is the only group that fails the ISS-5497 spelling of the
// mode test, `COUNT(*)`. `events.created_at` is nullable, and a NULL stamp
// canonicalizes to NULL without being a DISSENTER — it simply never competes.
// Counting rows instead of stamps would read it as one, drop the whole group to
// the byte-wise arm, and hand ISS-6414 straight back.
const NO_STAMP_AT: string | null = null;

test("ISS-6414: getSkills folds last-used by instant across mixed precision", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-skill-instant-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  const insertSkillEvent = async (
    id: string,
    data: unknown,
    createdAt: string | null
  ): Promise<void> => {
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, data, created_at)
       VALUES ($1, 's-claude', 'PreToolUse', 'Skill', $2, $3)`,
      id,
      JSON.stringify(data),
      createdAt
    );
  };
  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ('s-claude', 's-claude', 'inactive', $1, $1, 'claude')`,
      WHOLE_SECOND_AT
    );
    // Sub-second event FIRST here…
    await insertSkillEvent(
      "a1",
      { skillName: "core/a", description: "newer", installPath: "/newer" },
      SUB_SECOND_AT
    );
    await insertSkillEvent(
      "a2",
      { skillName: "core/a", description: "older", installPath: "/older" },
      WHOLE_SECOND_AT
    );
    // …and LAST here.
    await insertSkillEvent(
      "b1",
      { skillName: "core/b", description: "older", installPath: "/older" },
      WHOLE_SECOND_AT
    );
    await insertSkillEvent(
      "b2",
      { skillName: "core/b", description: "newer", installPath: "/newer" },
      SUB_SECOND_AT
    );
    await insertSkillEvent(
      "c1",
      { skillName: "core/c", description: "older", installPath: "/older" },
      CANONICAL_EARLIER_AT
    );
    await insertSkillEvent(
      "c2",
      { skillName: "core/c", description: "newer", installPath: "/newer" },
      UNPARSEABLE_LATER_AT
    );
    await insertSkillEvent(
      "m1",
      { skillName: "core/mix", description: "newer", installPath: "/newer" },
      OFFSET_LATER_AT
    );
    await insertSkillEvent(
      "m2",
      { skillName: "core/mix", description: "older", installPath: "/older" },
      UNPARSEABLE_EARLIER_AT
    );
    await insertSkillEvent(
      "n1",
      {
        skillName: "core/nullstamp",
        description: "none",
        installPath: "/none",
      },
      NO_STAMP_AT
    );
    await insertSkillEvent(
      "n2",
      {
        skillName: "core/nullstamp",
        description: "older",
        installPath: "/older",
      },
      WHOLE_SECOND_AT
    );
    await insertSkillEvent(
      "n3",
      {
        skillName: "core/nullstamp",
        description: "newer",
        installPath: "/newer",
      },
      SUB_SECOND_AT
    );

    const skills = await db.dashboard.getSkills();

    // Every group folds to the event a reader would call latest and hands the
    // descriptive columns to that SAME row; the per-group count is what says the
    // spellings met in one group at all rather than splitting and never having
    // to choose. Each group is the ONLY one that fails a different wrong fold:
    // `core/a`/`core/b` fail one that never canonicalizes, `core/c` one that
    // drops what it cannot canonicalize, `core/mix` one that mixes canonical
    // with raw operands, and `core/nullstamp` one that tests the mode with
    // `COUNT(*)` instead of `COUNT(created_at)`.
    assert.deepEqual(
      skills.map((skill) => [
        skill.name,
        skill.invocationCount,
        skill.lastUsedAt,
        skill.description,
        skill.installPath,
      ]),
      [
        ["core/c", 2, UNPARSEABLE_LATER_AT, "newer", "/newer"],
        ["core/mix", 2, OFFSET_LATER_AT, "newer", "/newer"],
        ["core/a", 2, SUB_SECOND_AT, "newer", "/newer"],
        ["core/b", 2, SUB_SECOND_AT, "newer", "/newer"],
        ["core/nullstamp", 3, SUB_SECOND_AT, "newer", "/newer"],
      ]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
