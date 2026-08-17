/**
 * @file mcp-discovery.test.ts
 * @description Behavioral tests for FEA-4095 progressive discovery of installed
 * MCP servers: seeds a tmpdir with Claude JSON (`~/.claude.json` / project
 * `.mcp.json`) and Codex TOML (`config.toml`) MCP configs, runs
 * `discoverMcpServers` against an ephemeral migrated libSQL store, and asserts a
 * configured-but-never-invoked server is registered as a zero-usage
 * `agent_components` row — the installed-but-unused signal, present even at zero
 * invocations.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// The DISPLAY harness contract ({claude,codex,both}) + the canonical component
// kind const — imported as values so the test asserts against the SSOT, never a
// re-declared literal.
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { SYNCED_COMPONENT_IDENTITY_MAX_CHARS } from "@repo/api/src/types/agent-session";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { ComponentScope } from "../src/main/packs/definition-content-collector.js";
import { discoverMcpServers } from "../src/main/packs/mcp-discovery.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type McpRow = {
  component_kind: string;
  external_id: string;
  component_key: string;
  name: string | null;
  harness: string | null;
  scope: string | null;
  install_path: string | null;
  project_path: string | null;
  resolved_state: string;
  content: string | null;
  uninstalled_at: string | null;
};

function mcpComponents(prisma: DesktopPrisma): Promise<McpRow[]> {
  return prisma.write((client) =>
    client.$queryRawUnsafe<McpRow[]>(
      `SELECT component_kind, external_id, component_key, name, harness, scope,
              install_path, project_path, resolved_state, content, uninstalled_at
       FROM agent_components
       WHERE component_kind = ?
       ORDER BY external_id`,
      AgentComponentKind.Mcp
    )
  );
}

function usageCountFor(
  prisma: DesktopPrisma,
  externalId: string
): Promise<{ n: number }[]> {
  return prisma.write((client) =>
    client.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM agent_component_session_usage
       WHERE component_kind = ? AND component_key = ?`,
      AgentComponentKind.Mcp,
      externalId
    )
  );
}

test("discoverMcpServers registers an installed-but-unused Claude MCP server as a zero-usage row", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-home-"));
  const configPath = path.join(home, ".claude.json");
  // `context7` is configured but has NEVER been invoked — no usage row exists.
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      },
    })
  );
  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await discoverMcpServers(prisma, {
      claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }],
    });
    assert.equal(summary.discovered, 1);
    assert.equal(summary.upserted, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.tombstoned, 0);

    const rows = await mcpComponents(prisma);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.component_kind, AgentComponentKind.Mcp);
    // Keyed by the bare server name; display name mirrors the key.
    assert.equal(row.external_id, "context7");
    assert.equal(row.component_key, "context7");
    assert.equal(row.name, "context7");
    assert.equal(row.harness, Harness.Claude);
    // `~/.claude.json` sits under <home>, so scope derives to "user".
    assert.equal(row.scope, "user");
    // A names-only presence row leaks NO on-disk path to the cloud sync lane.
    assert.equal(row.install_path, null);
    assert.equal(row.project_path, null);
    // Freshly configured — not tombstoned.
    assert.equal(row.uninstalled_at, null);
    // MCP is observable-only: presence carries no distributable content and the
    // row stays name/label-only (unresolved).
    assert.equal(row.resolved_state, "unresolved");
    assert.equal(row.content, null);

    // The row exists with ZERO usage — the installed-but-unused state is a real,
    // shown value, never an absent row (FEA-4095).
    const [{ n }] = await usageCountFor(prisma, "context7");
    assert.equal(Number(n), 0);

    // Idempotent id: matches the event-driven `deterministicComponentId` formula
    // so a re-scan / a later usage row for the same server name converge.
    const expectedId = createHash("sha256")
      .update(`${AgentComponentKind.Mcp}|context7`)
      .digest("hex")
      .slice(0, 32);
    const idRow = await prisma.write((client) =>
      client.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM agent_components WHERE component_kind = ? AND external_id = ?",
        AgentComponentKind.Mcp,
        "context7"
      )
    );
    assert.equal(idRow[0]?.id, expectedId);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverMcpServers folds a server declared under both harnesses to `both` and is idempotent", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-both-"));
  const claudeConfig = path.join(home, ".claude.json");
  const codexHome = path.join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const codexConfig = path.join(codexHome, "config.toml");
  // The SAME server name (`shared`) is configured under a Claude JSON config
  // AND a Codex TOML config — the dual-installed case that must fold to `both`.
  writeFileSync(
    claudeConfig,
    JSON.stringify({ mcpServers: { shared: { command: "run-a" } } })
  );
  writeFileSync(codexConfig, "[mcp_servers.shared]\ncommand = 'run-b'\n");
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const { prisma, close } = await openTestPrisma();
  try {
    const first = await discoverMcpServers(prisma, {
      claudeJsonConfigs: [{ path: claudeConfig, scope: ComponentScope.User }],
      includeCodex: true,
    });
    // Same server name across the Claude + Codex configs → one deduped row.
    assert.equal(first.discovered, 1);
    assert.equal(first.upserted, 1);

    // Re-run (Claude-only): still one row and no duplicate — idempotent upsert
    // on (component_kind, external_id).
    await discoverMcpServers(prisma, {
      claudeJsonConfigs: [{ path: claudeConfig, scope: ComponentScope.User }],
    });
    const rows = await mcpComponents(prisma);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].external_id, "shared");
    // Dual-installed identity folds to `both` (mirrors the definition
    // collector's cross-harness fold).
    assert.equal(rows[0].harness, Harness.Both);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
    if (priorCodexHome === undefined) {
      Reflect.deleteProperty(process.env, "CODEX_HOME");
    } else {
      process.env.CODEX_HOME = priorCodexHome;
    }
  }
});

test("discoverMcpServers reads Codex `[mcp_servers.<name>]` TOML headers without a TOML parser", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-codex-"));
  const codexHome = path.join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(
    configPath,
    [
      "model = 'gpt-5-codex'",
      "",
      "[mcp_servers.linear]",
      "command = 'npx'",
      "args = ['-y', 'linear-mcp']",
      "",
      // A nested subtable for the SAME server — must NOT mint a spurious
      // `linear.env` component row.
      "[mcp_servers.linear.env]",
      "LINEAR_API_KEY = 'redacted'",
      "",
      '[mcp_servers."quoted-name"]',
      "command = 'run'",
    ].join("\n")
  );
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await discoverMcpServers(prisma, {
      includeCodex: true,
    });
    // Two servers — the `[mcp_servers.linear.env]` subtable is not a server.
    assert.equal(summary.discovered, 2);
    const rows = await mcpComponents(prisma);
    assert.deepEqual(
      rows.map((r) => r.external_id),
      ["linear", "quoted-name"]
    );
    assert.ok(rows.every((r) => r.harness === Harness.Codex));
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
    if (priorCodexHome === undefined) {
      Reflect.deleteProperty(process.env, "CODEX_HOME");
    } else {
      process.env.CODEX_HOME = priorCodexHome;
    }
  }
});

test("discoverMcpServers rejects an over-limit server name before persistence and still registers a valid sibling", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-limit-"));
  const configPath = path.join(home, ".claude.json");
  // A name longer than the sync contract's identity bound would be rejected by
  // the cloud once it reached the ordered component batch, wedging the cursor.
  // Discovery must drop it BEFORE persistence — while a valid sibling in the
  // same config still registers.
  const overlong = "x".repeat(SYNCED_COMPONENT_IDENTITY_MAX_CHARS + 1);
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [overlong]: { command: "npx" },
        "  ": { command: "blank" },
        context7: { command: "npx" },
      },
    })
  );
  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await discoverMcpServers(prisma, {
      claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }],
    });
    // Only the valid name is discovered/persisted; the over-limit and
    // blank names never reach the store.
    assert.equal(summary.discovered, 1);
    assert.equal(summary.upserted, 1);
    const rows = await mcpComponents(prisma);
    assert.deepEqual(
      rows.map((r) => r.external_id),
      ["context7"]
    );
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverMcpServers tombstones a removed server and clears the tombstone when it reappears", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-tomb-"));
  const configPath = path.join(home, ".claude.json");
  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { context7: { command: "npx" } } })
  );
  const { prisma, close } = await openTestPrisma();
  try {
    // Scan 1: server present.
    await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      "2026-01-01T00:00:00.000Z"
    );
    let rows = await mcpComponents(prisma);
    assert.equal(rows[0].uninstalled_at, null);

    // Scan 2: server removed from the config → its presence row is tombstoned.
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    const removed = await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      "2026-01-02T00:00:00.000Z"
    );
    assert.equal(removed.discovered, 0);
    assert.equal(removed.tombstoned, 1);
    rows = await mcpComponents(prisma);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uninstalled_at, "2026-01-02T00:00:00.000Z");

    // Scan 3: server reappears → its tombstone is cleared (re-installed).
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { context7: { command: "npx" } } })
    );
    const back = await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      "2026-01-03T00:00:00.000Z"
    );
    assert.equal(back.upserted, 1);
    assert.equal(back.tombstoned, 0);
    rows = await mcpComponents(prisma);
    assert.equal(rows[0].uninstalled_at, null);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverMcpServers promotes a claude-only presence row to `both` on a later codex-observed scan", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-promote-"));
  const claudeConfig = path.join(home, ".claude.json");
  const codexHome = path.join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const codexConfig = path.join(codexHome, "config.toml");
  writeFileSync(
    claudeConfig,
    JSON.stringify({ mcpServers: { shared: { command: "run-a" } } })
  );
  writeFileSync(codexConfig, "[mcp_servers.shared]\ncommand = 'run-b'\n");
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const { prisma, close } = await openTestPrisma();
  try {
    // Scan 1: Claude only → the stored harness is `claude`.
    await discoverMcpServers(prisma, {
      claudeJsonConfigs: [{ path: claudeConfig, scope: ComponentScope.User }],
    });
    let rows = await mcpComponents(prisma);
    assert.equal(rows[0].harness, Harness.Claude);

    // Scan 2: the SAME server now also observed under Codex. A COALESCE fold
    // would keep the stored `claude`; the CASE fold promotes it to `both` —
    // the single-harness → dual-harness transition wongk called out.
    await discoverMcpServers(prisma, {
      claudeJsonConfigs: [{ path: claudeConfig, scope: ComponentScope.User }],
      includeCodex: true,
    });
    rows = await mcpComponents(prisma);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].harness, Harness.Both);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
    if (priorCodexHome === undefined) {
      Reflect.deleteProperty(process.env, "CODEX_HOME");
    } else {
      process.env.CODEX_HOME = priorCodexHome;
    }
  }
});

test("discoverMcpServers does not tombstone a usage-minted MCP row (full tool-name key, no name)", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-usage-"));
  const configPath = path.join(home, ".claude.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
  const { prisma, close } = await openTestPrisma();
  try {
    // Seed a usage-minted MCP row exactly as `component-invocations.ts` does:
    // keyed by the full Claude tool name, with NO `name` column. The reconcile
    // pass keys off `name = external_id`, so this row must be left untouched.
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, resolved_state,
            first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'unresolved', ?, ?)`,
        "usageid00000000000000000000000000",
        AgentComponentKind.Mcp,
        "mcp__context7__resolve",
        "mcp__context7__resolve",
        "2020-01-01T00:00:00.000Z",
        "2020-01-01T00:00:00.000Z"
      )
    );
    const summary = await discoverMcpServers(
      prisma,
      { claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }] },
      "2026-01-01T00:00:00.000Z"
    );
    // No configured servers → nothing discovered, and the usage row (name IS
    // NULL, so not discovery-owned) is NOT tombstoned.
    assert.equal(summary.discovered, 0);
    assert.equal(summary.tombstoned, 0);
    const rows = await mcpComponents(prisma);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].external_id, "mcp__context7__resolve");
    assert.equal(rows[0].name, null);
    assert.equal(rows[0].uninstalled_at, null);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});
