/**
 * @file pack-store-conversion.test.ts
 * @description The pack-store runs on the one DesktopPrisma layer. The upsert
 * WRITES (`upsertPack`/`upsertSkill`/`upsertProjectAssociation`) and the simple
 * reads (`getPack`/`listSkillsForPack`/`collectPackPaths`) use typed delegates;
 * only the aggregation reads (`listPacks`/`listSkills`/`listSkillInvocations`/
 * `listPackUsage`/`listPackSessions`) stay on `$queryRawUnsafe`, where
 * group_concat, COUNT(DISTINCT …), the version CASE, json_extract prompt
 * extraction, and the multi-source path LIKE attribution have no clean
 * typed-delegate form. Four of those five run on the reader pool; which
 * connection each takes is pinned by the sibling
 * `pack-store-reader-pool.test.ts`, not here. This test seeds
 * packs/skills/associations via the typed upserts and seeds sessions/events via
 * raw SQL, then asserts the reads produce the correct results — including that
 * every aggregate count is Number()-coerced (COUNT can surface as bigint through
 * the adapter, which would break IPC/JSON).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { MS_PER_DAY } from "../src/main/database/db-helpers.js";
import { DEFAULT_SESSION_RETENTION_DAYS } from "../src/main/database/session-maintenance.js";
import {
  getPack,
  listPackSessions,
  listPacks,
  listPackUsage,
  listSkillInvocations,
  listSkills,
  upsertPack,
  upsertProjectAssociation,
  upsertSkill,
} from "../src/main/packs/pack-store.js";
import { openTestPrisma, type RawDb } from "./prisma-test-utils.js";

async function seedSession(db: RawDb, id: string): Promise<void> {
  await db.query(
    `INSERT INTO sessions (id, name, status, cwd, harness, started_at)
     VALUES ($1, $2, 'running', '/work', 'claude', '2026-06-18T00:00:00.000Z')`,
    [id, `Session ${id}`]
  );
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

// An hour back, not a day: the `lookbackDays: 0` case below clamps to a
// one-day floor, and a fixture seeded at exactly one day old would fall on the
// wrong side of that cutoff by however long the test took to reach it.
const RECENT_EVENT_ISO = new Date(Date.now() - 60 * 60_000).toISOString();

// ISS-6751: `created_at` is seeded RELATIVE TO NOW, not at a fixed calendar
// date. `listPackSessions` bounds its scan to a rolling
// DEFAULT_SESSION_RETENTION_DAYS window, so a hardcoded timestamp would have
// aged out of that window on a real clock and turned these assertions red for
// reasons that have nothing to do with the code under test.
async function seedEvent(
  db: RawDb,
  id: string,
  sessionId: string,
  eventType: string,
  data: string,
  createdAt: string = RECENT_EVENT_ISO
): Promise<void> {
  await db.query(
    `INSERT INTO events (id, session_id, event_type, data, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, sessionId, eventType, data, createdAt]
  );
}

async function setup() {
  const opened = await openTestPrisma();
  const { db, prisma } = opened;

  // alpha: one pack_id across two harnesses (string_agg fan-out), single version.
  await upsertPack(prisma, {
    pack_id: "alpha",
    harness: "claude",
    install_path: "/packs/alpha",
    install_kind: "directory",
    version: "1.0.0",
  });
  await upsertPack(prisma, {
    pack_id: "alpha",
    harness: "codex",
    install_path: "/packs/alpha-codex",
    install_kind: "directory",
    version: "1.0.0",
  });
  // beta: two installs at DIFFERENT versions → the version CASE collapses to NULL.
  await upsertPack(prisma, {
    pack_id: "beta",
    harness: "claude",
    install_path: "/packs/beta",
    install_kind: "directory",
    version: "1.0.0",
  });
  await upsertPack(prisma, {
    pack_id: "beta",
    harness: "claude",
    install_path: "/packs/beta2",
    install_kind: "directory",
    version: "2.0.0",
  });

  await upsertSkill(prisma, {
    skill_id: "sk-alpha-1",
    pack_id: "alpha",
    harness: "claude",
    install_path: "/packs/alpha",
    name: "alpha-skill",
  });
  await upsertProjectAssociation(prisma, {
    project_path: "/proj",
    pack_id: "alpha",
  });

  await seedSession(db, "s1");
  await seedSession(db, "s2");
  // Slash-command invocation of alpha-skill (drives listSkills invocationCount).
  await seedEvent(
    db,
    "e1",
    "s1",
    "UserPromptSubmit",
    JSON.stringify({ prompt: "/alpha-skill run" })
  );
  // Two events (two sessions) whose data references alpha's install paths
  // (drives listPackUsage tool_calls / distinct sessions).
  await seedEvent(
    db,
    "e2",
    "s1",
    "PreToolUse",
    JSON.stringify({ cmd: "cat /packs/alpha/file.md" })
  );
  await seedEvent(
    db,
    "e3",
    "s2",
    "PreToolUse",
    JSON.stringify({ cmd: "ls /packs/alpha-codex" })
  );

  return { db, prisma, close: opened.close };
}

test("listPacks: string_agg harnesses, version CASE, Number() skillCount", async () => {
  const { prisma, close } = await setup();
  try {
    const packs = await listPacks(prisma);
    assert.deepEqual(
      packs.map((p) => p.packId),
      ["alpha", "beta"]
    );

    const alpha = packs[0]!;
    assert.deepEqual([...alpha.harnesses].sort(), ["claude", "codex"]);
    assert.equal(alpha.skillCount, 1);
    // COUNT subquery has no ::int cast — guard against a bigint regression that
    // would break IPC serialization.
    assert.equal(typeof alpha.skillCount, "number");

    const beta = packs[1]!;
    assert.deepEqual(beta.harnesses, ["claude"]);
    assert.equal(beta.skillCount, 0);
  } finally {
    await close();
  }
});

test("getPack: installs + skills + associations; null for missing", async () => {
  const { prisma, close } = await setup();
  try {
    const alpha = await getPack(prisma, "alpha");
    assert.equal(alpha?.installs.length, 2);
    assert.deepEqual([...(alpha?.harnesses ?? [])].sort(), ["claude", "codex"]);
    assert.equal(alpha?.skills.length, 1);
    assert.equal(alpha?.skills[0]?.skillId, "sk-alpha-1");
    assert.equal(alpha?.associations[0]?.projectPath, "/proj");

    assert.equal(await getPack(prisma, "missing"), null);
  } finally {
    await close();
  }
});

test("listSkills: invocationCount from UserPromptSubmit events, Number()-coerced", async () => {
  const { prisma, close } = await setup();
  try {
    const skills = await listSkills(prisma);
    const alphaSkill = skills.find((s) => s.name === "alpha-skill");
    assert.equal(alphaSkill?.invocationCount, 1);
    assert.equal(typeof alphaSkill?.invocationCount, "number");
  } finally {
    await close();
  }
});

test("listPackUsage: path LIKE attribution with Number()-coerced tool_calls/sessions", async () => {
  const { prisma, close } = await setup();
  try {
    const usage = await listPackUsage(prisma);
    const alpha = usage.find((u) => u.pack_id === "alpha");
    // e2 (/packs/alpha) + e3 (/packs/alpha-codex) across sessions s1, s2.
    assert.equal(alpha?.tool_calls, 2);
    assert.equal(alpha?.sessions, 2);
    assert.equal(typeof alpha?.tool_calls, "number");
    assert.equal(typeof alpha?.sessions, "number");
  } finally {
    await close();
  }
});

test("listSkillInvocations: maps DTO from UserPromptSubmit events; harness filter exercises the param spread", async () => {
  const { prisma, close } = await setup();
  try {
    const invocations = await listSkillInvocations(prisma, "alpha-skill");
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0]?.eventId, "e1");
    assert.equal(invocations[0]?.sessionId, "s1");
    assert.equal(invocations[0]?.sessionName, "Session s1");
    assert.equal(invocations[0]?.harness, "claude");

    // Optional harness filter adds a positional param ($2 before limit/offset) —
    // exercises the dynamic `...params` spread through $queryRawUnsafe.
    assert.equal(
      (await listSkillInvocations(prisma, "alpha-skill", { harness: "claude" }))
        .length,
      1
    );
    assert.equal(
      (await listSkillInvocations(prisma, "alpha-skill", { harness: "codex" }))
        .length,
      0
    );
  } finally {
    await close();
  }
});

test("listPackSessions: per-session rollup with Number()-coerced tool_calls", async () => {
  const { prisma, close } = await setup();
  try {
    const sessions = await listPackSessions(prisma, "alpha");
    // s1 (e2) and s2 (e3) each touched an alpha path once.
    assert.deepEqual(sessions.map((s) => s.session_id).sort(), ["s1", "s2"]);
    assert.equal(sessions[0]?.tool_calls, 1);
    assert.equal(typeof sessions[0]?.tool_calls, "number");
  } finally {
    await close();
  }
});

// ISS-6751: the pack-path attribution is a leading-wildcard `data LIKE '%…%'`
// that no index can serve, and the LIMIT applies AFTER the GROUP BY — so before
// the fix the read dragged EVERY event row's multi-KB `data` blob through the
// db-host worker on every call, with cost growing with total event volume
// rather than with the pack's usage. The scan is now floored at a
// `created_at >= ?` window. This test fails if that predicate (or the parens
// around the OR-chain it ANDs onto) is removed: an out-of-window session comes
// back.
test("listPackSessions: scan is floored at the created_at lookback window (ISS-6751)", async () => {
  const { db, prisma, close } = await setup();
  try {
    // Two out-of-window sessions, deliberately hitting DIFFERENT detection
    // paths — the install path and the project association. Dropping the parens
    // around the OR-chain leaves only ONE clause ANDed to the window, so
    // whichever path is not first would go back to an unbounded scan; with a
    // session behind each path, that mutation always surfaces here.
    await seedSession(db, "s-old-install");
    await seedEvent(
      db,
      "e-old-install",
      "s-old-install",
      "PreToolUse",
      JSON.stringify({ cmd: "cat /packs/alpha/ancient.md" }),
      daysAgoIso(DEFAULT_SESSION_RETENTION_DAYS + 30)
    );
    await seedSession(db, "s-old-assoc");
    await seedEvent(
      db,
      "e-old-assoc",
      "s-old-assoc",
      "PreToolUse",
      JSON.stringify({ cmd: "cat /proj/ancient.md" }),
      daysAgoIso(DEFAULT_SESSION_RETENTION_DAYS + 30)
    );

    // Default window: the in-window sessions only.
    assert.deepEqual(
      (await listPackSessions(prisma, "alpha")).map((s) => s.session_id).sort(),
      ["s1", "s2"]
    );

    // Widened explicitly: both old sessions are reachable again, so their
    // absence above is the WINDOW and not a broken LIKE or a dropped row.
    assert.deepEqual(
      (
        await listPackSessions(prisma, "alpha", {
          lookbackDays: DEFAULT_SESSION_RETENTION_DAYS + 365,
        })
      )
        .map((s) => s.session_id)
        .sort(),
      ["s-old-assoc", "s-old-install", "s1", "s2"]
    );
  } finally {
    await close();
  }
});

// The window is only ever a floor: a caller cannot widen it into an unbounded
// scan by passing a value that would make `new Date(...)` invalid. NaN falls
// back to the default window; 0/negative clamp to one day.
test("listPackSessions: non-finite and sub-day lookbacks stay bounded (ISS-6751)", async () => {
  const { db, prisma, close } = await setup();
  try {
    await seedSession(db, "s-old-install");
    await seedEvent(
      db,
      "e-old-install",
      "s-old-install",
      "PreToolUse",
      JSON.stringify({ cmd: "cat /packs/alpha/ancient.md" }),
      daysAgoIso(DEFAULT_SESSION_RETENTION_DAYS + 30)
    );

    // NaN → default window, not an Invalid Date (whose toISOString() throws).
    assert.deepEqual(
      (await listPackSessions(prisma, "alpha", { lookbackDays: Number.NaN }))
        .map((s) => s.session_id)
        .sort(),
      ["s1", "s2"]
    );
    // Finite but absurd. These pass `Number.isFinite`, so the finite-check
    // alone does not cover them: the cutoff overflows past the epoch and
    // `new Date(...)` goes Invalid, whose `toISOString()` THROWS on a live IPC
    // read. Clamped at the epoch they degrade to "no lower bound" and return
    // everything, which is what asking for a window that wide means.
    for (const absurd of [
      Number.MAX_SAFE_INTEGER,
      1e308,
      Number.POSITIVE_INFINITY,
    ]) {
      assert.deepEqual(
        (await listPackSessions(prisma, "alpha", { lookbackDays: absurd }))
          .map((s) => s.session_id)
          .sort(),
        ["s-old-install", "s1", "s2"],
        `lookbackDays: ${absurd} must clamp to the epoch, not throw`
      );
    }
    // 0 clamps to one day, which still covers the hour-old fixture events.
    assert.deepEqual(
      (await listPackSessions(prisma, "alpha", { lookbackDays: 0 }))
        .map((s) => s.session_id)
        .sort(),
      ["s1", "s2"]
    );
  } finally {
    await close();
  }
});

// ISS-6751: `events.created_at` is TEXT and is NOT one of the columns the
// timestamp-format heal normalizes (`HEALED_COLUMNS` omits it), so a row can
// hold a value that is not date-shaped at all. Byte-wise, such a value sorts
// ABOVE every ISO timestamp — so a bare `created_at >= ?` lower bound admits it
// at EVERY window width, which is the opposite of what a bound is for. This
// fails if the ISO_DATE_PREFIX_GLOB_SQL guard is dropped from the query.
test("listPackSessions: a non-date-shaped created_at is not admitted by the window (ISS-6751)", async () => {
  const { db, prisma, close } = await setup();
  try {
    await seedSession(db, "s-junk");
    await seedEvent(
      db,
      "e-junk",
      "s-junk",
      "PreToolUse",
      JSON.stringify({ cmd: "cat /packs/alpha/junk.md" }),
      "not-a-timestamp"
    );

    // Sanity: the junk value really does outrank the cutoff, so its exclusion
    // below is the GUARD doing the work and not the range predicate.
    assert.ok(
      new Date().toISOString() < "not-a-timestamp",
      "fixture must sort above the cutoff for this test to mean anything"
    );

    assert.deepEqual(
      (await listPackSessions(prisma, "alpha")).map((s) => s.session_id).sort(),
      ["s1", "s2"]
    );
    // Not merely out-of-window: no width of window can order it, so widening
    // must not surface it either.
    assert.deepEqual(
      (
        await listPackSessions(prisma, "alpha", {
          lookbackDays: Number.POSITIVE_INFINITY,
        })
      )
        .map((s) => s.session_id)
        .sort(),
      ["s1", "s2"]
    );
  } finally {
    await close();
  }
});

// FEA-3048 (root cause 4): the legacy Skills-page prompt matcher must match
// "leading slash + at least one more char" via an escape-safe form (literal
// '/%' + length > 1), NOT the bare `_` LIKE wildcard. A bare "/" prompt must be
// excluded; a "/name" prompt must still count.
test("listSkills: escape-safe leading-slash match excludes bare '/' but counts '/name' (FEA-3048)", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await upsertSkill(prisma, {
      skill_id: "sk-esc",
      pack_id: null,
      harness: "claude",
      install_path: "/local/esc-skill",
      name: "esc-skill",
    });
    await seedSession(db, "sess-esc");
    // A valid "/esc-skill" invocation — MUST be counted.
    await seedEvent(
      db,
      "esc-1",
      "sess-esc",
      "UserPromptSubmit",
      JSON.stringify({ prompt: "/esc-skill go" })
    );
    // A bare "/" prompt — MUST NOT be counted (no skill name, length == 1).
    await seedEvent(
      db,
      "esc-2",
      "sess-esc",
      "UserPromptSubmit",
      JSON.stringify({ prompt: "/" })
    );

    const skills = await listSkills(prisma);
    const escSkill = skills.find((s) => s.name === "esc-skill");
    assert.equal(
      escSkill?.invocationCount,
      1,
      "only the '/esc-skill' prompt counts; the bare '/' is excluded"
    );
  } finally {
    await close();
  }
});

// ISS-6752: the invocation-count subquery now narrows to the installed
// skill-name set before it GROUP BYs, so the group set scales with the small
// `skills` inventory rather than with total prompt history. That narrowing is
// only safe if it is a strict subset of what the outer LEFT JOIN already kept,
// so this pins the observable half of that claim: prompt-history noise that
// matches no live install must not perturb an installed skill's count.
//
// The inner `uninstalled_at IS NULL` half is deliberately NOT pinnable -- the
// outer `WHERE s.uninstalled_at IS NULL` already drops every tombstoned row,
// so dropping the inner copy changes no output, only how many groups the
// aggregate builds. The tombstoned-skill assertion below therefore pins the
// pre-existing tombstone contract (unchanged by this diff), not the new inner
// predicate; deleting that inner predicate leaves this test green by design.
test("listSkills: unrelated slash prompts don't perturb installed counts, tombstoned skills stay out (ISS-6752)", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await upsertSkill(prisma, {
      skill_id: "sk-live",
      pack_id: null,
      harness: "claude",
      install_path: "/local/live-skill",
      name: "live-skill",
    });
    await upsertSkill(prisma, {
      skill_id: "sk-gone",
      pack_id: null,
      harness: "claude",
      install_path: "/local/gone-skill",
      name: "gone-skill",
    });
    await db.query(
      "UPDATE skills SET uninstalled_at = $1 WHERE skill_id = 'sk-gone'",
      ["2026-06-18T02:00:00.000Z"]
    );
    await seedSession(db, "sess-narrow");

    // Two real invocations of the installed skill.
    await seedEvent(
      db,
      "nar-1",
      "sess-narrow",
      "UserPromptSubmit",
      JSON.stringify({ prompt: "/live-skill go" })
    );
    await seedEvent(
      db,
      "nar-2",
      "sess-narrow",
      "UserPromptSubmit",
      JSON.stringify({ prompt: "/live-skill" })
    );
    // Prompt-history noise that matches no install: a slash command for a
    // skill that was never installed, and a path-shaped prompt.
    await seedEvent(
      db,
      "nar-3",
      "sess-narrow",
      "UserPromptSubmit",
      JSON.stringify({ prompt: "/never-installed do a thing" })
    );
    await seedEvent(
      db,
      "nar-4",
      "sess-narrow",
      "UserPromptSubmit",
      JSON.stringify({ prompt: "/Users/someone/notes.md" })
    );
    // A prompt for the tombstoned skill.
    await seedEvent(
      db,
      "nar-5",
      "sess-narrow",
      "UserPromptSubmit",
      JSON.stringify({ prompt: "/gone-skill run" })
    );

    const skills = await listSkills(prisma);
    assert.equal(
      skills.find((s) => s.name === "live-skill")?.invocationCount,
      2,
      "both '/live-skill' prompts still count through the narrowed subquery"
    );
    assert.equal(
      skills.find((s) => s.name === "gone-skill"),
      undefined,
      "tombstoned skills are excluded from the result, as before"
    );
  } finally {
    await close();
  }
});

// The upsert UPDATE branch (the typed-delegate emulation of the prior
// `ON CONFLICT … COALESCE(excluded, existing)`) is the trickiest part of the
// write conversion, so exercise it directly: re-upserting the same key must
// keep set-if-null columns when no new value is supplied, overwrite when one
// is, and clear the tombstone.
test("upsertPack: conflict branch is COALESCE set-if-null and clears the tombstone", async () => {
  const { db, prisma, close } = await openTestPrisma();
  const key = {
    packId_harness_installPath: {
      packId: "p",
      harness: "claude",
      installPath: "/p",
    },
  };
  try {
    await upsertPack(prisma, {
      pack_id: "p",
      harness: "claude",
      install_path: "/p",
      install_kind: "directory",
      source_url: "https://u/1",
      version: "1.0.0",
    });
    const first = await prisma.client.agentPack.findUnique({ where: key });
    const detectedAt = first?.detectedAt;

    // No version/source_url supplied → both preserved; install_kind refreshed.
    await upsertPack(prisma, {
      pack_id: "p",
      harness: "claude",
      install_path: "/p",
      install_kind: "symlink",
    });
    const kept = await prisma.client.agentPack.findUnique({ where: key });
    assert.equal(kept?.version, "1.0.0");
    assert.equal(kept?.sourceUrl, "https://u/1");
    assert.equal(kept?.installKind, "symlink");
    assert.equal(kept?.detectedAt, detectedAt); // detected_at preserved

    // A new version overwrites.
    await upsertPack(prisma, {
      pack_id: "p",
      harness: "claude",
      install_path: "/p",
      install_kind: "directory",
      version: "2.0.0",
    });
    assert.equal(
      (await prisma.client.agentPack.findUnique({ where: key }))?.version,
      "2.0.0"
    );

    // Tombstone then re-upsert → uninstalled_at cleared.
    await db.query(
      "UPDATE agent_packs SET uninstalled_at = '2026-01-01T00:00:00.000Z' WHERE pack_id = 'p'"
    );
    await upsertPack(prisma, {
      pack_id: "p",
      harness: "claude",
      install_path: "/p",
      install_kind: "directory",
    });
    assert.equal(
      (await prisma.client.agentPack.findUnique({ where: key }))?.uninstalledAt,
      null
    );
  } finally {
    await close();
  }
});

test("upsertSkill: conflict branch re-points pack_id and is COALESCE set-if-null", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await upsertSkill(prisma, {
      skill_id: "sk",
      pack_id: "p1",
      harness: "claude",
      install_path: "/p",
      name: "s",
      version: "1.0.0",
      description: "d1",
    });
    // pack_id is always re-pointed (even to null); version/description preserved
    // when not supplied.
    await upsertSkill(prisma, {
      skill_id: "sk",
      pack_id: "p2",
      harness: "claude",
      install_path: "/p",
      name: "s",
    });
    const row = await prisma.client.skill.findUnique({
      where: { skillId: "sk" },
    });
    assert.equal(row?.packId, "p2");
    assert.equal(row?.version, "1.0.0");
    assert.equal(row?.description, "d1");

    // pack_id is re-pointed unconditionally, including to null when omitted
    // (the update branch sets `packId` rather than COALESCE-spreading it) — pin
    // that the adapter writes an explicit NULL, not a no-op.
    await upsertSkill(prisma, {
      skill_id: "sk",
      harness: "claude",
      install_path: "/p",
      name: "s",
    });
    const orphaned = await prisma.client.skill.findUnique({
      where: { skillId: "sk" },
    });
    assert.equal(orphaned?.packId, null);
    assert.equal(orphaned?.version, "1.0.0"); // still preserved
  } finally {
    await close();
  }
});
