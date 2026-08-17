/**
 * @file component-invocations-skill-inventory-repair.test.ts
 * @description ISS-5260: the two populations the revision-68 bump cannot reach
 * on its own — an ALREADY-POPULATED inventory, and a skill that resolves AFTER
 * the sessions that invoked it were sealed.
 *
 * The re-point stops a phantom `(command, /X)` row from being MINTED and the
 * rebuild moves invocations onto the skill, but neither deletes an inventory row
 * that already exists, and `INVENTORY_SELECT` carries no invocation-count filter
 * — so the Commands tab would keep rendering `/prune-tests` with zero
 * invocations and no definition. And the re-point gates on a RESOLVED skill read
 * at materialization time, so a session imported before resolution keeps its
 * command attribution and is sealed at the current revision, after which a
 * one-shot bump never selects it again.
 *
 * These drive the PRODUCTION pass (`repairSkillShadowedCommandInventory`, run in
 * the db host as the `skillShadowInventory.repair` store op) against a real
 * SQLite store, and assert both halves: the inventory row is GONE, and the
 * sessions that held its invocations are parked for re-derivation. That the
 * maintenance chain actually invokes it — and does so before the rebuild — is
 * covered by `post-boot-maintenance-skill-inventory-order.test.ts`.
 *
 * Split from `component-invocations-skill-repoint.test.ts` rather than added to
 * it — that file covers the mint-time decision, this one covers repair of state
 * already on disk, and neither should grow into the other.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { ComponentResolvedState } from "@repo/api/src/types/agent-component";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import {
  DATA_REVISION,
  DATA_REVISION_MAINTENANCE_STALE,
} from "../src/main/collectors/engine/data-revision.js";
import { repairSkillShadowedCommandInventory } from "../src/main/database/skill-shadow-inventory-maintenance.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-08-05T17:00:00.000Z";
const INVOKED_AT = "2026-08-05T17:00:01.000Z";
const SKILL_KEY = "prune-tests";
const SLASH_KEY = "/prune-tests";
const Kind = AgentComponentInvocationKind;

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

describe("ISS-5260 phantom inventory rows on an already-populated store", () => {
  // The upgraded-store population. Migration 0045 deleted these once and every
  // import since re-minted them; the rev-68 rebuild moves the invocations off the
  // command but nothing deletes the row, so the Commands tab keeps asserting a
  // command exists and was never used — a worse claim than the one it replaced.
  test("a pre-existing phantom command row is deleted and its sessions parked", async () => {
    await withDb("aci-inv-repair-preexisting-", async (db) => {
      // Import BEFORE the skill resolves, so the session genuinely mints the
      // phantom row and the command invocation — the real on-disk starting
      // state, not a hand-seeded approximation of it.
      await insertSkillComponent(
        db,
        SKILL_KEY,
        ComponentResolvedState.Unresolved
      );
      await db.importer.importSession(
        slashSession("session-preexisting"),
        "claude"
      );
      assert.deepEqual(await componentKeys(db, Kind.Command), [SLASH_KEY]);
      assert.equal(
        await sessionRevision(db, "session-preexisting"),
        DATA_REVISION
      );

      // The definition collector then captures SKILL.md and promotes the row.
      await promoteSkillToResolved(db, SKILL_KEY);
      const repair = await repairSkillShadowedCommandInventory(
        db.prisma,
        () => undefined
      );

      assert.deepEqual(repair, {
        deletedComponents: 1,
        markedSessions: 1,
      });
      // The row the Commands tab reads is gone…
      assert.deepEqual(await componentKeys(db, Kind.Command), []);
      // …and the session is parked, so the rebuild that follows re-derives it
      // rather than leaving the invocation stranded on a deleted component.
      assert.equal(
        await sessionRevision(db, "session-preexisting"),
        DATA_REVISION_MAINTENANCE_STALE
      );
    });
  });

  // Idempotence: a second pass over a repaired store finds nothing and must not
  // re-park sessions the rebuild has since sealed. A counter that incremented
  // outside the `if (found)` branch would report phantom work here.
  test("a second pass over a repaired store repairs nothing", async () => {
    await withDb("aci-inv-repair-idempotent-", async (db) => {
      await insertSkillComponent(
        db,
        SKILL_KEY,
        ComponentResolvedState.Unresolved
      );
      await db.importer.importSession(
        slashSession("session-idempotent"),
        "claude"
      );
      await promoteSkillToResolved(db, SKILL_KEY);

      await repairSkillShadowedCommandInventory(db.prisma, () => undefined);
      const second = await repairSkillShadowedCommandInventory(
        db.prisma,
        () => undefined
      );

      assert.deepEqual(second, { deletedComponents: 0, markedSessions: 0 });
    });
  });

  // The control that proves the repair NARROWED the inventory rather than
  // emptying it: a genuine command carrying its own definition text is not a
  // phantom, whatever skill shares its bare name.
  test("a vouched command sharing a skill's bare name is never deleted", async () => {
    await withDb("aci-inv-repair-vouched-", async (db) => {
      await insertSkillComponent(db, "deploy", ComponentResolvedState.Resolved);
      await insertCommandComponent(db, "/deploy", "# Deploy the thing");

      const repair = await repairSkillShadowedCommandInventory(
        db.prisma,
        () => undefined
      );

      assert.deepEqual(repair, { deletedComponents: 0, markedSessions: 0 });
      assert.deepEqual(await componentKeys(db, Kind.Command), ["/deploy"]);
    });
  });

  // The leading-slash-run population ISS-4795 documented: `//deploy` parses to
  // the bare name `/deploy`, which answers to no skill, so the SQL bare-name
  // derivation must agree with `slashKeyBareName` and leave it alone.
  test("a double-slashed command is not matched against a bare-named skill", async () => {
    await withDb("aci-inv-repair-slashrun-", async (db) => {
      await insertSkillComponent(db, "deploy", ComponentResolvedState.Resolved);
      await insertCommandComponent(db, "//deploy", null);

      const repair = await repairSkillShadowedCommandInventory(
        db.prisma,
        () => undefined
      );

      assert.deepEqual(repair, { deletedComponents: 0, markedSessions: 0 });
      assert.deepEqual(await componentKeys(db, Kind.Command), ["//deploy"]);
    });
  });

  // An unresolved skill is a name observed in passing, not proof a definition
  // exists — it must not license deleting a command row.
  test("an UNRESOLVED skill does not license deleting the command row", async () => {
    await withDb("aci-inv-repair-unresolved-skill-", async (db) => {
      await insertSkillComponent(
        db,
        SKILL_KEY,
        ComponentResolvedState.Unresolved
      );
      await db.importer.importSession(
        slashSession("session-unresolved"),
        "claude"
      );

      const repair = await repairSkillShadowedCommandInventory(
        db.prisma,
        () => undefined
      );

      assert.deepEqual(repair, { deletedComponents: 0, markedSessions: 0 });
      assert.deepEqual(await componentKeys(db, Kind.Command), [SLASH_KEY]);
    });
  });
});

describe("ISS-5260 a skill that resolves after its sessions were sealed", () => {
  // The ordering hole the revision bump cannot cover. Every mint-time test seeds
  // the resolved skill BEFORE importing, so resolve-after-import is exercised
  // only here: import against an unresolved skill, promote it, then prove the
  // whole repair chain converges the session onto the skill.
  test("the repair plus rebuild re-points a session imported before resolution", async () => {
    await withDb("aci-inv-repair-late-resolve-", async (db) => {
      await insertSkillComponent(
        db,
        SKILL_KEY,
        ComponentResolvedState.Unresolved
      );
      await db.importer.importSession(
        slashSession("session-late-resolve"),
        "claude"
      );
      // The split this revision exists to close: invocation on the command,
      // definition (once it lands) on the skill.
      assert.deepEqual(
        await invocationKeys(db, "session-late-resolve", Kind.Command),
        [SLASH_KEY]
      );

      await promoteSkillToResolved(db, SKILL_KEY);
      await repairSkillShadowedCommandInventory(db.prisma, () => undefined);
      const rebuilt = await db.rebuildComponentInvocationsFromStoredRows(
        "session-late-resolve",
        DATA_REVISION
      );

      // The parked revision is what made the session selectable at all — the
      // rebuild re-checks staleness inside its own write transaction.
      assert.equal(rebuilt.rebuilt, true);
      assert.deepEqual(
        await invocationKeys(db, "session-late-resolve", Kind.Command),
        []
      );
      assert.deepEqual(
        await invocationKeys(db, "session-late-resolve", Kind.Skill),
        [SKILL_KEY]
      );
      assert.deepEqual(await componentKeys(db, Kind.Command), []);
    });
  });
});

async function withDb(
  prefix: string,
  body: (db: Db) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await body(db);
  } finally {
    await db.close();
    await rm(dir, { force: true, recursive: true });
  }
}

/** One user turn that typed `/prune-tests`, with no `Skill` tool_use to pair. */
function slashSession(sessionId: string): ReturnType<typeof makeSession> {
  return makeSession({
    endedAt: "2026-08-05T17:30:00.000Z",
    messages: [{ role: "human", text: SLASH_KEY, timestamp: INVOKED_AT }],
    sessionId,
    slashCommands: [{ name: SLASH_KEY, timestamp: INVOKED_AT }],
    startedAt: NOW,
  });
}

function insertSkillComponent(
  db: Db,
  componentKey: string,
  resolvedState: ComponentResolvedState
): Promise<unknown> {
  return db.run(
    `INSERT INTO agent_components
       (id, component_kind, external_id, component_key, resolved_state,
        content, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $6)`,
    `component-skill-${componentKey}`,
    Kind.Skill,
    componentKey,
    resolvedState,
    resolvedState === ComponentResolvedState.Resolved
      ? `---\nname: ${componentKey}\n---\nDo the thing.\n`
      : null,
    NOW
  );
}

/** What the definition collector does once it captures the skill's SKILL.md. */
function promoteSkillToResolved(
  db: Db,
  componentKey: string
): Promise<unknown> {
  return db.run(
    `UPDATE agent_components
        SET resolved_state = $1, content = $2
      WHERE component_kind = $3 AND component_key = $4`,
    ComponentResolvedState.Resolved,
    `---\nname: ${componentKey}\n---\nDo the thing.\n`,
    Kind.Skill,
    componentKey
  );
}

function insertCommandComponent(
  db: Db,
  componentKey: string,
  content: string | null
): Promise<unknown> {
  return db.run(
    `INSERT INTO agent_components
       (id, component_kind, external_id, component_key, resolved_state,
        content, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $6)`,
    `component-command-${componentKey}`,
    Kind.Command,
    componentKey,
    ComponentResolvedState.Unresolved,
    content,
    NOW
  );
}

function componentKeys(db: Db, componentKind: string): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ component_key: string }[]>(
      `SELECT component_key
         FROM agent_components
        WHERE component_kind = $1 AND uninstalled_at IS NULL
        ORDER BY component_key`,
      componentKind
    )
    .then((rows) => rows.map((row) => row.component_key));
}

function invocationKeys(
  db: Db,
  sessionId: string,
  componentKind: string
): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ component_key: string }[]>(
      `SELECT component_key
         FROM agent_component_invocations
        WHERE session_id = $1 AND component_kind = $2
        ORDER BY component_key`,
      sessionId,
      componentKind
    )
    .then((rows) => rows.map((row) => row.component_key));
}

function sessionRevision(db: Db, sessionId: string): Promise<number> {
  return db.prisma.client
    .$queryRawUnsafe<{ data_revision: number }[]>(
      "SELECT data_revision FROM sessions WHERE id = $1",
      sessionId
    )
    .then((rows) => Number(rows[0]?.data_revision));
}
