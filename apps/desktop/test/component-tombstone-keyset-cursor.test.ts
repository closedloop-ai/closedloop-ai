/**
 * @file component-tombstone-keyset-cursor.test.ts
 * @description ISS-6881 regression coverage: an `agent_components` uninstall
 * tombstone must RE-ENTER the component-sync keyset lane.
 *
 * The lane is `listAgentComponentCursorRows`, which pages by
 * `(COALESCE(last_seen_at,''), id)` and whose position the desktop persists. The
 * MCP and pack-projected plugin writers used to stamp only `uninstalled_at`, so a
 * tombstone landed at whatever ordering key the row already had; once the cursor
 * had paged past that key the uninstall was never selected again and cloud
 * inventory/search kept presenting a removed component as installed.
 *
 * Stamping the scan instant is not enough either, because the cursor is a COMPOSITE
 * `(timestamp, id)` key. One scan stamps one `now` across every row it writes, and
 * the sync lane runs concurrently, so it can acknowledge a sibling row at
 * `(now, idB)` before the tombstone lands at `(now, idA)`. When `idA <= idB` the
 * tombstone is behind the live cursor and the `uninstalled_at IS NULL` guards stop
 * any later scan repairing it. That interleaving is the last test below, driven
 * through a lane simulator rather than a timer.
 *
 * Every assertion here drives the REAL cursor query from a position the fixture has
 * deliberately advanced PAST the row, because the cursor position IS the test: a
 * fixture whose cursor sits behind the row passes with or without the fix. Each
 * case first asserts the drained-cursor precondition, so a fixture that stopped
 * being adversarial fails loudly instead of going quiet.
 *
 * ISS-6906 retired the KNOWN LIMITATION case that used to sit here. It asserted that
 * a tombstone written by the PRE-ISS-6881 collector stays stranded forever, which was
 * true of that change and is deliberately no longer true: `repairStrandedComponentTombstones`
 * re-enters exactly that population into the lane. The case is kept, not deleted —
 * the half of it that still holds (a SCAN cannot repair such a row, because every
 * tombstone writer is guarded by `uninstalled_at IS NULL`) is what proves the repair
 * comes from the new pass rather than from the collector quietly widening its guard.
 * The repair's own contract — the excluded already-delivered population, idempotence,
 * the scan-instant key — is covered in `component-tombstone-repair.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { test } from "vitest";
import { buildAgentComponentSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { projectPacksToComponents } from "../src/main/packs/component-scanner.js";
import { nextComponentOrderingKey } from "../src/main/packs/component-tombstone.js";
import { repairStrandedComponentTombstones } from "../src/main/packs/component-tombstone-repair.js";
import { ComponentScope } from "../src/main/packs/definition-content-collector.js";
import { discoverMcpServers } from "../src/main/packs/mcp-discovery.js";
import {
  createSyncLaneSimulator,
  idsFromCursor,
  readRow,
} from "./component-sync-lane-fixture.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const SCAN_ONE = "2026-01-01T00:00:00.000Z";
const SCAN_TWO = "2026-01-02T00:00:00.000Z";
const SCAN_THREE = "2026-01-03T00:00:00.000Z";

function writeClaudeMcpConfig(
  configPath: string,
  servers: Record<string, unknown>
): void {
  writeFileSync(configPath, JSON.stringify({ mcpServers: servers }), "utf8");
}

test("MCP tombstone behind the sync cursor still re-enters the keyset lane", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "iss6881-mcp-"));
  const configPath = path.join(dir, "claude.json");
  const { prisma, close } = await openTestPrisma();
  try {
    writeClaudeMcpConfig(configPath, { weather: { command: "weather-mcp" } });
    await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      SCAN_ONE
    );

    const installed = await readRow(prisma, "weather");
    assert.equal(installed.lastSeenAt, SCAN_ONE);
    assert.equal(installed.uninstalledAt, null);

    // Drain the lane past this exact row — the adversarial precondition. Without
    // it the row is selected regardless of the tombstone write shape and the
    // assertions below prove nothing.
    assert.deepEqual(
      await idsFromCursor(prisma, SCAN_ONE, installed.id),
      [],
      "fixture must place the cursor PAST the row before it is tombstoned"
    );

    writeClaudeMcpConfig(configPath, {});
    const removal = await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      SCAN_TWO
    );
    assert.equal(removal.tombstoned, 1);

    const tombstoned = await readRow(prisma, "weather");
    assert.equal(tombstoned.uninstalledAt, SCAN_TWO);
    assert.ok(
      tombstoned.lastSeenAt !== null && tombstoned.lastSeenAt > SCAN_TWO,
      `the tombstone must advance the lane's ordering key STRICTLY past the scan instant, not only uninstalled_at; got ${tombstoned.lastSeenAt}`
    );
    assert.ok(
      (await idsFromCursor(prisma, SCAN_ONE, installed.id)).includes(
        installed.id
      ),
      "the uninstall must be emitted incrementally from the drained cursor"
    );

    // Already ahead of the cursor: a further scan with the server still absent
    // must neither re-tombstone nor re-order the row, so the cloud is not sent a
    // duplicate uninstall on every tick.
    const repeat = await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      SCAN_THREE
    );
    assert.equal(repeat.tombstoned, 0);
    const settled = await readRow(prisma, "weather");
    assert.equal(settled.lastSeenAt, tombstoned.lastSeenAt);
    assert.equal(settled.uninstalledAt, SCAN_TWO);
    assert.deepEqual(
      await idsFromCursor(prisma, tombstoned.lastSeenAt ?? "", installed.id),
      [],
      "an already-delivered tombstone must not be emitted twice"
    );
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP tombstone on a legacy NULL last_seen_at row writes a real ordering key", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "iss6881-mcp-null-"));
  const configPath = path.join(dir, "claude.json");
  const { prisma, close } = await openTestPrisma();
  try {
    // A row predating the ordering-key column: `last_seen_at` is NULL, which the
    // cursor normalizes to '' and therefore sorts before EVERY live row. Such a
    // tombstone is permanently behind any non-empty cursor.
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name, resolved_state,
            first_seen_at, last_seen_at, uninstalled_at)
         VALUES ($1, $2, 'legacy-server', 'legacy-server', 'legacy-server',
                 'unresolved', $3, NULL, NULL)`,
        "legacy-mcp-id",
        AgentComponentKind.Mcp,
        SCAN_ONE
      )
    );

    const before = await readRow(prisma, "legacy-server");
    assert.equal(
      before.lastSeenAt,
      null,
      "fixture must start with an ABSENT ordering key, not a stamped one"
    );
    assert.deepEqual(
      await idsFromCursor(prisma, SCAN_ONE, ""),
      [],
      "a NULL-keyed row is invisible to any advanced cursor"
    );

    writeClaudeMcpConfig(configPath, {});
    const removal = await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      SCAN_TWO
    );
    assert.equal(removal.tombstoned, 1);

    const after = await readRow(prisma, "legacy-server");
    assert.equal(after.uninstalledAt, SCAN_TWO);
    assert.ok(
      after.lastSeenAt !== null && after.lastSeenAt > SCAN_TWO,
      `an absent ordering key must be replaced by a key past the scan instant, not left NULL; got ${after.lastSeenAt}`
    );
    assert.deepEqual(await idsFromCursor(prisma, SCAN_ONE, ""), [
      "legacy-mcp-id",
    ]);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scan still cannot repair a pre-fix tombstone; the ISS-6906 pass does", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "iss6881-stranded-"));
  const configPath = path.join(dir, "claude.json");
  const { prisma, close } = await openTestPrisma();
  try {
    // Exactly what the OLD writer left behind: `uninstalled_at` set, ordering key
    // never advanced. This is not aspirational state — every desktop that removed
    // an MCP server before this build has rows in it.
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name, resolved_state,
            first_seen_at, last_seen_at, uninstalled_at)
         VALUES ($1, $2, 'stranded-server', 'stranded-server', 'stranded-server',
                 'unresolved', $3, $3, $4)`,
        "stranded-mcp-id",
        AgentComponentKind.Mcp,
        SCAN_ONE,
        SCAN_TWO
      )
    );
    assert.deepEqual(
      await idsFromCursor(prisma, SCAN_ONE, "stranded-mcp-id"),
      [],
      "fixture must start behind the cursor"
    );

    writeClaudeMcpConfig(configPath, {});
    const scan = await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      SCAN_THREE
    );

    // The tombstone writers are one-shot (`WHERE uninstalled_at IS NULL`), so a
    // SCAN still cannot repair a row the old writer already tombstoned. That much
    // is unchanged, and asserting it is what keeps the case below honest: the
    // repair is reached by a separate pass, not by the collector quietly widening.
    assert.equal(scan.tombstoned, 0);
    const unchanged = await readRow(prisma, "stranded-server");
    assert.equal(unchanged.lastSeenAt, SCAN_ONE);
    assert.equal(unchanged.uninstalledAt, SCAN_TWO);
    assert.deepEqual(
      await idsFromCursor(prisma, SCAN_ONE, "stranded-mcp-id"),
      [],
      "a scan does not repair a pre-fix tombstone"
    );

    // ISS-6906 CLOSES the limitation this case used to pin. The repair pass — not
    // the collector — re-enters the stranded row into the lane exactly once, and
    // leaves the recorded uninstall instant alone.
    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => undefined),
      1
    );
    const repaired = await readRow(prisma, "stranded-server");
    assert.equal(
      repaired.uninstalledAt,
      SCAN_TWO,
      "the repair moves the row's lane position, never when it was uninstalled"
    );
    assert.ok(
      repaired.lastSeenAt !== null && repaired.lastSeenAt > SCAN_TWO,
      `the repair must key the row past its own uninstall instant, got ${repaired.lastSeenAt}`
    );
    assert.deepEqual(
      await idsFromCursor(prisma, SCAN_ONE, "stranded-mcp-id"),
      ["stranded-mcp-id"],
      "the stranded uninstall must now be emitted from the drained cursor"
    );
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pack-projected plugin tombstone re-enters the keyset lane at the CURRENT scan instant", async () => {
  const { prisma, close } = await openTestPrisma();
  const externalId = "claude|/home/u/.claude/packs/demo|demo-pack";
  try {
    await prisma.write((client) =>
      client.agentPack.create({
        data: {
          packId: "demo-pack",
          harness: "claude",
          installPath: "/home/u/.claude/packs/demo",
          detectedAt: SCAN_ONE,
          lastSeenAt: SCAN_ONE,
          uninstalledAt: null,
        },
      })
    );
    await projectPacksToComponents(prisma);

    const installed = await readRow(prisma, externalId);
    assert.equal(installed.lastSeenAt, SCAN_ONE);
    assert.equal(installed.uninstalledAt, null);
    assert.deepEqual(
      await idsFromCursor(prisma, SCAN_ONE, installed.id),
      [],
      "fixture must place the cursor PAST the row before it is tombstoned"
    );

    // The pack was retired by an EARLIER scan, so its `uninstalled_at` is a
    // historical instant. Re-using it as the ordering key would re-file the
    // tombstone at a position the cursor may already have passed.
    await prisma.write((client) =>
      client.agentPack.update({
        where: {
          packId_harness_installPath: {
            packId: "demo-pack",
            harness: "claude",
            installPath: "/home/u/.claude/packs/demo",
          },
        },
        data: { uninstalledAt: SCAN_TWO },
      })
    );
    const projection = await projectPacksToComponents(prisma);
    assert.equal(projection.tombstoned, 1);

    const tombstoned = await readRow(prisma, externalId);
    assert.equal(
      tombstoned.uninstalledAt,
      SCAN_TWO,
      "the recorded uninstall instant stays the pack's own, not the scan clock"
    );
    assert.ok(
      tombstoned.lastSeenAt !== null && tombstoned.lastSeenAt > SCAN_TWO,
      `ordering key must advance past the historical uninstall instant, got ${tombstoned.lastSeenAt}`
    );
    assert.ok(
      (await idsFromCursor(prisma, SCAN_ONE, installed.id)).includes(
        installed.id
      ),
      "the uninstall must be emitted incrementally from the drained cursor"
    );
    // A cursor already sitting at the historical uninstall instant for this very
    // row still sees it — which a `last_seen_at = uninstalled_at` write would not
    // satisfy.
    assert.ok(
      (await idsFromCursor(prisma, SCAN_TWO, installed.id)).includes(
        installed.id
      ),
      "a cursor at the historical uninstall instant must still receive the tombstone"
    );

    // Idempotent: the projection runs on every scan, and the already-tombstoned
    // row must not churn its ordering key and re-emit forever.
    const rerun = await projectPacksToComponents(prisma);
    assert.equal(rerun.tombstoned, 1, "the projection still visits the pack");
    // Page from the key captured BEFORE the rerun, never from the row's own
    // post-rerun key: seeding the cursor out of the row under test makes both
    // keyset disjuncts false by construction and the assertion unfalsifiable.
    // From this fixed position an unchanged row is excluded, while a writer that
    // re-stamps `last_seen_at` on an already-tombstoned row moves past it. This
    // is the discriminating check, so it runs before the equality below — which
    // only separates the two states when the clock happens to have ticked.
    assert.deepEqual(
      await idsFromCursor(prisma, tombstoned.lastSeenAt ?? "", installed.id),
      [],
      "an already-delivered tombstone must not be re-emitted by a later scan"
    );
    const settled = await readRow(prisma, externalId);
    assert.equal(settled.lastSeenAt, tombstoned.lastSeenAt);
  } finally {
    await close();
  }
});

/**
 * `prisma`, but the sync lane gets to run to completion after EVERY scan write —
 * the worst-case interleaving of two independently scheduled actors, expressed
 * without a timer, a sleep, or a second thread. Each awaited write in the scan loop
 * is a real yield point in production, so this is the schedule, not a caricature.
 */
function withInterleavedSyncLane(
  prisma: DesktopPrisma,
  lane: { drain: () => Promise<void> }
): DesktopPrisma {
  return {
    client: prisma.client,
    read: (fn) => prisma.read(fn),
    write: async (fn, token, opts) => {
      const result = await prisma.write(fn, token, opts);
      await lane.drain();
      return result;
    },
    readWalProbeHealth: () => prisma.readWalProbeHealth(),
    readStorageExhaustionHealth: () => prisma.readStorageExhaustionHealth(),
    shrinkMemory: () => prisma.shrinkMemory(),
    disconnect: () => prisma.disconnect(),
  };
}

const RACE_PACK_HARNESS = "claude";
const RACE_PACK_INSTALL_PATH = "/home/u/.claude/packs/race";
/**
 * Chosen so the pack the projection loop visits FIRST (`orderBy packId asc`) owns the
 * LARGER `agent_components.id`. That is what makes the fixture adversarial: the lane
 * acknowledges the first tombstone at `(now, largerId)`, and a second tombstone
 * stamped with the same `now` then carries a smaller id and loses BOTH keyset
 * disjuncts. The precondition is asserted from the real ids below, so a change to the
 * id derivation fails loudly instead of quietly making this test non-adversarial.
 */
const RACE_PACK_FIRST = "retired-pack-000";
const RACE_PACK_SECOND = "retired-pack-126";

function racePackExternalId(packId: string): string {
  return `${RACE_PACK_HARNESS}|${RACE_PACK_INSTALL_PATH}|${packId}`;
}

async function createRetiredRacePack(
  prisma: DesktopPrisma,
  packId: string
): Promise<void> {
  await prisma.write((client) =>
    client.agentPack.create({
      data: {
        packId,
        harness: RACE_PACK_HARNESS,
        installPath: RACE_PACK_INSTALL_PATH,
        detectedAt: SCAN_ONE,
        lastSeenAt: SCAN_ONE,
        uninstalledAt: null,
      },
    })
  );
}

async function retireRacePack(
  prisma: DesktopPrisma,
  packId: string
): Promise<void> {
  await prisma.write((client) =>
    client.agentPack.update({
      where: {
        packId_harness_installPath: {
          packId,
          harness: RACE_PACK_HARNESS,
          installPath: RACE_PACK_INSTALL_PATH,
        },
      },
      data: { uninstalledAt: SCAN_TWO },
    })
  );
}

test("a tombstone outranks a cursor the lane advanced to a same-instant sibling row", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await createRetiredRacePack(prisma, RACE_PACK_FIRST);
    await createRetiredRacePack(prisma, RACE_PACK_SECOND);
    await projectPacksToComponents(prisma);

    const first = await readRow(prisma, racePackExternalId(RACE_PACK_FIRST));
    const second = await readRow(prisma, racePackExternalId(RACE_PACK_SECOND));
    assert.ok(
      second.id < first.id,
      `fixture must give the FIRST-visited pack the larger component id, else the same-instant tie is not adversarial; got first=${first.id} second=${second.id}`
    );

    const lane = createSyncLaneSimulator(prisma);
    // The lane is fully caught up on the installed state before anything is
    // retired — the cursor is drained, which is the only position from which a
    // stranded tombstone is invisible rather than merely not-yet-read.
    await lane.drain();
    assert.deepEqual(
      lane.uninstallsDelivered,
      [],
      "nothing is uninstalled yet, so the lane must have delivered no uninstalls"
    );

    await retireRacePack(prisma, RACE_PACK_FIRST);
    await retireRacePack(prisma, RACE_PACK_SECOND);

    // ONE scan, so both tombstones share one `now`. The lane runs to completion
    // between them, acknowledging the first at `(now, first.id)`. Stamping `now`
    // on the second then files it at `(now, second.id)` with `second.id <
    // first.id` — behind the live cursor, and unreachable forever because every
    // tombstone writer is guarded by `uninstalled_at IS NULL`.
    const projection = await projectPacksToComponents(
      withInterleavedSyncLane(prisma, lane)
    );
    assert.equal(projection.tombstoned, 2);

    assert.deepEqual(
      [...lane.uninstallsDelivered].sort(),
      [first.id, second.id].sort(),
      "both uninstalls must reach the lane; a tombstone filed at the acknowledged instant with a smaller id is omitted from cloud inventory permanently"
    );
    assert.equal(
      lane.uninstallsDelivered.length,
      2,
      "each uninstall must be delivered exactly once — advancing the ordering key must not re-emit a row the lane already took"
    );

    // The keys must also be strictly ordered against each other, not merely both
    // ahead of the pre-scan cursor: two tombstones in one scan are the case that
    // a single shared instant collapses.
    const firstAfter = await readRow(
      prisma,
      racePackExternalId(RACE_PACK_FIRST)
    );
    const secondAfter = await readRow(
      prisma,
      racePackExternalId(RACE_PACK_SECOND)
    );
    assert.equal(firstAfter.uninstalledAt, SCAN_TWO);
    assert.equal(secondAfter.uninstalledAt, SCAN_TWO);
    assert.ok(
      firstAfter.lastSeenAt !== null &&
        secondAfter.lastSeenAt !== null &&
        secondAfter.lastSeenAt > firstAfter.lastSeenAt,
      `the second tombstone must sort strictly after the first, got first=${firstAfter.lastSeenAt} second=${secondAfter.lastSeenAt}`
    );

    // The ordinary non-racing path still settles: a further scan over the same
    // retired packs must not churn the keys and re-send the uninstalls.
    await projectPacksToComponents(prisma);
    await lane.drain();
    assert.equal(
      lane.uninstallsDelivered.length,
      2,
      "a repeat scan must not re-deliver an uninstall the lane already received"
    );
    assert.equal(
      (await readRow(prisma, racePackExternalId(RACE_PACK_SECOND))).lastSeenAt,
      secondAfter.lastSeenAt,
      "an already-tombstoned row must keep its ordering key"
    );
  } finally {
    await close();
  }
});

test("nextComponentOrderingKey clears the highest key already in the table", () => {
  const atInstant = "2026-01-02T00:00:00.000Z";

  assert.ok(
    nextComponentOrderingKey(atInstant, null, null) > atInstant,
    "with no rows to outrank, the key must still clear the scan instant itself"
  );
  assert.ok(
    nextComponentOrderingKey(atInstant, atInstant, null) > atInstant,
    "a table maximum EQUAL to the scan instant is the race: the key must break the tie"
  );

  const ahead = "2026-06-01T00:00:00.000Z";
  assert.ok(
    nextComponentOrderingKey(atInstant, ahead, null) > ahead,
    "a table maximum ahead of the scan clock must still be outranked"
  );

  // An unparseable stored key cannot be reasoned about; the write still gets the
  // best key available rather than being abandoned.
  assert.ok(
    nextComponentOrderingKey(atInstant, "not-a-timestamp", null) > atInstant,
    "an unparseable table maximum must not stop the scan instant from advancing"
  );
});

test("nextComponentOrderingKey clears the durable lane cursor as well", () => {
  const atInstant = "2026-01-02T00:00:00.000Z";
  const cursorAhead = "2026-06-01T00:00:00.000Z";

  // ISS-10027: this is the deleted-cursor-row shape. The SURVIVING table maximum
  // is behind the scan instant — the row that carried the cursor position was
  // physically deleted — so the table floor alone mints a key at or behind the
  // cursor and the tombstone never re-enters the lane.
  assert.ok(
    nextComponentOrderingKey(
      atInstant,
      "2025-01-01T00:00:00.000Z",
      cursorAhead
    ) > cursorAhead,
    "a cursor ahead of BOTH the scan instant and the surviving table maximum must still be outranked"
  );
  assert.ok(
    nextComponentOrderingKey(atInstant, null, atInstant) > atInstant,
    "a cursor EQUAL to the scan instant is the same tie the table maximum poses: the key must break it"
  );

  // `observed_top_updated_at` stores the lane's NORMALIZED `COALESCE(last_seen_at,'')`,
  // so an empty string is the legal first-run value. It is not a position to outrank,
  // and it must not stop the other floors from being cleared.
  assert.ok(
    nextComponentOrderingKey(atInstant, cursorAhead, "") > cursorAhead,
    "an empty first-run cursor must not displace the table maximum as the governing floor"
  );
  assert.ok(
    nextComponentOrderingKey(atInstant, null, "not-a-timestamp") > atInstant,
    "an unparseable cursor must not stop the scan instant from advancing"
  );
});

/**
 * A cursor position AHEAD of the scan clock. Reachable in production two ways, both
 * named by ISS-10027: the `+1ms` chain walks the stored maximum forward on every
 * tombstone, and a backwards clock step leaves whatever it reached ahead of `now`.
 */
const CURSOR_AHEAD_OF_CLOCK = "2030-01-01T00:00:00.000Z";
const DELETED_CURSOR_ROW_ID = "iss10027-deleted-cursor-row";
const CURSOR_COMPUTE_TARGET = "compute-target-iss10027";

const INSERT_SYNC_STATE_SQL = `INSERT INTO sync_state
     (source_key, observed_top_updated_at, observed_ids_at_top_updated_at, updated_at)
   VALUES ($1, $2, '[]', $3)`;

/**
 * Reproduce the ISS-10027 precondition: the component lane's DURABLE cursor sits at
 * a position whose `agent_components` row is then physically DELETED.
 *
 * The delete is issued directly rather than through
 * `../src/main/database/skill-shadow-inventory-maintenance.ts` or migration
 * `0045_iss4778_phantom_command_backfill`. Both are real producers of this state and
 * neither is driveable from here — the migration has already run against this
 * database, and the maintenance sweep selects by phantom-command shape rather than by
 * id — so this MODELS those deletes rather than driving one. What is being pinned is
 * the ordering-key owner's behaviour once the table maximum has dropped below the
 * cursor, and that state is identical whichever statement produced it.
 */
async function seedDeletedCursorRow(prisma: DesktopPrisma): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, name, resolved_state,
          first_seen_at, last_seen_at, uninstalled_at)
       VALUES ($1, $2, $1, $1, $1, 'unresolved', $3, $4, NULL)`,
      DELETED_CURSOR_ROW_ID,
      AgentComponentKind.Mcp,
      SCAN_ONE,
      CURSOR_AHEAD_OF_CLOCK
    )
  );
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      INSERT_SYNC_STATE_SQL,
      buildAgentComponentSyncSourceKey(CURSOR_COMPUTE_TARGET),
      CURSOR_AHEAD_OF_CLOCK,
      SCAN_ONE
    )
  );
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      "DELETE FROM agent_components WHERE id = $1",
      DELETED_CURSOR_ROW_ID
    )
  );
}

test("a tombstone clears a durable cursor whose row was deleted", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "iss10027-mcp-"));
  const configPath = path.join(dir, "claude.json");
  const { prisma, close } = await openTestPrisma();
  try {
    writeClaudeMcpConfig(configPath, { weather: { command: "weather-mcp" } });
    await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      SCAN_ONE
    );
    const installed = await readRow(prisma, "weather");
    await seedDeletedCursorRow(prisma);

    // The defect's whole shape, asserted as a precondition so a fixture that stops
    // being adversarial fails loudly. The SURVIVING maximum is `SCAN_ONE`, far below
    // the cursor, so `max(scanInstant, survivingMax) + 1ms` lands behind it.
    assert.equal(
      installed.lastSeenAt,
      SCAN_ONE,
      "the surviving table maximum must sit below the durable cursor"
    );
    assert.ok(
      SCAN_TWO < CURSOR_AHEAD_OF_CLOCK,
      "the scan clock must also sit below the cursor, or the table floor alone would clear it"
    );
    assert.deepEqual(
      await idsFromCursor(prisma, CURSOR_AHEAD_OF_CLOCK, DELETED_CURSOR_ROW_ID),
      [],
      "fixture must place the durable cursor PAST every surviving row"
    );

    writeClaudeMcpConfig(configPath, {});
    const removal = await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      SCAN_TWO
    );
    assert.equal(removal.tombstoned, 1);

    const tombstoned = await readRow(prisma, "weather");
    assert.equal(tombstoned.uninstalledAt, SCAN_TWO);
    assert.ok(
      tombstoned.lastSeenAt !== null &&
        tombstoned.lastSeenAt > CURSOR_AHEAD_OF_CLOCK,
      `the ordering key must clear the DURABLE cursor, not just the surviving table maximum; got ${tombstoned.lastSeenAt}`
    );
    assert.deepEqual(
      await idsFromCursor(prisma, CURSOR_AHEAD_OF_CLOCK, DELETED_CURSOR_ROW_ID),
      [installed.id],
      "the uninstall must re-enter the lane from the durable cursor position"
    );
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});
