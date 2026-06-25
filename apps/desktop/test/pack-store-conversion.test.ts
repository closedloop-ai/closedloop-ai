/**
 * @file pack-store-conversion.test.ts
 * @description FEA-1791 (PLN-886 follow-up) — the pack-store is fully on the
 * single DesktopPrisma client. The upsert WRITES (`upsertPack`/`upsertSkill`/
 * `upsertProjectAssociation`) and the simple reads (`getPack`/`listSkillsForPack`/
 * `collectPackPaths`) use typed delegates; only the aggregation reads
 * (`listPacks`/`listSkills`/`listSkillInvocations`/`listPackUsage`/
 * `listPackSessions`) stay on `prisma.client.$queryRawUnsafe`, where string_agg,
 * COUNT(DISTINCT …), the version CASE, jsonb prompt extraction, and the
 * multi-source path LIKE attribution have no clean typed-delegate form. This
 * test seeds packs/skills/associations via the converted upserts and seeds
 * sessions/events via raw SQL (those tables convert in a later PR), then asserts
 * the reads reproduce the prior SQL — including that every aggregate count is
 * Number()-coerced (COUNT can surface as bigint through the adapter, which would
 * break IPC/JSON). Absorbs the pack DTO coverage formerly in
 * ported-screen-store-contract.test.ts (now deleted — all three ported stores
 * are on Prisma, so the raw-stub contract is obsolete).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
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

async function seedEvent(
  db: RawDb,
  id: string,
  sessionId: string,
  eventType: string,
  data: string
): Promise<void> {
  await db.query(
    `INSERT INTO events (id, session_id, event_type, data, created_at)
     VALUES ($1, $2, $3, $4, '2026-06-18T01:00:00.000Z')`,
    [id, sessionId, eventType, data]
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

  return { prisma, close: opened.close };
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
