/**
 * @file pack-store-reader-pool.test.ts
 * @description ISS-6753 — the four Packs/Skills page reads
 * (`listPacks`/`listSkills`/`listSkillInvocations`/`listPackSessions`) dispatch
 * through the READER POOL, never through the writer-bound `prisma.client`.
 *
 * The rows these functions return are unchanged by the routing —
 * `pack-store-conversion.test.ts` already pins every one of them — so this suite
 * pins the SEAM instead, the same shape as ISS-5938's
 * `local-insights-reader-pool.test.ts` and ISS-6199's
 * `session-read-stores-reader-pool.test.ts`.
 *
 * Why it needs a suite of its own: a regression back onto `prisma.client`
 * changes no row and fails only under a busy writer. The rationale for the
 * routing itself lives once, on `PackReaderPrisma` in
 * `src/main/packs/pack-store.ts`.
 *
 * `listPackSessions` is pinned to the pool WHOLE, including the
 * `collectPackPaths` reads it builds its LIKE clauses from — splitting it would
 * put half the read back on the writer.
 */
import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  listPackSessions,
  listPacks,
  listSkillInvocations,
  listSkills,
  upsertPack,
  upsertSkill,
} from "../src/main/packs/pack-store.js";
import { openTestPrisma, type RawDb } from "./prisma-test-utils.js";

const PACK_ID = "alpha";
const HARNESS = "claude";
const INSTALL_PATH = "/packs/alpha";
const SKILL_NAME = "alpha-skill";
const SESSION_ID = "pack-pool-session";

/**
 * What one pack read did with the connection topology.
 *
 * `poolDispatches` counts `read()` calls; `writerMembers` records every member
 * of the writer facade the read reached, so "none of it stayed on the writer" is
 * asserted positively rather than merely tolerated.
 */
type DispatchLog = {
  poolDispatches: number;
  writerMembers: string[];
};

/**
 * `prisma` with the writer facade recorded and `read()` counted.
 *
 * The writer facade forwards every access it records, so a regressed read still
 * produces its rows and the suite fails on the ROUTING rather than on a
 * downstream mapping error that would misattribute the cause. `write` throws:
 * these are read paths, and a write would both land on the writer connection and
 * serialize behind the write queue — strictly worse than the regression this
 * suite exists to prevent.
 */
function withInstrumentedPrisma(
  prisma: DesktopPrisma,
  log: DispatchLog
): DesktopPrisma {
  const writerFacade = new Proxy(prisma.client, {
    get(target, property) {
      if (typeof property === "string") {
        // Symbol keys are forwarded unrecorded — a `Symbol.toStringTag`/`then`
        // probe is not a read and must not pollute the assertion.
        log.writerMembers.push(property);
      }
      return Reflect.get(target, property);
    },
  });
  return {
    ...prisma,
    client: writerFacade,
    write: () => {
      throw new Error(
        "ISS-6753: a pack page read reached prisma.write; route it through prisma.read"
      );
    },
    read: (fn) => {
      log.poolDispatches += 1;
      return prisma.read(fn);
    },
  };
}

/**
 * ISS-9279: seeded RELATIVE TO NOW, never at a fixed calendar date — the same
 * rule, and the same reason, as the sibling `pack-store-conversion.test.ts`.
 * The `listPackSessions` case below floors its scan at a rolling
 * DEFAULT_SESSION_RETENTION_DAYS window on the REAL clock
 * (`eventLookbackCutoff`, which has no injectable `now`), so a hardcoded stamp
 * silently ages out of it and empties the row set — which is what the
 * non-vacuity assertion in that case exists to catch. The stamps here were
 * `2026-06-18`, which would have gone red on 2026-09-16.
 *
 * An hour back, not a day, so no fixture can land on the wrong side of the
 * cutoff because of how long the suite took to reach the assertion.
 */
const RECENT_ISO = new Date(Date.now() - 60 * 60_000).toISOString();

async function seedSession(db: RawDb): Promise<void> {
  await db.query(
    `INSERT INTO sessions (id, name, status, cwd, harness, started_at)
     VALUES ($1, 'Pack Pool Session', 'running', '/work', $2, $3)`,
    [SESSION_ID, HARNESS, RECENT_ISO]
  );
}

async function seedEvent(
  db: RawDb,
  id: string,
  eventType: string,
  data: string
): Promise<void> {
  await db.query(
    `INSERT INTO events (id, session_id, event_type, data, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, SESSION_ID, eventType, data, RECENT_ISO]
  );
}

const log: DispatchLog = { poolDispatches: 0, writerMembers: [] };
let closeFixture: (() => Promise<void>) | null = null;
let instrumented: DesktopPrisma | null = null;

beforeAll(async () => {
  const { db, prisma, close } = await openTestPrisma();
  closeFixture = close;
  // Seeded through the REAL prisma: the upserts are writes, which the
  // instrumented facade below refuses by design.
  await upsertPack(prisma, {
    pack_id: PACK_ID,
    harness: HARNESS,
    install_path: INSTALL_PATH,
    install_kind: "plugin",
  });
  await upsertSkill(prisma, {
    skill_id: "alpha-skill-id",
    pack_id: PACK_ID,
    harness: HARNESS,
    install_path: INSTALL_PATH,
    name: SKILL_NAME,
  });
  await seedSession(db);
  // A slash-command invocation (drives listSkills/listSkillInvocations) and a
  // tool call naming the pack's install path (drives listPackSessions), so every
  // case reads real rows instead of exercising only its empty guard.
  await seedEvent(
    db,
    "pack-pool-prompt",
    "UserPromptSubmit",
    JSON.stringify({ prompt: `/${SKILL_NAME} go` })
  );
  await seedEvent(
    db,
    "pack-pool-tool",
    "PreToolUse",
    JSON.stringify({ cmd: `ls ${INSTALL_PATH}` })
  );
  instrumented = withInstrumentedPrisma(prisma, log);
});

afterAll(async () => {
  await closeFixture?.();
});

/**
 * One read under test: how to drive it, and how to prove it actually returned
 * the seeded rows. There is deliberately no expected `read()` COUNT — a literal
 * would restate the routing as a snapshot that goes stale the moment a read
 * gains or loses a query, while "at least one dispatch, and nothing on the
 * writer" is the property ISS-6753 is about.
 */
const READ_CASES: readonly {
  label: string;
  run: (prisma: DesktopPrisma) => Promise<unknown[]>;
}[] = [
  { label: "listPacks", run: (prisma) => listPacks(prisma) },
  { label: "listSkills", run: (prisma) => listSkills(prisma) },
  {
    label: "listSkillInvocations",
    run: (prisma) => listSkillInvocations(prisma, SKILL_NAME),
  },
  {
    label: "listPackSessions",
    run: (prisma) => listPackSessions(prisma, PACK_ID),
  },
];

for (const readCase of READ_CASES) {
  test(`ISS-6753: ${readCase.label} reads on the reader pool, not the writer`, async () => {
    assert.ok(instrumented, "fixture opened");
    log.poolDispatches = 0;
    log.writerMembers.length = 0;

    const rows = await readCase.run(instrumented);

    // Non-vacuity: an empty result would satisfy the routing assertions without
    // the scan ever having run.
    assert.ok(rows.length > 0, `${readCase.label}: returned the seeded rows`);
    assert.deepEqual(
      [...new Set(log.writerMembers)].sort(),
      [],
      `${readCase.label}: no part of the read stayed on the writer client`
    );
    assert.ok(
      log.poolDispatches > 0,
      `${readCase.label}: dispatched through prisma.read`
    );
  });
}
