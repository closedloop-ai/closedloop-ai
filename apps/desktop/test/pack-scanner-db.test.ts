/**
 * @file pack-scanner-db.test.ts
 * @description FEA-1791 (PLN-886 follow-up) — covers the two pack-scanner
 * functions that touch the DB directly (everything else probes the filesystem
 * and upserts via pack-store). Both now run on the single DesktopPrisma client
 * via typed delegates rather than raw SQL:
 *   - getRecentProjectRoots → `session.findMany` with `distinct: ['cwd']` and
 *     the recency (updated_at/started_at) lookback filter.
 *   - pruneStaleRows → `agentPack.updateMany` / `skill.updateMany` tombstones
 *     and `projectPackAssociation.deleteMany`.
 * `distinct` is the one delegate operation not exercised elsewhere, so this
 * guards against the community adapter silently not de-duplicating.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { _internals } from "../src/main/packs/pack-scanner.js";
import { openTestPrisma, type RawDb } from "./prisma-test-utils.js";

const { getRecentProjectRoots, pruneStaleRows } = _internals;

async function seedSession(
  db: RawDb,
  opts: {
    id: string;
    cwd: string | null;
    startedAt: string;
    updatedAt?: string;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO sessions (id, name, status, cwd, started_at, updated_at)
     VALUES ($1, $2, 'running', $3, $4, $5)`,
    [
      opts.id,
      `Session ${opts.id}`,
      opts.cwd,
      opts.startedAt,
      opts.updatedAt ?? null,
    ]
  );
}

test("getRecentProjectRoots: distinct cwd within the lookback, skips null/empty/stale", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    // Relative to now so the row stays inside the live 90-day lookback window
    // (`getRecentProjectRoots` derives `since` from Date.now()); a hardcoded
    // absolute date would silently fall out of the window and fail CI ~90 days
    // later. The stale date is far enough back to stay excluded regardless.
    const recent = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const stale = "2020-01-01T00:00:00.000Z";
    // Two sessions share /work/a → distinct collapses them to one.
    await seedSession(db, { id: "s1", cwd: "/work/a", startedAt: recent });
    await seedSession(db, { id: "s2", cwd: "/work/a", startedAt: recent });
    await seedSession(db, { id: "s3", cwd: "/work/b", startedAt: recent });
    // Old session (outside the 90-day lookback) is excluded.
    await seedSession(db, { id: "s4", cwd: "/work/old", startedAt: stale });
    // Null and empty cwd are excluded.
    await seedSession(db, { id: "s5", cwd: null, startedAt: recent });
    await seedSession(db, { id: "s6", cwd: "", startedAt: recent });

    const roots = await getRecentProjectRoots(prisma);
    assert.deepEqual([...roots].sort(), ["/work/a", "/work/b"]);
  } finally {
    await close();
  }
});

test("pruneStaleRows: tombstones stale agent_packs/skills, deletes stale associations", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    const scanStartedAt = "2026-06-18T12:00:00.000Z";
    const fresh = "2026-06-18T13:00:00.000Z"; // after scan start → kept
    const stale = "2026-06-18T11:00:00.000Z"; // before scan start → pruned

    // Two packs: one refreshed this scan, one stale (to be tombstoned).
    await db.query(
      `INSERT INTO agent_packs (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
       VALUES ('fresh', 'claude', '/p/fresh', 'directory', $1, $1),
              ('stale', 'claude', '/p/stale', 'directory', $2, $2)`,
      [fresh, stale]
    );
    await db.query(
      `INSERT INTO skills (skill_id, pack_id, harness, install_path, name, detected_at, last_seen_at)
       VALUES ('sk-fresh', 'fresh', 'claude', '/p/fresh', 'a', $1, $1),
              ('sk-stale', 'stale', 'claude', '/p/stale', 'b', $2, $2)`,
      [fresh, stale]
    );
    await db.query(
      `INSERT INTO project_pack_associations (project_path, pack_id, detected_at, last_seen_at)
       VALUES ('/proj/fresh', 'fresh', $1, $1),
              ('/proj/stale', 'stale', $2, $2)`,
      [fresh, stale]
    );

    await pruneStaleRows(prisma, scanStartedAt);

    // Stale pack/skill are tombstoned (uninstalled_at set); fresh untouched.
    const packs = await prisma.client.agentPack.findMany({
      select: { packId: true, uninstalledAt: true },
      orderBy: { packId: "asc" },
    });
    assert.deepEqual(packs, [
      { packId: "fresh", uninstalledAt: null },
      { packId: "stale", uninstalledAt: scanStartedAt },
    ]);

    const skills = await prisma.client.skill.findMany({
      select: { skillId: true, uninstalledAt: true },
      orderBy: { skillId: "asc" },
    });
    assert.deepEqual(skills, [
      { skillId: "sk-fresh", uninstalledAt: null },
      { skillId: "sk-stale", uninstalledAt: scanStartedAt },
    ]);

    // Stale association is deleted outright; fresh remains.
    const assocs = await prisma.client.projectPackAssociation.findMany({
      select: { projectPath: true },
    });
    assert.deepEqual(
      assocs.map((a) => a.projectPath),
      ["/proj/fresh"]
    );
  } finally {
    await close();
  }
});
