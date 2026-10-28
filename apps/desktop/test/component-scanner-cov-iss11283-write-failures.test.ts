/**
 * @file component-scanner-cov-iss11283-write-failures.test.ts
 * @description ISS-11283 lane D branch-coverage addendum for
 * `packs/component-scanner.ts`. The existing suites
 * (`component-scanner-installed-plugins.test.ts`,
 * `plugin-child-kind-parity.test.ts`, `pack-scan-post-steps.test.ts`) exercise
 * the happy paths of `projectPacksToComponents` and `discoverInstalledPlugins`
 * exhaustively; this file targets the failure catches neither suite reaches —
 * every read/write in the pack-projection and installed-plugin-discovery
 * pipelines can fail, and each failure is logged and skipped rather than
 * thrown. Failures are forced with REAL SQLite DDL (a dropped table, or a
 * trigger that rejects one specific write) against a real migrated store —
 * never a faked database layer.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { describe, it, vi } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  discoverInstalledPlugins,
  projectPacksToComponents,
} from "../src/main/packs/component-scanner.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const PACK_HARNESS = Harness.Claude;

type OpenedPrisma = Awaited<ReturnType<typeof openTestPrisma>>;

async function seedPack(
  opened: OpenedPrisma,
  pack: { packId: string; installPath: string; uninstalledAt?: string | null }
): Promise<void> {
  await opened.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_packs
         (pack_id, harness, install_path, install_kind, source_url, version,
          detected_at, last_seen_at, uninstalled_at)
       VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, NULL, $4)`,
      pack.packId,
      PACK_HARNESS,
      pack.installPath,
      pack.uninstalledAt ?? null
    )
  );
}

async function seedChild(
  opened: OpenedPrisma,
  child: { kind: string; key: string; installPath: string }
): Promise<void> {
  await opened.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, name,
          install_path, pack_id)
       VALUES ($1, $2, $1, $3, $3, $4, NULL)`,
      `${child.kind}:${child.key}`,
      child.kind,
      child.key,
      child.installPath
    )
  );
}

async function withClaudeHome<T>(
  fn: (claudeHome: string) => Promise<T>
): Promise<T> {
  const hadHome = Object.hasOwn(process.env, "CLAUDE_HOME");
  const prev = process.env.CLAUDE_HOME;
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "cl-scanner-cov-"));
  process.env.CLAUDE_HOME = claudeHome;
  try {
    return await fn(claudeHome);
  } finally {
    if (hadHome) {
      process.env.CLAUDE_HOME = prev;
    } else {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    }
    await rm(claudeHome, { recursive: true, force: true });
  }
}

async function writeRegistry(
  claudeHome: string,
  plugins: Record<string, unknown>
): Promise<void> {
  const pluginsDir = path.join(claudeHome, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins }),
    "utf8"
  );
}

describe("projectPacksToComponents: the agent_packs read failure fallback", () => {
  it("returns a zeroed summary and logs when agent_packs cannot be read", async () => {
    const opened = await openTestPrisma();
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // no-op
    });
    try {
      await opened.prisma.write((client) =>
        client.$executeRawUnsafe("DROP TABLE agent_packs")
      );

      const summary = await projectPacksToComponents(opened.prisma);

      assert.deepEqual(summary, {
        upserted: 0,
        tombstoned: 0,
        packIdBackfills: 0,
        packIdUnlinks: 0,
      });
      const warnCall = warnSpy.mock.calls.find(([, message]) =>
        String(message).includes("failed to read agent_packs")
      );
      assert.ok(warnCall, "the agent_packs read failure must be logged");
    } finally {
      warnSpy.mockRestore();
      await opened.close();
    }
  });
});

describe("projectPacksToComponents: per-pack write failures are logged and skipped", () => {
  it("logs and skips both an active-pack upsert failure and a tombstoned-pack failure, then still attempts the child backfill", async () => {
    const opened = await openTestPrisma();
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // no-op
    });
    try {
      await seedPack(opened, { packId: "active-pack", installPath: "a" });
      await seedPack(opened, {
        packId: "gone-pack",
        installPath: "b",
        uninstalledAt: "2026-08-12T00:00:00.000Z",
      });
      // Drop the table the per-pack upsert/tombstone AND the child backfill's
      // read/write all depend on, so every downstream step fails too.
      await opened.prisma.write((client) =>
        client.$executeRawUnsafe("DROP TABLE agent_components")
      );

      const summary = await projectPacksToComponents(opened.prisma);

      assert.deepEqual(summary, {
        upserted: 0,
        tombstoned: 0,
        packIdBackfills: 0,
        packIdUnlinks: 0,
      });
      const messages = warnSpy.mock.calls.map(([, m]) => String(m));
      assert.ok(
        messages.some((m) =>
          m.startsWith("upsertPluginComponent(active-pack)")
        ),
        "the active pack's upsert failure must be logged"
      );
      assert.ok(
        messages.some((m) => m.startsWith("tombstonePluginComponent(")),
        "the tombstoned pack's tombstone failure must be logged"
      );
      assert.ok(
        messages.some((m) =>
          m.startsWith("backfillChildPackIds: failed to read child rows")
        ),
        "the child-candidate read failure must be logged"
      );
    } finally {
      warnSpy.mockRestore();
      await opened.close();
    }
  });
});

describe("projectPacksToComponents: a re-scan with no ownership change writes nothing new", () => {
  it("does not increase packIdBackfills on a second scan once the child is already correctly linked", async () => {
    const opened = await openTestPrisma();
    try {
      await seedPack(opened, { packId: "stable-pack", installPath: "stable" });
      await seedChild(opened, {
        kind: AgentComponentKind.Skill,
        key: "stable-child",
        installPath: "stable/skills/stable-child",
      });

      const first = await projectPacksToComponents(opened.prisma);
      assert.ok(
        first.packIdBackfills > 0,
        "the first scan must claim the child"
      );

      // The claim SQL's guard is `pack_id IS NULL OR pack_id != $1` — the
      // child already carries the correct pack_id, so the UPDATE matches
      // zero rows on this second scan: `if (typeof affected === "number" &&
      // affected > 0)` takes its FALSE arm and packIdBackfills does not move.
      const second = await projectPacksToComponents(opened.prisma);
      assert.equal(second.packIdBackfills, 0);
      const third = await projectPacksToComponents(opened.prisma);
      assert.equal(third.packIdBackfills, 0);

      const row = await opened.prisma.client.$queryRawUnsafe<
        { packId: string | null }[]
      >(
        `SELECT pack_id AS "packId" FROM agent_components WHERE component_key = $1`,
        "stable-child"
      );
      assert.equal(row[0]?.packId, "stable-pack");
    } finally {
      await opened.close();
    }
  });
});

describe("projectPacksToComponents: the child-claim write itself can fail", () => {
  it("logs and skips a chunk whose claim UPDATE is rejected, leaving the child unlinked", async () => {
    const opened = await openTestPrisma();
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // no-op
    });
    try {
      await seedPack(opened, {
        packId: "trigger-pack",
        installPath: "trig",
      });
      await seedChild(opened, {
        kind: AgentComponentKind.Skill,
        key: "trigger-child",
        installPath: "trig/skills/trigger-child",
      });
      // A real SQLite trigger that rejects only the claim UPDATE for this one
      // pack id — the read (candidate page) and the ordering-key reservation
      // both still succeed; only the final UPDATE fails, isolating
      // `claimChildrenForPack`'s own catch from every other write in the pass.
      await opened.prisma.write((client) =>
        client.$executeRawUnsafe(
          `CREATE TRIGGER block_trigger_pack_claim
             BEFORE UPDATE ON agent_components
             WHEN NEW.pack_id = 'trigger-pack'
           BEGIN
             SELECT RAISE(FAIL, 'blocked for test');
           END`
        )
      );

      const summary = await projectPacksToComponents(opened.prisma);

      assert.equal(summary.packIdBackfills, 0);
      const row = await opened.prisma.client.$queryRawUnsafe<
        { packId: string | null }[]
      >(
        `SELECT pack_id AS "packId" FROM agent_components WHERE component_key = $1`,
        "trigger-child"
      );
      assert.equal(
        row[0]?.packId,
        null,
        "the rejected claim must leave the child unlinked"
      );
      const messages = warnSpy.mock.calls.map(([, m]) => String(m));
      assert.ok(
        messages.some((m) =>
          m.startsWith("backfillChildPackIds(trigger-pack)")
        ),
        "the claim write failure must be logged with the owning pack id"
      );
    } finally {
      warnSpy.mockRestore();
      await opened.close();
    }
  });
});

describe("projectPacksToComponents: the tombstoned-link clear write itself can fail", () => {
  it("logs and skips a rejected clear, leaving the stale link in place", async () => {
    const opened = await openTestPrisma();
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // no-op
    });
    try {
      await seedPack(opened, { packId: "clear-me", installPath: "clr" });
      await seedChild(opened, {
        kind: AgentComponentKind.Skill,
        key: "clear-child",
        installPath: "clr/skills/clear-child",
      });
      // First scan links the child while the pack is still active.
      await projectPacksToComponents(opened.prisma);
      const linked = await opened.prisma.client.$queryRawUnsafe<
        { packId: string | null }[]
      >(
        `SELECT pack_id AS "packId" FROM agent_components WHERE component_key = $1`,
        "clear-child"
      );
      assert.equal(linked[0]?.packId, "clear-me");

      // Reject only the CLEAR (pack_id -> NULL) write for this pack's children.
      await opened.prisma.write((client) =>
        client.$executeRawUnsafe(
          `CREATE TRIGGER block_clear_me_unlink
             BEFORE UPDATE ON agent_components
             WHEN OLD.pack_id = 'clear-me' AND NEW.pack_id IS NULL
           BEGIN
             SELECT RAISE(FAIL, 'blocked for test');
           END`
        )
      );
      await opened.prisma.write((client) =>
        client.$executeRawUnsafe(
          "UPDATE agent_packs SET uninstalled_at = $1 WHERE pack_id = $2",
          "2026-08-12T00:00:00.000Z",
          "clear-me"
        )
      );

      const summary = await projectPacksToComponents(opened.prisma);

      assert.equal(summary.packIdUnlinks, 0);
      const stillLinked = await opened.prisma.client.$queryRawUnsafe<
        { packId: string | null }[]
      >(
        `SELECT pack_id AS "packId" FROM agent_components WHERE component_key = $1`,
        "clear-child"
      );
      assert.equal(
        stillLinked[0]?.packId,
        "clear-me",
        "the rejected clear must leave the stale link in place"
      );
      const messages = warnSpy.mock.calls.map(([, m]) => String(m));
      assert.ok(
        messages.some((m) =>
          m.startsWith("clearTombstonedPackLinks(clear-me)")
        ),
        "the clear failure must be logged with the owning pack id"
      );
    } finally {
      warnSpy.mockRestore();
      await opened.close();
    }
  });
});

describe("discoverInstalledPlugins: write failures against a real store", () => {
  it("logs and skips both the upsert and the tombstone-scan read when agent_components cannot be written", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeRegistry(claudeHome, {
        "solo-plugin": [{ scope: "user", installPath: "plugins/solo" }],
      });
      const opened = await openTestPrisma();
      const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
        // no-op
      });
      try {
        await opened.prisma.write((client) =>
          client.$executeRawUnsafe("DROP TABLE agent_components")
        );

        const summary = await discoverInstalledPlugins(opened.prisma);

        assert.deepEqual(summary, { discovered: 0, tombstoned: 0 });
        const messages = warnSpy.mock.calls.map(([, m]) => String(m));
        assert.ok(
          messages.some((m) =>
            m.startsWith("upsertInstalledPluginComponent(solo-plugin)")
          ),
          "the upsert failure must be logged"
        );
        assert.ok(
          messages.some((m) =>
            m.startsWith(
              "tombstoneMissingInstalledPlugins: failed to read rows"
            )
          ),
          "the tombstone-scan read failure must be logged"
        );
      } finally {
        warnSpy.mockRestore();
        await opened.close();
      }
    });
  });

  it("logs and skips a single row's rejected tombstone write without throwing", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeRegistry(claudeHome, {
        "flaky-plugin": [{ scope: "user", installPath: "plugins/flaky" }],
      });
      const opened = await openTestPrisma();
      const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
        // no-op
      });
      try {
        const first = await discoverInstalledPlugins(opened.prisma);
        assert.equal(first.discovered, 1);
        const rows = await opened.prisma.client.$queryRawUnsafe<
          { id: string }[]
        >(
          `SELECT id FROM agent_components
             WHERE component_kind = $1 AND external_id LIKE 'installed-plugin|%'`,
          AgentComponentKind.Plugin
        );
        const rowId = rows[0]?.id;
        assert.ok(rowId, "the plugin row must exist after the first scan");

        await opened.prisma.write((client) =>
          client.$executeRawUnsafe(
            `CREATE TRIGGER block_flaky_tombstone
               BEFORE UPDATE ON agent_components
               WHEN NEW.id = '${rowId}'
             BEGIN
               SELECT RAISE(FAIL, 'blocked for test');
             END`
          )
        );
        // Remove the plugin from the registry so the second scan tries to
        // tombstone the row the trigger above rejects.
        await writeRegistry(claudeHome, {});

        const second = await discoverInstalledPlugins(opened.prisma);

        assert.equal(second.tombstoned, 0);
        const after = await opened.prisma.client.$queryRawUnsafe<
          { uninstalledAt: string | null }[]
        >(
          `SELECT uninstalled_at AS "uninstalledAt" FROM agent_components WHERE id = $1`,
          rowId
        );
        assert.equal(
          after[0]?.uninstalledAt,
          null,
          "the rejected tombstone write must leave the row untouched"
        );
        const messages = warnSpy.mock.calls.map(([, m]) => String(m));
        assert.ok(
          messages.some((m) =>
            m.startsWith(`tombstoneMissingInstalledPlugins(${rowId})`)
          ),
          "the per-row tombstone failure must be logged with the row id"
        );
      } finally {
        warnSpy.mockRestore();
        await opened.close();
      }
    });
  });
});
