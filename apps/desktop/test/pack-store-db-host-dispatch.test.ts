/**
 * @file pack-store-db-host-dispatch.test.ts
 * @description ISS-6753 — the four `packStore.*` `store:` ops resolve through
 * the production `dispatchDbHostStoreOp` against a real SQLite store.
 *
 * The op NAME is the whole seam: main sends a string and the db-host looks it up
 * in a `Record`, so a key that does not match is a runtime
 * `db-host store op not found` that `tsc`, Biome, and every pack suite stay
 * green through. `PackStoreReadOp` makes both ends share one literal; this suite
 * proves the shared literal actually reaches a registered handler, which the
 * constant alone cannot (a matching pair of wrong names still compiles).
 *
 * Same shape as `repository-default-authority-db-host-dispatch.test.ts`, which
 * covers the sibling ops in the same registry.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  DB_HOST_STORE_OP_PREFIX,
  dispatchDbHostStoreOp,
} from "../src/main/database/db-host/db-host-store-op-registry.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  PackStoreReadOp,
  upsertPack,
  upsertSkill,
} from "../src/main/packs/pack-store.js";
import { openTestPrisma, type RawDb } from "./prisma-test-utils.js";

const PACK_ID = "dispatch-pack";
const OTHER_PACK_ID = "dispatch-other-pack";
const HARNESS = "claude";
const INSTALL_PATH = "/packs/dispatch-pack";
const OTHER_INSTALL_PATH = "/packs/dispatch-other-pack";
const SKILL_NAME = "dispatch-skill";
const OTHER_SKILL_NAME = "dispatch-other-skill";
const SESSION_ID = "dispatch-session";
const OTHER_SESSION_ID = "dispatch-other-session";
const RECENT_ISO = new Date(Date.now() - 60 * 60_000).toISOString();

/**
 * ISS-9279: `created_at` is seeded RELATIVE TO NOW, never at a fixed calendar
 * date — the same rule, and the same reason, as the sibling
 * `pack-store-conversion.test.ts`. `listPackSessions` floors its scan at a
 * rolling DEFAULT_SESSION_RETENTION_DAYS window on the REAL clock
 * (`eventLookbackCutoff`, which has no injectable `now`), so a hardcoded stamp
 * silently ages out of that window and turns the dispatch assertion below red
 * on a date that has nothing to do with the argument hop under test. The stamps
 * here were `2026-06-18`, which would have gone red on 2026-09-16.
 *
 * An hour back, not a day, so no fixture can land on the wrong side of the
 * cutoff because of how long the suite took to reach the assertion.
 *
 * Both packs get their own session and their own events, so an op that drops or
 * swaps its id answers with the OTHER pack's rows rather than with the empty
 * set. An empty-fixture assertion would pass for every id and prove nothing
 * about the argument hop this suite exists for.
 */
async function seed(db: RawDb, prisma: DesktopPrisma): Promise<void> {
  for (const [packId, installPath, skillName, sessionId] of [
    [PACK_ID, INSTALL_PATH, SKILL_NAME, SESSION_ID],
    [OTHER_PACK_ID, OTHER_INSTALL_PATH, OTHER_SKILL_NAME, OTHER_SESSION_ID],
  ] as const) {
    await upsertPack(prisma, {
      pack_id: packId,
      harness: HARNESS,
      install_path: installPath,
      install_kind: "plugin",
    });
    await upsertSkill(prisma, {
      skill_id: `${skillName}-id`,
      pack_id: packId,
      harness: HARNESS,
      install_path: installPath,
      name: skillName,
    });
    await db.query(
      `INSERT INTO sessions (id, name, status, cwd, harness, started_at)
       VALUES ($1, $2, 'running', '/work', $3, $4)`,
      [sessionId, `Session ${sessionId}`, HARNESS, RECENT_ISO]
    );
    await db.query(
      `INSERT INTO events (id, session_id, event_type, data, created_at)
       VALUES ($1, $2, 'UserPromptSubmit', $3, $4)`,
      [
        `${sessionId}-prompt`,
        sessionId,
        JSON.stringify({ prompt: `/${skillName} go` }),
        RECENT_ISO,
      ]
    );
    await db.query(
      `INSERT INTO events (id, session_id, event_type, data, created_at)
       VALUES ($1, $2, 'PreToolUse', $3, $4)`,
      [
        `${sessionId}-tool`,
        sessionId,
        JSON.stringify({ cmd: `ls ${installPath}` }),
        RECENT_ISO,
      ]
    );
  }
}

test("ISS-6753: production store IPC dispatch reaches every packStore read op", async () => {
  const opened = await openTestPrisma();
  const db = { prisma: opened.prisma } as SqliteAgentDatabase;
  try {
    await seed(opened.db, opened.prisma);

    const dispatch = (op: PackStoreReadOp, args: unknown[]) =>
      dispatchDbHostStoreOp({}, db, `${DB_HOST_STORE_OP_PREFIX}${op}`, args);

    const packs = await dispatch(PackStoreReadOp.ListPacks, []);
    assert.deepEqual(
      (packs as { packId: string }[]).map((pack) => pack.packId),
      [OTHER_PACK_ID, PACK_ID]
    );

    const skills = await dispatch(PackStoreReadOp.ListSkills, []);
    assert.deepEqual(
      (skills as { name: string }[]).map((skill) => skill.name),
      [OTHER_SKILL_NAME, SKILL_NAME]
    );

    // The id hop: each op must answer for the id it was HANDED. A dropped or
    // swapped argument answers for the other seeded pack/skill, which these
    // assertions reject — an empty-set assertion would not.
    const invocations = await dispatch(PackStoreReadOp.ListSkillInvocations, [
      SKILL_NAME,
    ]);
    assert.deepEqual(
      (invocations as { sessionId: string }[]).map((row) => row.sessionId),
      [SESSION_ID]
    );

    const sessions = await dispatch(PackStoreReadOp.ListPackSessions, [
      PACK_ID,
    ]);
    assert.deepEqual(
      (sessions as { session_id: string }[]).map((row) => row.session_id),
      [SESSION_ID]
    );

    assert.deepEqual(
      await dispatch(PackStoreReadOp.ListSkillInvocations, ["no-such-skill"]),
      [],
      "an unknown skill name resolves to no invocations"
    );
    assert.deepEqual(
      await dispatch(PackStoreReadOp.ListPackSessions, ["no-such-pack"]),
      [],
      "an unknown pack id resolves to no sessions"
    );
  } finally {
    await opened.close();
  }
});

test("ISS-6753: a packStore op rejects an argument that is not a string id", async () => {
  const opened = await openTestPrisma();
  const db = { prisma: opened.prisma } as SqliteAgentDatabase;
  try {
    // `async` so a schema that rejects SYNCHRONOUSLY and one that rejects
    // asynchronously both satisfy this — which of the two zod does is incidental
    // to the contract being pinned (a non-string id never reaches the store).
    await assert.rejects(async () => {
      await dispatchDbHostStoreOp(
        {},
        db,
        `${DB_HOST_STORE_OP_PREFIX}${PackStoreReadOp.ListPackSessions}`,
        [{ packId: PACK_ID }]
      );
    });
  } finally {
    await opened.close();
  }
});

test("ISS-6753: an inherited-member op name is not found, not called", async () => {
  const opened = await openTestPrisma();
  const db = { prisma: opened.prisma } as SqliteAgentDatabase;
  try {
    // `storeKey` comes off an IPC string. On a plain object literal these two
    // resolve to `Object` / `Object.prototype` — truthy, so a bare `registry[key]`
    // skips the not-found guard and calls one of them as a handler. Both the
    // module's own prototype-less table and the injected registry must refuse.
    for (const inherited of ["constructor", "__proto__", "toString"]) {
      await assert.rejects(
        async () => {
          await dispatchDbHostStoreOp(
            {},
            db,
            `${DB_HOST_STORE_OP_PREFIX}${inherited}`,
            []
          );
        },
        { message: `db-host store op not found: store:${inherited}` },
        `store:${inherited} must not resolve to an inherited member`
      );
    }
  } finally {
    await opened.close();
  }
});
