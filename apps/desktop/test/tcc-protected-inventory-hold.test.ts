/**
 * @file tcc-protected-inventory-hold.test.ts
 * @description ISS-11914 (Perrin Upcott's ruling, 2026-10-07): inventory from a
 * TCC-protected project, or from a user config inside a protected folder, keeps
 * its last-scanned state. The scans no longer read
 * inside those folders, so a row they did not see there is held rather than
 * tombstoned, while an unprotected project's removed items still tombstone.
 * ISS-12169 narrows the MCP project hold to the protected project's own servers,
 * through a project path that never leaves the device.
 * Each case seeds the rows a pre-ISS-11914 scan left behind, then drives the
 * production scan and write path against a real migrated store.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { ComponentScope } from "@repo/api/src/types/component-scope";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  discoverMcpServers,
  discoverMcpServersFromDefaults,
} from "../src/main/packs/mcp-discovery.js";
import {
  applyPackScan,
  computePackScan,
} from "../src/main/packs/pack-scanner.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const OLD = "2026-01-01T00:00:00.000Z";
const ENV_KEYS = ["CLAUDE_HOME", "CODEX_HOME"] as const;

let fakeHome: string;
let protectedProject: string;
let plainProject: string;
let savedEnv: Map<string, string | undefined>;
let store: Awaited<ReturnType<typeof openTestPrisma>>;

beforeEach(async () => {
  fakeHome = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "iss11914-hold-"))
  );
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  savedEnv = new Map(
    ENV_KEYS.filter((key) => Object.hasOwn(process.env, key)).map((key) => [
      key,
      process.env[key],
    ])
  );
  process.env.CLAUDE_HOME = path.join(fakeHome, ".claude");
  process.env.CODEX_HOME = path.join(fakeHome, ".codex");
  protectedProject = path.join(fakeHome, "Documents", "proj");
  plainProject = path.join(fakeHome, "code", "proj");
  fs.mkdirSync(protectedProject, { recursive: true });
  fs.mkdirSync(plainProject, { recursive: true });
  store = await openTestPrisma();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  for (const key of ENV_KEYS) {
    if (savedEnv.has(key)) {
      process.env[key] = savedEnv.get(key);
    } else {
      Reflect.deleteProperty(process.env, key);
    }
  }
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe("pack scan keeps a protected project's last-scanned rows", () => {
  test("BMad and GStack rows inside protected folders are held; the plain project's removed rows still go", async () => {
    // On disk: a BMad install in the protected project, and a GStack install
    // reached through ~/.claude/skills/gstack -> ~/Documents/gstack-repo. The
    // plain project's BMad install has been removed.
    seedFile(
      [protectedProject, ".agents", "skills", "bmad-help", "SKILL.md"],
      "---\nname: bmad-help\n---\n"
    );
    const gstackRepo = path.join(fakeHome, "Documents", "gstack-repo");
    seedFile([gstackRepo, "review", "SKILL.md"], "---\nname: review\n---\n");
    const gstackLink = path.join(fakeHome, ".claude", "skills", "gstack");
    fs.mkdirSync(path.dirname(gstackLink), { recursive: true });
    fs.symlinkSync(gstackRepo, gstackLink);

    const bmadPack = (root: string) => path.join(root, ".agents", "skills");
    const bmadSkill = (root: string) =>
      path.join(bmadPack(root), "bmad-help", "SKILL.md");
    await store.db.query(
      `INSERT INTO agent_packs (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
       VALUES ('bmad-method', 'claude', $1, 'directory', $4, $4),
              ('bmad-method', 'claude', $2, 'directory', $4, $4),
              ('gstack', 'claude', $3, 'symlink', $4, $4)`,
      [bmadPack(protectedProject), bmadPack(plainProject), gstackLink, OLD]
    );
    await store.db.query(
      `INSERT INTO skills (skill_id, pack_id, harness, install_path, name, detected_at, last_seen_at)
       VALUES ('sk-protected', 'bmad-method', 'claude', $1, 'bmad-help', $4, $4),
              ('sk-plain', 'bmad-method', 'claude', $2, 'bmad-help', $4, $4),
              ('sk-gstack', 'gstack', 'claude', $3, 'review', $4, $4)`,
      [
        bmadSkill(protectedProject),
        bmadSkill(plainProject),
        path.join(gstackRepo, "review", "SKILL.md"),
        OLD,
      ]
    );
    await store.db.query(
      `INSERT INTO project_pack_associations (project_path, pack_id, detected_at, last_seen_at)
       VALUES ($1, 'bmad-method', $3, $3),
              ($2, 'bmad-method', $3, $3),
              ($1, 'gstack', $3, $3)`,
      [protectedProject, plainProject, OLD]
    );

    const compute = await computePackScan(
      { recentProjectRoots: [protectedProject, plainProject] },
      {
        scanClaudeMarketplaces: async () => ({
          installs: 0,
          skills: 0,
          marketplaces: 0,
        }),
        runCatalogDetectorAdapters: async () => ({}),
      }
    );
    const summary = await applyPackScan(
      store.prisma,
      compute,
      new Date().toISOString()
    );

    assert.equal(summary.pruned, true);
    assert.deepEqual(compute.plan, { packs: [], skills: [], associations: [] });
    const packs = await store.prisma.client.agentPack.findMany({
      select: { installPath: true, uninstalledAt: true },
    });
    assert.deepEqual(
      uninstalledByKey(packs, (row) => row.installPath),
      {
        [bmadPack(protectedProject)]: false,
        [bmadPack(plainProject)]: true,
        [gstackLink]: false,
      }
    );
    const skills = await store.prisma.client.skill.findMany({
      select: { skillId: true, uninstalledAt: true },
    });
    assert.deepEqual(
      uninstalledByKey(skills, (row) => row.skillId),
      {
        "sk-gstack": false,
        "sk-plain": true,
        "sk-protected": false,
      }
    );
    const associations =
      await store.prisma.client.projectPackAssociation.findMany({
        select: { projectPath: true, packId: true },
      });
    // The GStack association comes from a bare stat of its marker, which still
    // runs in a protected project, so its missing marker is a real removal.
    assert.deepEqual(associations, [
      { projectPath: protectedProject, packId: "bmad-method" },
    ]);
  });
});

describe("MCP discovery keeps servers from an unread protected .mcp.json", () => {
  beforeEach(async () => {
    await seedSessions([protectedProject, plainProject]);
    // The state a scan left when it could still read the protected project,
    // before ISS-12169, so no row records its project. The reader now refuses
    // the protected file, so that scan reads a copy.
    writeMcpConfig([protectedProject, ".mcp.json"], ["p-server"]);
    const readableCopy = path.join(fakeHome, "copy", ".mcp.json");
    writeMcpConfig([readableCopy], ["p-server"]);
    writeMcpConfig([plainProject, ".mcp.json"], ["u-kept", "u-removed"]);
    writeMcpConfig([fakeHome, ".claude.json"], ["user-kept", "user-removed"]);
    await discoverMcpServers(
      store.prisma,
      {
        claudeJsonConfigs: [
          { path: readableCopy, scope: ComponentScope.Project },
          {
            path: path.join(plainProject, ".mcp.json"),
            scope: ComponentScope.Project,
          },
          {
            path: path.join(fakeHome, ".claude.json"),
            scope: ComponentScope.User,
          },
        ],
      },
      OLD
    );
    writeMcpConfig([plainProject, ".mcp.json"], ["u-kept"]);
    writeMcpConfig([fakeHome, ".claude.json"], ["user-kept"]);
  });

  test("while the protected file exists, rows with no recorded project are held until a scan records it", async () => {
    await discoverMcpServersFromDefaults(store.prisma);

    // `u-removed` left the plain project before any scan recorded its project,
    // so it may be the protected project's and is held with `p-server`.
    assert.deepEqual(await mcpUninstalled(), {
      "p-server": false,
      "u-kept": false,
      "u-removed": false,
      "user-kept": false,
      "user-removed": true,
    });

    // That scan recorded `u-kept`'s project, so its removal is not held.
    writeMcpConfig([plainProject, ".mcp.json"], []);
    await discoverMcpServersFromDefaults(store.prisma);

    assert.deepEqual(await mcpUninstalled(), {
      "p-server": false,
      "u-kept": true,
      "u-removed": false,
      "user-kept": false,
      "user-removed": true,
    });
  });

  test("once the protected project has no .mcp.json, nothing is held", async () => {
    fs.rmSync(path.join(protectedProject, ".mcp.json"));

    await discoverMcpServersFromDefaults(store.prisma);

    assert.deepEqual(await mcpUninstalled(), {
      "p-server": true,
      "u-kept": false,
      "u-removed": true,
      "user-kept": false,
      "user-removed": true,
    });
  });
});

describe("MCP discovery holds only a protected project's own servers (ISS-12169)", () => {
  test("a plain project's removed server tombstones while the protected project's servers stay held", async () => {
    // A project reached through a symlink is scanned while it points outside
    // every protected folder, then repointed into ~/Documents.
    const linkedProject = path.join(fakeHome, "code", "linked");
    const readableTarget = path.join(fakeHome, "work", "linked");
    writeMcpConfig([readableTarget, ".mcp.json"], ["p-server"]);
    writeMcpConfig([protectedProject, ".mcp.json"], ["p-server"]);
    fs.symlinkSync(readableTarget, linkedProject);
    writeMcpConfig([plainProject, ".mcp.json"], ["u-kept", "u-removed"]);
    await seedSessions([linkedProject, plainProject]);
    await discoverMcpServersFromDefaults(store.prisma);
    assert.deepEqual(await mcpLocalProjectPaths(), {
      "p-server": linkedProject,
      "u-kept": plainProject,
      "u-removed": plainProject,
    });

    fs.rmSync(linkedProject, { recursive: true, force: true });
    fs.symlinkSync(protectedProject, linkedProject);
    writeMcpConfig([plainProject, ".mcp.json"], ["u-kept"]);
    await discoverMcpServersFromDefaults(store.prisma);

    assert.deepEqual(await mcpUninstalled(), {
      "p-server": false,
      "u-kept": false,
      "u-removed": true,
    });
  });

  test("the component sync payload carries no recorded project path", async () => {
    writeMcpConfig([plainProject, ".mcp.json"], ["u-server"]);
    await seedSessions([plainProject]);
    await discoverMcpServersFromDefaults(store.prisma);
    assert.deepEqual(await mcpLocalProjectPaths(), {
      "u-server": plainProject,
    });

    const source = createSqliteSessionSyncSource(store.prisma);
    assert.ok(source.listComponentCursorRows && source.loadComponentRows);
    const cursorRows = await source.listComponentCursorRows("", "", 100);
    const payload = await source.loadComponentRows(
      cursorRows.map((row) => row.id)
    );

    assert.deepEqual(
      payload.map((component) => component.externalId),
      ["u-server"]
    );
    assert.equal(JSON.stringify(payload).includes(fakeHome), false);
  });
});

describe("MCP discovery keeps user servers from an unread protected config", () => {
  test("while the protected Codex config exists its servers are held; once it is gone they go", async () => {
    // The state a scan left when CODEX_HOME was outside a protected folder.
    const plainCodex = path.join(fakeHome, ".codex");
    seedFile([plainCodex, "config.toml"], "[mcp_servers.codex-user]\n");
    await discoverMcpServers(store.prisma, { includeCodex: true }, OLD);
    const protectedCodex = path.join(
      fakeHome,
      "Library",
      "CloudStorage",
      "Box",
      ".codex"
    );
    seedFile([protectedCodex, "config.toml"], "[mcp_servers.codex-user]\n");
    process.env.CODEX_HOME = protectedCodex;

    await discoverMcpServersFromDefaults(store.prisma);
    assert.deepEqual(await mcpUninstalled(), { "codex-user": false });

    fs.rmSync(path.join(protectedCodex, "config.toml"));
    await discoverMcpServersFromDefaults(store.prisma);
    assert.deepEqual(await mcpUninstalled(), { "codex-user": true });
  });
});

async function seedSessions(cwds: string[]): Promise<void> {
  for (const cwd of cwds) {
    await store.db.query(
      `INSERT INTO sessions (id, name, status, cwd, started_at, updated_at)
       VALUES ($1, $1, $2, $3, $4, $4)`,
      [`s-${cwd}`, SESSION_STATUS.ACTIVE, cwd, new Date().toISOString()]
    );
  }
}

function seedFile(segments: string[], body: string): void {
  const file = path.join(...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

function writeMcpConfig(segments: string[], servers: string[]): void {
  seedFile(
    segments,
    JSON.stringify({
      mcpServers: Object.fromEntries(
        servers.map((name) => [name, { command: "npx" }])
      ),
    })
  );
}

function uninstalledByKey<T extends { uninstalledAt: string | null }>(
  rows: T[],
  key: (row: T) => string | null
): Record<string, boolean> {
  return Object.fromEntries(
    rows.map((row) => [key(row) ?? "", row.uninstalledAt !== null])
  );
}

async function mcpUninstalled(): Promise<Record<string, boolean>> {
  const rows = await store.prisma.client.agentComponent.findMany({
    where: { componentKind: AgentComponentKind.Mcp },
    select: { externalId: true, uninstalledAt: true },
  });
  return uninstalledByKey(rows, (row) => row.externalId);
}

async function mcpLocalProjectPaths(): Promise<Record<string, string | null>> {
  const rows = await store.prisma.client.agentComponent.findMany({
    where: { componentKind: AgentComponentKind.Mcp },
    select: { externalId: true, localProjectPath: true },
  });
  return Object.fromEntries(
    rows.map((row) => [row.externalId, row.localProjectPath])
  );
}
