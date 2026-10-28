/**
 * @file component-pack-link-keyset-cursor.test.ts
 * @description ISS-6905 regression coverage: a `pack_id` mutation must RE-ENTER the
 * component-sync keyset lane.
 *
 * `pack_id` is on the component sync wire (`component-sync-source.ts` maps it to
 * `SyncedComponent.packId`), and the lane pages by `(COALESCE(last_seen_at,''), id)`.
 * `backfillChildPackIds` and `clearTombstonedPackLinks` wrote the column without
 * advancing that ordering key, so once the persisted cursor had paged past a row the
 * new link — or the release of a removed pack's link — never reached the cloud, and
 * org inventory went on attributing the child to the wrong pack indefinitely.
 *
 * Every case here drives the REAL cursor query from a position the fixture has
 * deliberately advanced PAST the row, and asserts that drained precondition first. A
 * fixture whose cursor still sits behind the row passes with or without the fix and
 * proves nothing, so the precondition failing loudly is what keeps these honest.
 *
 * THREE cases are RE-SYNC VOLUME measurements ISS-6905 asks for rather than
 * correctness cases: a scan that changes nothing must write nothing and re-enter
 * nothing, which is what makes advancing the key on an ordinary-scan path affordable.
 * They measure three different populations and only the set is the claim — one pack;
 * two packs whose roots OVERLAP; and one pack ID holding both an ACTIVE and a
 * tombstoned install. Each is a way for a scan to settle a row by WRITING it twice:
 * the link ends where it started, so it looks stable, while the row re-enters the lane
 * on every scan forever. None of them fails when the ordering-key advance is removed,
 * because none measures the fix; they measure what it costs.
 *
 * The remaining two cases police the claim's own snapshot discipline: the candidate
 * read runs outside the write task, so the UPDATE must re-assert the `install_path`
 * the owner was resolved from, and the read is keyset-paged so a large local inventory
 * cannot be hydrated in one statement.
 */

import assert from "node:assert/strict";
import {
  AgentComponentKind,
  Harness,
  PLUGIN_CHILD_KINDS,
} from "@repo/api/src/types/agent-component";
import { test } from "vitest";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { projectPacksToComponents } from "../src/main/packs/component-scanner.js";
import { PACK_LINK_READ_PAGE } from "../src/main/packs/pack-link-ownership.js";
import { idsFromCursor, readRow } from "./component-sync-lane-fixture.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const PACK_ID = "closedloop-ai";
const OTHER_PACK_ID = "some-other-pack";
/** Synthetic relative paths — the claim heuristic only compares the string. */
const PACK_PATH = "plugins/cache/closedloop-ai";

/**
 * The instant every fixture row starts at, and the cursor position each case drains
 * to. Written out here rather than derived from the code under test: an expectation
 * read back from the helper it polices cannot fail when that helper is wrong.
 */
const SCAN_ONE = "2026-01-01T00:00:00.000Z";

type OpenedPrisma = Awaited<ReturnType<typeof openTestPrisma>>;

/**
 * A seeded child row. Unlike the `plugin-child-kind-parity.test.ts` seeder, this one
 * carries an EXPLICIT `last_seen_at` and an explicit id, because the ordering key and
 * the row's position relative to the cursor are the axis under test here.
 */
type SeedChild = {
  id: string;
  kind: string;
  key: string;
  installPath: string;
  packId?: string | null;
};

async function seedPack(
  opened: OpenedPrisma,
  pack: {
    packId: string;
    installPath: string;
    uninstalledAt?: string | null;
    /** `agent_packs` is keyed `(pack_id, harness, install_path)`, so one id can
     * hold several installs — which is the whole point of the gstack case. */
    harness?: string;
  }
): Promise<void> {
  await opened.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_packs
         (pack_id, harness, install_path, install_kind, source_url, version,
          detected_at, last_seen_at, uninstalled_at)
       VALUES ($1, $2, $3, NULL, NULL, NULL, $4, $4, $5)`,
      pack.packId,
      pack.harness ?? Harness.Claude,
      pack.installPath,
      SCAN_ONE,
      pack.uninstalledAt ?? null
    )
  );
}

async function seedChildren(
  opened: OpenedPrisma,
  children: readonly SeedChild[]
): Promise<void> {
  for (const child of children) {
    await opened.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name,
            install_path, pack_id, first_seen_at, last_seen_at, uninstalled_at)
         VALUES ($1, $2, $3, $3, $3, $4, $5, $6, $6, NULL)`,
        child.id,
        child.kind,
        child.key,
        child.installPath,
        child.packId ?? null,
        SCAN_ONE
      )
    );
  }
}

/**
 * Where a fully-drained lane's cursor sits: the `(last_seen_at, id)` pair of the last
 * row in keyset order. `AgentComponentSyncLane` advances onto the last row of each
 * batch, so this is the real post-drain position, not an approximation of one.
 */
async function drainedCursor(
  prisma: DesktopPrisma
): Promise<{ ts: string; id: string }> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<{ ts: string; id: string }[]>(
      `SELECT COALESCE(last_seen_at, '') AS "ts", id
         FROM agent_components
        ORDER BY COALESCE(last_seen_at, '') DESC, id DESC
        LIMIT 1`
    )
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("drainedCursor: no agent_components rows to drain past");
  }
  return row;
}

/** Read one component's `pack_id` by external id. */
async function readPackId(
  prisma: DesktopPrisma,
  externalId: string
): Promise<string | null> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<{ packId: string | null }[]>(
      `SELECT pack_id AS "packId" FROM agent_components WHERE external_id = $1`,
      externalId
    )
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error(
      `expected exactly one agent_components row for ${externalId}, got ${rows.length}`
    );
  }
  return row.packId;
}

/**
 * A `DesktopPrisma` façade that runs `onCandidateRows` immediately after the claim
 * pass's candidate-row read resolves, and before anything is written from it — the
 * exact window in which a concurrent `upsertDefinition` can move a child's
 * `install_path` out from under a resolution that has already been made.
 *
 * The candidate read is identified by its row SHAPE (`id`/`installPath`/`packId`, the
 * only read in the scan that projects exactly those three). `interleaves` is returned
 * so the caller can assert the hook actually fired: a shape probe that silently stops
 * matching would otherwise leave the test passing while exercising nothing.
 */
function withCandidateReadInterleave(
  prisma: DesktopPrisma,
  onCandidateRows: () => Promise<void>
): { db: DesktopPrisma; interleaves: () => number } {
  let interleaves = 0;
  const isCandidateRow = (row: unknown): boolean =>
    typeof row === "object" &&
    row !== null &&
    "id" in row &&
    "installPath" in row &&
    "packId" in row;
  const db: DesktopPrisma = {
    client: prisma.client,
    write: (fn, token, opts) => prisma.write(fn, token, opts),
    readWalProbeHealth: () => prisma.readWalProbeHealth(),
    readStorageExhaustionHealth: () => prisma.readStorageExhaustionHealth(),
    shrinkMemory: () => prisma.shrinkMemory(),
    disconnect: () => prisma.disconnect(),
    read: async (fn) => {
      const result = await prisma.read(fn);
      if (
        Array.isArray(result) &&
        result.length > 0 &&
        isCandidateRow(result[0])
      ) {
        interleaves += 1;
        await onCandidateRows();
      }
      return result;
    },
  };
  return { db, interleaves: () => interleaves };
}

test("a pack_id backfill behind the sync cursor re-enters the keyset lane", async () => {
  const opened = await openTestPrisma();
  try {
    await seedPack(opened, { packId: PACK_ID, installPath: PACK_PATH });
    await seedChildren(opened, [
      {
        id: "child-skill-id",
        kind: AgentComponentKind.Skill,
        key: "linked-child",
        installPath: `${PACK_PATH}/skills/linked-child`,
      },
    ]);

    const before = await readRow(opened.prisma, "linked-child");
    assert.equal(before.lastSeenAt, SCAN_ONE);
    assert.equal(await readPackId(opened.prisma, "linked-child"), null);

    // The adversarial precondition: the lane has already paged past this row.
    // Without it the row is selected regardless of what the backfill writes.
    assert.deepEqual(
      await idsFromCursor(opened.prisma, SCAN_ONE, before.id),
      [],
      "fixture must place the cursor PAST the child before its pack_id changes"
    );

    await projectPacksToComponents(opened.prisma);

    assert.equal(
      await readPackId(opened.prisma, "linked-child"),
      PACK_ID,
      "the backfill must still stamp the link it always stamped"
    );
    const after = await readRow(opened.prisma, "linked-child");
    assert.ok(
      after.lastSeenAt !== null && after.lastSeenAt > SCAN_ONE,
      `the backfill must advance the lane's ordering key strictly past the row's previous key; got ${after.lastSeenAt}`
    );
    assert.ok(
      (await idsFromCursor(opened.prisma, SCAN_ONE, before.id)).includes(
        before.id
      ),
      "the new pack_id must be emitted incrementally from the drained cursor"
    );
  } finally {
    await opened.close();
  }
});

test("releasing a tombstoned pack's link behind the sync cursor re-enters the keyset lane", async () => {
  const opened = await openTestPrisma();
  try {
    // The only state in which a stale pack_id is reachable: an earlier ACTIVE scan
    // stamped the link, and the pack has since been uninstalled.
    await seedPack(opened, {
      packId: PACK_ID,
      installPath: PACK_PATH,
      uninstalledAt: SCAN_ONE,
    });
    await seedChildren(opened, [
      {
        id: "child-subagent-id",
        kind: AgentComponentKind.Subagent,
        key: "orphaned-child",
        installPath: `${PACK_PATH}/agents/orphaned-child`,
        packId: PACK_ID,
      },
    ]);

    const before = await readRow(opened.prisma, "orphaned-child");
    assert.equal(before.lastSeenAt, SCAN_ONE);
    assert.equal(await readPackId(opened.prisma, "orphaned-child"), PACK_ID);
    assert.deepEqual(
      await idsFromCursor(opened.prisma, SCAN_ONE, before.id),
      [],
      "fixture must place the cursor PAST the child before its link is released"
    );

    await projectPacksToComponents(opened.prisma);

    assert.equal(
      await readPackId(opened.prisma, "orphaned-child"),
      null,
      "the unlink must still release the removed pack's claim"
    );
    const after = await readRow(opened.prisma, "orphaned-child");
    assert.ok(
      after.lastSeenAt !== null && after.lastSeenAt > SCAN_ONE,
      `the unlink must advance the lane's ordering key strictly past the row's previous key; got ${after.lastSeenAt}`
    );
    assert.ok(
      (await idsFromCursor(opened.prisma, SCAN_ONE, before.id)).includes(
        before.id
      ),
      "the released pack_id must be emitted incrementally from the drained cursor"
    );
  } finally {
    await opened.close();
  }
});

test("overlapping pack roots add ZERO re-sync volume on an unchanged rescan", async () => {
  const opened = await openTestPrisma();
  try {
    // The population the single-pack measurement below cannot reach: TWO active
    // packs whose roots overlap, so both prefix-match the same child. The file's
    // own docs call this out as real (a pack keyed on a whole skills root is an
    // ancestor of every pack beneath it), and the deepest root is the owner.
    //
    // A per-pack claim loop settles this by WRITING it: the shallow pack sees the
    // deep pack's id and re-claims, the deep pack sees the shallow pack's id and
    // takes it back. The row ends every scan on the value it started with, so the
    // link is correct — but it was written twice, and once a write advances the
    // ordering key those two writes become two lane re-entries on EVERY scan,
    // forever, for a row nothing about which changed.
    await seedPack(opened, { packId: "outer", installPath: PACK_PATH });
    await seedPack(opened, {
      packId: "inner",
      installPath: `${PACK_PATH}/nested`,
    });
    await seedChildren(opened, [
      {
        id: "child-shared-id",
        kind: AgentComponentKind.Skill,
        key: "shared-child",
        installPath: `${PACK_PATH}/nested/skills/shared-child`,
      },
    ]);

    await projectPacksToComponents(opened.prisma);
    assert.equal(
      await readPackId(opened.prisma, "shared-child"),
      "inner",
      "the deepest matching pack owns the child"
    );

    const cursor = await drainedCursor(opened.prisma);
    assert.deepEqual(
      await idsFromCursor(opened.prisma, cursor.ts, cursor.id),
      [],
      "the lane must be fully drained before the volume of a rescan is measured"
    );

    const second = await projectPacksToComponents(opened.prisma);

    assert.equal(
      second.packIdBackfills,
      0,
      "an unchanged rescan must not rewrite a child that two packs both match"
    );
    assert.equal(
      await readPackId(opened.prisma, "shared-child"),
      "inner",
      "the settled owner must not change across scans"
    );
    assert.deepEqual(
      await idsFromCursor(opened.prisma, cursor.ts, cursor.id),
      [],
      "an overlapping-root child must not re-enter the sync lane on every scan"
    );
  } finally {
    await opened.close();
  }
});

test("a claim spanning several write chunks links and re-enters EVERY row", async () => {
  const opened = await openTestPrisma();
  try {
    // The chunked write reserves a FRESH ordering key per chunk and numbers its id
    // placeholders past two leading bind params. Both are invisible at the default
    // chunk width, because no realistic fixture seeds 200 children — so the width is
    // narrowed here instead. A dropped chunk or a mis-numbered placeholder shows up
    // as a row that never got its link, or never re-entered the lane.
    await seedPack(opened, { packId: PACK_ID, installPath: PACK_PATH });
    // Five children at width two: three chunks, the last one partial.
    const childIds = ["c1", "c2", "c3", "c4", "c5"].map((n) => `chunk-${n}-id`);
    await seedChildren(
      opened,
      childIds.map((id, index) => ({
        id,
        kind: AgentComponentKind.Skill,
        key: `chunk-child-${index}`,
        installPath: `${PACK_PATH}/skills/chunk-child-${index}`,
      }))
    );

    const cursor = await drainedCursor(opened.prisma);
    assert.deepEqual(
      await idsFromCursor(opened.prisma, cursor.ts, cursor.id),
      [],
      "fixture must place the cursor PAST every child before they are claimed"
    );

    const summary = await projectPacksToComponents(opened.prisma, 2);

    assert.equal(
      summary.packIdBackfills,
      childIds.length,
      "every child across every chunk must be claimed, not just the first chunk"
    );
    const reEntered = await idsFromCursor(opened.prisma, cursor.ts, cursor.id);
    for (const id of childIds) {
      assert.ok(
        reEntered.includes(id),
        `child ${id} must re-enter the sync lane; a chunk whose ordering key or placeholder offset is wrong silently leaves it behind`
      );
    }
    for (const index of childIds.keys()) {
      assert.equal(
        await readPackId(opened.prisma, `chunk-child-${index}`),
        PACK_ID,
        "every chunked row must carry the resolved owner"
      );
    }
  } finally {
    await opened.close();
  }
});

test("an unchanged rescan adds ZERO re-sync volume — the ISS-6905 cost measurement", async () => {
  const opened = await openTestPrisma();
  try {
    // One child of every kind the backfill stamps, plus one already correctly
    // linked and one claimed by a DIFFERENT pack the scan must re-claim — so the
    // measurement covers the settle pass, not just a table of untouched rows.
    await seedPack(opened, { packId: PACK_ID, installPath: PACK_PATH });
    await seedChildren(opened, [
      ...PLUGIN_CHILD_KINDS.map((kind) => ({
        id: `child-${kind}-id`,
        kind,
        key: `${kind}-child`,
        installPath: `${PACK_PATH}/${kind}s/${kind}-child`,
      })),
      {
        id: "child-preclaimed-id",
        kind: AgentComponentKind.Skill,
        key: "preclaimed-child",
        installPath: `${PACK_PATH}/skills/preclaimed-child`,
        packId: OTHER_PACK_ID,
      },
    ]);

    const first = await projectPacksToComponents(opened.prisma);
    // Independently written: every seeded child plus the mis-claimed one. Derived
    // from the seed list above, never read back from the scanner's own summary.
    assert.equal(
      first.packIdBackfills,
      PLUGIN_CHILD_KINDS.length + 1,
      "the first scan must stamp every child whose pack_id changes"
    );

    // Drain the lane completely: every row the first scan wrote has now reached the
    // cloud, which is the steady state an ordinary rescan runs in.
    const cursor = await drainedCursor(opened.prisma);
    assert.deepEqual(
      await idsFromCursor(opened.prisma, cursor.ts, cursor.id),
      [],
      "the lane must be fully drained before the volume of a rescan is measured"
    );

    const second = await projectPacksToComponents(opened.prisma);

    // THE MEASUREMENT. Both writers are scoped to rows whose pack_id actually
    // changes, so an unchanged rescan writes nothing — the ordering-key advance
    // costs one lane entry per genuine link change, never one per scan. If either
    // predicate ever stopped being change-scoped, the key advance would re-enter
    // every child on every scan and this is where that shows up.
    assert.equal(
      second.packIdBackfills,
      0,
      "an unchanged rescan must not rewrite a single pack_id"
    );
    assert.equal(
      second.packIdUnlinks,
      0,
      "an unchanged rescan must not release a single pack_id"
    );
    assert.deepEqual(
      await idsFromCursor(opened.prisma, cursor.ts, cursor.id),
      [],
      "an unchanged rescan must put NOTHING back into the component sync lane"
    );
  } finally {
    await opened.close();
  }
});

test("an id with one ACTIVE and one tombstoned install adds ZERO re-sync volume", async () => {
  const opened = await openTestPrisma();
  try {
    // ISS-6905 review (davetho). `agent_packs` is keyed
    // `(pack_id, harness, install_path)`, so one logical id holds several installs —
    // `scanGStack` registers `gstack` under BOTH claude and codex. Treating each
    // tombstoned ROW as a tombstone for the ID released the children the ACTIVE
    // install still owns, and the claim pass took them straight back. The link ends
    // every scan on the value it started with, so it looks stable; with the ordering
    // key advancing it is two lane re-entries per child per scan, forever.
    await seedPack(opened, {
      packId: "gstack",
      harness: Harness.Claude,
      installPath: PACK_PATH,
    });
    await seedPack(opened, {
      packId: "gstack",
      harness: Harness.Codex,
      installPath: `${PACK_PATH}-codex`,
      uninstalledAt: SCAN_ONE,
    });
    await seedChildren(opened, [
      {
        id: "gstack-child-id",
        kind: AgentComponentKind.Skill,
        key: "gstack-child",
        installPath: `${PACK_PATH}/skills/gstack-child`,
      },
    ]);

    const first = await projectPacksToComponents(opened.prisma);
    assert.equal(
      first.packIdBackfills,
      1,
      "the active install must still claim its child"
    );
    assert.equal(
      await readPackId(opened.prisma, "gstack-child"),
      "gstack",
      "the active install owns the child"
    );

    const cursor = await drainedCursor(opened.prisma);
    assert.deepEqual(
      await idsFromCursor(opened.prisma, cursor.ts, cursor.id),
      [],
      "the lane must be fully drained before the volume of a rescan is measured"
    );

    const second = await projectPacksToComponents(opened.prisma);

    // THE MEASUREMENT, cursor volume first: the release pass must not touch an id
    // that still has a live install, so the rescan neither unlinks nor re-claims and
    // the row never re-enters the lane. The counts below name WHICH half broke.
    assert.deepEqual(
      await idsFromCursor(opened.prisma, cursor.ts, cursor.id),
      [],
      "an active+tombstoned same-id rescan must put NOTHING back into the sync lane"
    );
    assert.equal(
      second.packIdUnlinks,
      0,
      "a tombstoned install must not release the children of its still-active sibling"
    );
    assert.equal(
      second.packIdBackfills,
      0,
      "nothing was released, so nothing needs re-claiming"
    );
    assert.equal(
      await readPackId(opened.prisma, "gstack-child"),
      "gstack",
      "the settled owner must not change across scans"
    );
  } finally {
    await opened.close();
  }
});

test("a child whose install_path MOVES after the candidate read is not stamped", async () => {
  const opened = await openTestPrisma();
  try {
    // ISS-6905 review (davetho + whitlockk, independently, on the same line). The
    // candidate read runs on a reader connection outside the write task, so the
    // owner it resolves is a claim about a snapshot. `upsertDefinition` re-inserts a
    // child under the SAME deterministic id and sets `install_path =
    // excluded.install_path` on conflict, so a row can move between that read and
    // this write. A predicate that re-checked only `pack_id != $1` then stamped the
    // moved row with the pack that owned it where it USED to live — and advanced its
    // sync ordering key, shipping the wrong owner to the cloud. Nothing walks it
    // back: the next scan resolves no owner for a row outside every root and skips
    // it, so the wrong link would be permanent.
    await seedPack(opened, { packId: PACK_ID, installPath: PACK_PATH });
    await seedChildren(opened, [
      {
        id: "moved-child-id",
        kind: AgentComponentKind.Skill,
        key: "moved-child",
        installPath: `${PACK_PATH}/skills/moved-child`,
      },
      {
        id: "settled-child-id",
        kind: AgentComponentKind.Skill,
        key: "settled-child",
        installPath: `${PACK_PATH}/skills/settled-child`,
      },
    ]);

    const { db, interleaves } = withCandidateReadInterleave(
      opened.prisma,
      async () => {
        // Deliberately leaves `last_seen_at` alone, so anything that advances it
        // afterwards can only be the claim under test.
        await opened.prisma.write((client) =>
          client.$executeRawUnsafe(
            "UPDATE agent_components SET install_path = $1 WHERE id = $2",
            "elsewhere/not-under-any-pack/moved-child",
            "moved-child-id"
          )
        );
      }
    );

    const summary = await projectPacksToComponents(db);

    assert.ok(
      interleaves() > 0,
      "the interleave never fired — the candidate-read probe no longer matches, so this case proves nothing"
    );
    assert.equal(
      await readPackId(opened.prisma, "moved-child"),
      null,
      "a child that moved out from under the pack must NOT be stamped from the stale snapshot"
    );
    assert.equal(
      (await readRow(opened.prisma, "moved-child")).lastSeenAt,
      SCAN_ONE,
      "a claim that matched nothing must not advance the moved row's ordering key either"
    );
    assert.equal(
      await readPackId(opened.prisma, "settled-child"),
      PACK_ID,
      "a sibling that did NOT move must still be claimed — revalidating the path must not cost the whole chunk"
    );
    assert.equal(
      summary.packIdBackfills,
      1,
      "exactly the one still-matching row is counted"
    );
  } finally {
    await opened.close();
  }
});

test("a candidate population spanning several READ pages claims EVERY row", async () => {
  const opened = await openTestPrisma();
  try {
    // ISS-6905 review (davetho): the candidate read is keyset-paged so its heap
    // does not scale with the local inventory. A page-boundary off-by-one leaves the
    // tail unclaimed (or re-reads the last row forever), and neither is visible at
    // any fixture size below the real page width — so this seeds past it, with one
    // bulk INSERT rather than N round-trips.
    const total = PACK_LINK_READ_PAGE + 7;
    await seedPack(opened, { packId: PACK_ID, installPath: PACK_PATH });
    await opened.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name,
            install_path, pack_id, first_seen_at, last_seen_at, uninstalled_at)
         WITH RECURSIVE n(i) AS (
           SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $3
         )
         SELECT printf('paged-%04d-id', i),
                $4,
                printf('paged-%04d', i),
                printf('paged-%04d', i),
                printf('paged-%04d', i),
                $1 || '/skills/' || printf('paged-%04d', i),
                NULL,
                $2,
                $2,
                NULL
           FROM n`,
        PACK_PATH,
        SCAN_ONE,
        total,
        AgentComponentKind.Skill
      )
    );

    const cursor = await drainedCursor(opened.prisma);
    assert.deepEqual(
      await idsFromCursor(opened.prisma, cursor.ts, cursor.id),
      [],
      "fixture must place the cursor PAST every child before they are claimed"
    );

    const summary = await projectPacksToComponents(opened.prisma);

    assert.equal(
      summary.packIdBackfills,
      total,
      "every row past the read-page boundary must be claimed, not just the first page"
    );
    const unclaimed = await opened.prisma.read((reader) =>
      reader.$queryRawUnsafe<{ n: number }[]>(
        `SELECT COUNT(*) AS "n" FROM agent_components
          WHERE external_id LIKE 'paged-%' AND pack_id IS NOT $1`,
        PACK_ID
      )
    );
    assert.equal(
      unclaimed[0]?.n,
      0,
      "no row may be left behind by the keyset page boundary"
    );

    const second = await projectPacksToComponents(opened.prisma);
    assert.equal(
      second.packIdBackfills,
      0,
      "a paged rescan that changes nothing must still write nothing"
    );
  } finally {
    await opened.close();
  }
});
