/**
 * @file pack-scan-post-steps.test.ts
 * @description Pins the wiring that BOTH db-host store ops (`packScanner.run`
 * and `packScanner.apply`) share: after a pack scan settles, the post-steps run
 * harness-native installed-plugin discovery (FEA-4094) and, since ISS-6094, the
 * pack→plugin projection plus the `agent_components.pack_id` backfill. Those
 * units are covered directly in component-scanner-installed-plugins.test.ts and
 * plugin-child-kind-parity.test.ts; this test guards that the settle path
 * actually invokes them, so a wiring regression that leaves a step dead in
 * production is caught (PR #3693 review — wongk; PR #4916 review — codex).
 *
 * Both store ops call `runPackScanPostSteps(db.prisma)`, so exercising that one
 * helper against a real test store proves the registered paths reach discovery.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { runPackScanPostSteps } from "../src/main/packs/pack-scan-post-steps.js";
import { openTestPrisma } from "./prisma-test-utils.js";

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

test("runPackScanPostSteps: settle path discovers installed plugins", async () => {
  const hadHome = Object.hasOwn(process.env, "CLAUDE_HOME");
  const prev = process.env.CLAUDE_HOME;
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "cl-post-steps-"));
  process.env.CLAUDE_HOME = claudeHome;
  const { prisma, close } = await openTestPrisma();
  try {
    await writeRegistry(claudeHome, {
      "pyright-lsp@claude-plugins-official": [
        {
          scope: "user",
          installPath: "plugins/cache/official/pyright-lsp/1.0.0",
          version: "1.0.0",
        },
      ],
    });

    await runPackScanPostSteps(prisma);

    const rows = await prisma.client.$queryRawUnsafe<
      Array<{ componentKey: string | null }>
    >(
      `SELECT component_key AS "componentKey"
       FROM agent_components
       WHERE component_kind = $1
         AND external_id LIKE 'installed-plugin|%'`,
      AgentComponentKind.Plugin
    );
    assert.deepEqual(
      rows.map((r) => r.componentKey),
      ["pyright-lsp"],
      "post-scan settle must reach installed-plugin discovery"
    );
  } finally {
    await close();
    if (hadHome) {
      process.env.CLAUDE_HOME = prev;
    } else {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    }
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("runPackScanPostSteps: settle path discovers installed MCP servers", async () => {
  const hadHome = Object.hasOwn(process.env, "CLAUDE_HOME");
  const prev = process.env.CLAUDE_HOME;
  const hadCodexHome = Object.hasOwn(process.env, "CODEX_HOME");
  const prevCodexHome = process.env.CODEX_HOME;
  // `discoverMcpServersFromDefaults` reads `~/.claude.json` beside `~/.claude`,
  // so point CLAUDE_HOME at `<tmp>/.claude` and seed the sibling config. It also
  // scans the Codex config — isolate CODEX_HOME to an empty temp dir so the
  // operator's real Codex MCP config can't leak rows into this assertion.
  const home = await mkdtemp(path.join(os.tmpdir(), "cl-post-steps-mcp-"));
  process.env.CLAUDE_HOME = path.join(home, ".claude");
  process.env.CODEX_HOME = path.join(home, ".codex");
  const { prisma, close } = await openTestPrisma();
  try {
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { context7: { command: "npx" } } }),
      "utf8"
    );

    await runPackScanPostSteps(prisma);

    const rows = await prisma.client.$queryRawUnsafe<
      Array<{ componentKey: string | null }>
    >(
      `SELECT component_key AS "componentKey"
       FROM agent_components
       WHERE component_kind = $1
       ORDER BY component_key`,
      AgentComponentKind.Mcp
    );
    assert.deepEqual(
      rows.map((r) => r.componentKey),
      ["context7"],
      "post-scan settle must reach installed-MCP-server discovery"
    );
  } finally {
    await close();
    if (hadHome) {
      process.env.CLAUDE_HOME = prev;
    } else {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    }
    if (hadCodexHome) {
      process.env.CODEX_HOME = prevCodexHome;
    } else {
      Reflect.deleteProperty(process.env, "CODEX_HOME");
    }
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ISS-5274 — `skipDefinitionContent` drops the recursive walk, nothing else.
// ---------------------------------------------------------------------------

/**
 * Seed a Claude home holding a skill that a walk WOULD find, and return a
 * cleanup. The proof that the walk did or did not run is DB state alone — an
 * `agent_components` row for that skill — so no module spy is needed and the
 * test cannot pass by asserting on scaffolding.
 */
async function seedWalkableSkill(): Promise<{
  restore: () => Promise<void>;
}> {
  const hadHome = Object.hasOwn(process.env, "CLAUDE_HOME");
  const prev = process.env.CLAUDE_HOME;
  const hadCodexHome = Object.hasOwn(process.env, "CODEX_HOME");
  const prevCodexHome = process.env.CODEX_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), "cl-post-steps-defs-"));
  const claudeHome = path.join(home, ".claude");
  process.env.CLAUDE_HOME = claudeHome;
  process.env.CODEX_HOME = path.join(home, ".codex");
  await mkdir(path.join(claudeHome, "skills", "walkable"), {
    recursive: true,
  });
  await writeFile(
    path.join(claudeHome, "skills", "walkable", "SKILL.md"),
    "---\nname: walkable\n---\n\nwalkable body\n",
    "utf8"
  );
  return {
    restore: async () => {
      if (hadHome) {
        process.env.CLAUDE_HOME = prev;
      } else {
        Reflect.deleteProperty(process.env, "CLAUDE_HOME");
      }
      if (hadCodexHome) {
        process.env.CODEX_HOME = prevCodexHome;
      } else {
        Reflect.deleteProperty(process.env, "CODEX_HOME");
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}

function skillRows(
  prisma: Awaited<ReturnType<typeof openTestPrisma>>["prisma"]
): Promise<Array<{ componentKey: string | null }>> {
  return prisma.client.$queryRawUnsafe<Array<{ componentKey: string | null }>>(
    `SELECT component_key AS "componentKey"
       FROM agent_components
      WHERE component_kind = $1
      ORDER BY component_key`,
    AgentComponentKind.Skill
  );
}

test("runPackScanPostSteps: the default still walks and writes definition rows", async () => {
  const { restore } = await seedWalkableSkill();
  const { prisma, close } = await openTestPrisma();
  try {
    await runPackScanPostSteps(prisma);

    assert.deepEqual(
      (await skillRows(prisma)).map((r) => r.componentKey),
      ["walkable"],
      "the fallback path (packScanner.run, golden mode) must still walk"
    );
  } finally {
    await close();
    await restore();
  }
});

test("runPackScanPostSteps: skipDefinitionContent writes no definition rows but still discovers MCP", async () => {
  const { restore } = await seedWalkableSkill();
  const { prisma, close } = await openTestPrisma();
  try {
    await writeFile(
      path.join(path.dirname(process.env.CLAUDE_HOME ?? ""), ".claude.json"),
      JSON.stringify({ mcpServers: { context7: { command: "npx" } } }),
      "utf8"
    );

    await runPackScanPostSteps(prisma, { skipDefinitionContent: true });

    // The walk is what `packScanner.apply` must NOT do — the coordinator drives
    // it in the compute worker instead. A row here would mean the recursive
    // readdirSync sweep ran on the db-host after all, which is the entire cost
    // ISS-5274 removes.
    assert.deepEqual(await skillRows(prisma), []);

    // …and only that step is dropped. MCP discovery is a bounded config read,
    // not a recursive walk, so it must still run on this path.
    const mcp = await prisma.client.$queryRawUnsafe<
      Array<{ componentKey: string | null }>
    >(
      `SELECT component_key AS "componentKey"
         FROM agent_components
        WHERE component_kind = $1`,
      AgentComponentKind.Mcp
    );
    assert.deepEqual(
      mcp.map((r) => r.componentKey),
      ["context7"]
    );
  } finally {
    await close();
    await restore();
  }
});

// ---------------------------------------------------------------------------
// ISS-6094 — the settle path must reach the plugin projection + pack_id backfill.
// ---------------------------------------------------------------------------

/**
 * Point CLAUDE_HOME/CODEX_HOME at empty temp dirs so the operator's real
 * registry and MCP config cannot write rows into these assertions, and so the
 * only `agent_components` rows are the ones this test seeds.
 */
async function isolateHarnessHomes(): Promise<{
  restore: () => Promise<void>;
}> {
  const hadHome = Object.hasOwn(process.env, "CLAUDE_HOME");
  const prev = process.env.CLAUDE_HOME;
  const hadCodexHome = Object.hasOwn(process.env, "CODEX_HOME");
  const prevCodexHome = process.env.CODEX_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), "cl-post-steps-packid-"));
  process.env.CLAUDE_HOME = path.join(home, ".claude");
  process.env.CODEX_HOME = path.join(home, ".codex");
  return {
    restore: async () => {
      if (hadHome) {
        process.env.CLAUDE_HOME = prev;
      } else {
        Reflect.deleteProperty(process.env, "CLAUDE_HOME");
      }
      if (hadCodexHome) {
        process.env.CODEX_HOME = prevCodexHome;
      } else {
        Reflect.deleteProperty(process.env, "CODEX_HOME");
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}

/**
 * ISS-6094 wiring guard. `projectPacksToComponents` — the ONLY writer of
 * `agent_components.pack_id` on a child row, and therefore the only thing that
 * makes a plugin usage rollup non-zero — had no production caller at all: it was
 * invoked solely by its own unit test, so widening its kind list changed nothing
 * a user could see. Delete the call from `runPackScanPostSteps` and this test
 * fails on the NULL `pack_id`, exactly as production did.
 */
test("runPackScanPostSteps: settle path projects packs and stamps child pack_id", async () => {
  const { restore } = await isolateHarnessHomes();
  const { prisma, close } = await openTestPrisma();
  try {
    const packPath = "plugins/cache/wired-pack";
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_packs
           (pack_id, harness, install_path, install_kind, source_url, version,
            detected_at, last_seen_at, uninstalled_at)
         VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, NULL, NULL)`,
        "wired-pack",
        Harness.Claude,
        packPath
      )
    );
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name,
            install_path, pack_id)
         VALUES ($1, $2, $1, $3, $3, $4, NULL)`,
        "subagent:wired-child",
        AgentComponentKind.Subagent,
        "wired-child",
        `${packPath}/agents/wired-child`
      )
    );

    await runPackScanPostSteps(prisma, { skipDefinitionContent: true });

    const child = await prisma.client.$queryRawUnsafe<
      Array<{ packId: string | null }>
    >(
      `SELECT pack_id AS "packId" FROM agent_components WHERE component_key = $1`,
      "wired-child"
    );
    assert.deepEqual(
      child.map((r) => r.packId),
      ["wired-pack"],
      "post-scan settle must reach the pack_id backfill, or every plugin rollup reads zero"
    );

    const plugin = await prisma.client.$queryRawUnsafe<
      Array<{ componentKey: string | null }>
    >(
      `SELECT component_key AS "componentKey"
         FROM agent_components
        WHERE component_kind = $1
          AND external_id NOT LIKE 'installed-plugin|%'`,
      AgentComponentKind.Plugin
    );
    assert.deepEqual(
      plugin.map((r) => r.componentKey),
      ["wired-pack"],
      "post-scan settle must also project the pack itself to a plugin row"
    );
  } finally {
    await close();
    await restore();
  }
});
