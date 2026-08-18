/**
 * @file component-scanner-installed-plugins.test.ts
 * @description FEA-4094 behavioral coverage for `discoverInstalledPlugins`:
 * harness-native installed plugins are discovered straight from the on-disk
 * registry and materialized as one `component_kind='plugin'` `agent_components`
 * row per installed plugin — presence-based, independent of usage and of the
 * bundled-marketplace pack collapse.
 *
 * The bug this guards: multiple plugins were installed but invisible because
 * the only plugin-kind writer (`projectPacksToComponents`) collapses a bundled
 * marketplace (e.g. `closedloop-ai`) to ONE pack, folding its sub-plugins to
 * skills — so `code`, `code-review`, `judges`, … never surfaced as plugins.
 * Discovery must surface every installed plugin, including bundled sub-plugins
 * and plugins installed directly (no marketplace).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { discoverInstalledPlugins } from "../src/main/packs/component-scanner.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type PluginRow = {
  id: string;
  componentKind: string;
  componentKey: string | null;
  name: string | null;
  version: string | null;
  harness: string | null;
  installPath: string | null;
  externalId: string;
  lastSeenAt: string | null;
  uninstalledAt: string | null;
};

async function writeRegistry(
  claudeHome: string,
  plugins: Record<string, unknown>
): Promise<void> {
  await writeRawRegistry(claudeHome, JSON.stringify({ version: 2, plugins }));
}

async function writeRawRegistry(
  claudeHome: string,
  contents: string
): Promise<void> {
  const pluginsDir = path.join(claudeHome, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(
    path.join(pluginsDir, "installed_plugins.json"),
    contents,
    "utf8"
  );
}

function readPluginRows(prisma: {
  client: {
    $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
  };
}): Promise<PluginRow[]> {
  return prisma.client.$queryRawUnsafe<PluginRow[]>(
    `SELECT id,
        component_kind AS "componentKind",
        component_key AS "componentKey",
        name,
        version,
        harness,
        install_path AS "installPath",
        external_id AS "externalId",
        last_seen_at AS "lastSeenAt",
        uninstalled_at AS "uninstalledAt"
     FROM agent_components
     WHERE component_kind = $1
     ORDER BY component_key ASC`,
    AgentComponentKind.Plugin
  );
}

// A bundled marketplace (folded to skills by the pack path), a per-plugin
// marketplace, and a plugin installed directly into the harness (no `@`).
// Install paths are synthetic relative examples — discovery only stores/compares
// the string, so no real absolute home directory is needed.
const REGISTRY = {
  "code@closedloop-ai": [
    {
      scope: "user",
      installPath: "plugins/cache/closedloop-ai/code/1.14.7",
      version: "1.14.7",
    },
  ],
  "code-review@closedloop-ai": [
    {
      scope: "user",
      installPath: "plugins/cache/closedloop-ai/code-review/3.7.0",
      version: "3.7.0",
    },
  ],
  "pyright-lsp@claude-plugins-official": [
    {
      scope: "user",
      installPath: "plugins/cache/claude-plugins-official/pyright-lsp/1.0.0",
      version: "1.0.0",
    },
  ],
  "direct-plugin": [{ scope: "user", installPath: "plugins/direct/direct" }],
} as const;

async function withClaudeHome<T>(
  fn: (claudeHome: string) => Promise<T>
): Promise<T> {
  const hadHome = Object.hasOwn(process.env, "CLAUDE_HOME");
  const prev = process.env.CLAUDE_HOME;
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "cl-plugins-"));
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

test("discoverInstalledPlugins: surfaces every installed plugin, incl. bundled sub-plugins and marketplace-less installs", async () => {
  await withClaudeHome(async (claudeHome) => {
    await writeRegistry(claudeHome, REGISTRY);
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverInstalledPlugins(prisma);
      assert.equal(summary.discovered, 4);
      assert.equal(summary.tombstoned, 0);

      const rows = await readPluginRows(prisma);
      // Every installed plugin is its own plugin row — the bundled
      // closedloop-ai sub-plugins are NOT collapsed to a single pack.
      assert.deepEqual(
        rows.map((r) => r.componentKey),
        ["code", "code-review", "direct-plugin", "pyright-lsp"]
      );
      for (const row of rows) {
        assert.equal(row.componentKind, AgentComponentKind.Plugin);
        assert.equal(row.harness, "claude");
        assert.equal(row.uninstalledAt, null);
        assert.ok(row.installPath && row.installPath.length > 0);
      }
      // Version is captured when present, null for the marketplace-less install.
      const byKey = new Map(rows.map((r) => [r.componentKey, r]));
      assert.equal(byKey.get("code")?.version, "1.14.7");
      assert.equal(byKey.get("direct-plugin")?.version, null);
    } finally {
      await close();
    }
  });
});

test("discoverInstalledPlugins: idempotent re-run and tombstones a removed plugin without touching survivors", async () => {
  await withClaudeHome(async (claudeHome) => {
    await writeRegistry(claudeHome, REGISTRY);
    const { prisma, close } = await openTestPrisma();
    try {
      await discoverInstalledPlugins(prisma);
      // Re-run against the same registry: idempotent, no new rows.
      const second = await discoverInstalledPlugins(prisma);
      assert.equal(second.discovered, 4);
      assert.equal(second.tombstoned, 0);
      assert.equal((await readPluginRows(prisma)).length, 4);

      // Uninstall `code-review`: it should tombstone, the rest survive.
      const remaining = Object.fromEntries(
        Object.entries(REGISTRY).filter(
          ([ref]) => ref !== "code-review@closedloop-ai"
        )
      );
      await writeRegistry(claudeHome, remaining);
      const third = await discoverInstalledPlugins(prisma);
      assert.equal(third.tombstoned, 1);

      const rows = await readPluginRows(prisma);
      const codeReview = rows.find((r) => r.componentKey === "code-review");
      assert.ok(codeReview?.uninstalledAt, "removed plugin is tombstoned");
      const survivors = rows.filter((r) => r.uninstalledAt === null);
      assert.deepEqual(survivors.map((r) => r.componentKey).sort(), [
        "code",
        "direct-plugin",
        "pyright-lsp",
      ]);
    } finally {
      await close();
    }
  });
});

test("discoverInstalledPlugins: missing registry degrades to a no-op", async () => {
  await withClaudeHome(async () => {
    // No installed_plugins.json written.
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverInstalledPlugins(prisma);
      assert.deepEqual(summary, { discovered: 0, tombstoned: 0 });
      assert.equal((await readPluginRows(prisma)).length, 0);
    } finally {
      await close();
    }
  });
});

test("discoverInstalledPlugins: a plugin installed under multiple scopes collapses to one row", async () => {
  await withClaudeHome(async (claudeHome) => {
    await writeRegistry(claudeHome, {
      "code@closedloop-ai": [
        {
          scope: "user",
          installPath: "plugins/cache/closedloop-ai/code/1.0.0",
          version: "1.0.0",
        },
        {
          scope: "project",
          installPath: "proj/.claude/plugins/cache/closedloop-ai/code/1.0.0",
          version: "1.0.0",
        },
      ],
    });
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverInstalledPlugins(prisma);
      // Both scope entries share one external_id → one distinct plugin row.
      assert.equal(summary.discovered, 1);
      const rows = await readPluginRows(prisma);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.componentKey, "code");
    } finally {
      await close();
    }
  });
});

test("discoverInstalledPlugins: a corrupt registry is a no-op and does NOT tombstone the existing inventory", async () => {
  await withClaudeHome(async (claudeHome) => {
    await writeRegistry(claudeHome, REGISTRY);
    const { prisma, close } = await openTestPrisma();
    try {
      // Seed a healthy inventory from a valid registry.
      const seeded = await discoverInstalledPlugins(prisma);
      assert.equal(seeded.discovered, 4);
      assert.equal((await readPluginRows(prisma)).length, 4);

      // The registry file is now unreadable (partial/corrupt JSON, e.g. a
      // concurrent rewrite). Discovery must be a no-op: nothing discovered,
      // nothing tombstoned — the existing plugins stay installed.
      await writeRawRegistry(claudeHome, '{"version":2,"plugins":{');
      const corrupt = await discoverInstalledPlugins(prisma);
      assert.deepEqual(corrupt, { discovered: 0, tombstoned: 0 });

      const rows = await readPluginRows(prisma);
      assert.equal(rows.length, 4);
      for (const row of rows) {
        assert.equal(
          row.uninstalledAt,
          null,
          "corrupt registry must not tombstone survivors"
        );
      }
    } finally {
      await close();
    }
  });
});

test("discoverInstalledPlugins: gstack/bmad-method are owned by dedicated scanners and are not discovered here", async () => {
  await withClaudeHome(async (claudeHome) => {
    await writeRegistry(claudeHome, {
      // Owned by the dedicated gstack scanner — via marketplace name.
      "some-plugin@gstack": [
        {
          scope: "user",
          installPath: "plugins/cache/gstack/some-plugin/1.0.0",
        },
      ],
      // Owned by the dedicated bmad scanner — via plugin name.
      "bmad-method@claude-plugins-official": [
        {
          scope: "user",
          installPath: "plugins/cache/official/bmad-method/1.0.0",
        },
      ],
      // A normal plugin that SHOULD be discovered.
      "pyright-lsp@claude-plugins-official": [
        {
          scope: "user",
          installPath: "plugins/cache/official/pyright-lsp/1.0.0",
          version: "1.0.0",
        },
      ],
    });
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverInstalledPlugins(prisma);
      assert.equal(summary.discovered, 1);
      const rows = await readPluginRows(prisma);
      assert.deepEqual(
        rows.map((r) => r.componentKey),
        ["pyright-lsp"]
      );
    } finally {
      await close();
    }
  });
});

test("discoverInstalledPlugins: component id is stable across an install-path change (identity ≠ install location)", async () => {
  await withClaudeHome(async (claudeHome) => {
    await writeRegistry(claudeHome, {
      "code@closedloop-ai": [
        {
          scope: "user",
          installPath: "plugins/cache/closedloop-ai/code/1.0.0",
          version: "1.0.0",
        },
      ],
    });
    const { prisma, close } = await openTestPrisma();
    try {
      await discoverInstalledPlugins(prisma);
      const before = await readPluginRows(prisma);
      assert.equal(before.length, 1);
      const originalId = before[0]?.id;

      // Reinstall the SAME plugin to a NEW path (e.g. a version bump). The
      // stable identity (external_id) is unchanged, so the row must be UPDATED
      // in place — same id, new install_path — not duplicated under a new id.
      await writeRegistry(claudeHome, {
        "code@closedloop-ai": [
          {
            scope: "user",
            installPath: "plugins/cache/closedloop-ai/code/2.0.0",
            version: "2.0.0",
          },
        ],
      });
      await discoverInstalledPlugins(prisma);

      const after = await readPluginRows(prisma);
      assert.equal(
        after.length,
        1,
        "install-path change must not fork identity"
      );
      assert.equal(after[0]?.id, originalId);
      assert.equal(
        after[0]?.installPath,
        "plugins/cache/closedloop-ai/code/2.0.0"
      );
      assert.equal(after[0]?.uninstalledAt, null);
    } finally {
      await close();
    }
  });
});

test("discoverInstalledPlugins: a tombstone advances last_seen_at so the sync cursor re-selects the uninstall", async () => {
  await withClaudeHome(async (claudeHome) => {
    await writeRegistry(claudeHome, REGISTRY);
    const { prisma, close } = await openTestPrisma();
    try {
      await discoverInstalledPlugins(prisma);
      const codeReviewBefore = (await readPluginRows(prisma)).find(
        (r) => r.componentKey === "code-review"
      );
      assert.ok(codeReviewBefore?.lastSeenAt);

      // Uninstall `code-review`, then discover again.
      const remaining = Object.fromEntries(
        Object.entries(REGISTRY).filter(
          ([ref]) => ref !== "code-review@closedloop-ai"
        )
      );
      await writeRegistry(claudeHome, remaining);
      const summary = await discoverInstalledPlugins(prisma);
      assert.equal(summary.tombstoned, 1);

      const codeReviewAfter = (await readPluginRows(prisma)).find(
        (r) => r.componentKey === "code-review"
      );
      // The component-sync cursor pages by (last_seen_at, id); a tombstone that
      // left last_seen_at behind the watermark would never sync. It must move
      // forward with the tombstone.
      assert.ok(codeReviewAfter?.uninstalledAt);
      assert.ok(
        codeReviewAfter?.lastSeenAt &&
          codeReviewAfter.lastSeenAt >= (codeReviewBefore?.lastSeenAt ?? ""),
        "tombstone must advance last_seen_at"
      );
      assert.equal(
        codeReviewAfter?.lastSeenAt,
        codeReviewAfter?.uninstalledAt,
        "tombstone stamps last_seen_at and uninstalled_at with the same now"
      );
    } finally {
      await close();
    }
  });
});
