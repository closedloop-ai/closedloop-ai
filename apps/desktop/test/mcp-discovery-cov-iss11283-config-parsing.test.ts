/**
 * @file mcp-discovery-cov-iss11283-config-parsing.test.ts
 * @description ISS-11283 lane D branch-coverage addendum for
 * `packs/mcp-discovery.ts`. The existing `mcp-discovery.test.ts` covers the
 * discovery/fold/tombstone happy paths against real Claude JSON and Codex
 * TOML configs; this file targets the config-parsing edge shapes and write
 * failures it leaves alone: a non-regular-file config path, an empty config
 * file, a JSON config whose top level or `mcpServers` value is not a plain
 * object, a single-quoted Codex TOML header name, folding the SAME server
 * observed twice under the SAME harness in one scan, and the upsert/
 * tombstone write-failure catches.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { describe, it, vi } from "vitest";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { ComponentScope } from "../src/main/packs/definition-content-collector.js";
import { discoverMcpServers } from "../src/main/packs/mcp-discovery.js";
import { openTestPrisma } from "./prisma-test-utils.js";

function mcpRows(
  prisma: DesktopPrisma
): Promise<Array<{ externalId: string; harness: string | null }>> {
  return prisma.write((client) =>
    client.$queryRawUnsafe<
      Array<{ externalId: string; harness: string | null }>
    >(
      `SELECT external_id AS "externalId", harness
         FROM agent_components
        WHERE component_kind = ?
        ORDER BY external_id`,
      AgentComponentKind.Mcp
    )
  );
}

describe("discoverMcpServers: safeReadMcpConfig on a non-regular-file path", () => {
  it("skips a config path that is a directory rather than a file", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-cov-dir-"));
    const configPath = path.join(home, "not-a-file.json");
    // A directory at the config path — `fstatSync(fd).isFile()` is false, so
    // the read must return null (skip) rather than trying to parse directory
    // bytes as JSON.
    //
    // NOTE (mutation equivalence): a mutant that disables this `isFile()`
    // check survives against this test with no observable difference —
    // verified empirically that `readSync` on a directory fd throws EISDIR,
    // which the surrounding `catch { return null; }` in `safeReadMcpConfig`
    // catches and turns into the SAME `null` result the direct check would
    // have returned. The check is a (cheaper) short-circuit, not a
    // behavior-changing guard, for a directory target.
    mkdirSync(configPath, { recursive: true });
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverMcpServers(prisma, {
        claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }],
      });

      assert.equal(summary.discovered, 0);
      assert.equal(summary.upserted, 0);
    } finally {
      await close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("discoverMcpServers: an empty config file", () => {
  it("treats a zero-byte config file as no servers, not a parse failure", async () => {
    // NOTE (mutation equivalence): a mutant that disables `if (size === 0) {
    // return ""; }` also survives with no observable difference — for a
    // genuinely 0-byte file the fallback path (`Buffer.allocUnsafe(0)`, a
    // read loop that never iterates since `0 < 0` is false, then
    // `buffer.toString("utf8", 0, 0)`) independently produces the identical
    // `""`. The early return is a micro-optimization skipping a 0-byte
    // allocation, not a behavior fork.
    const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-cov-empty-"));
    const configPath = path.join(home, ".claude.json");
    writeFileSync(configPath, "");
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverMcpServers(prisma, {
        claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }],
      });

      assert.equal(summary.discovered, 0);
    } finally {
      await close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("discoverMcpServers: a JSON config whose shape is not a server map", () => {
  it("yields no servers when the parsed top level is a primitive, not an object", async () => {
    // NOTE (mutation equivalence): a mutant that disables the SECOND operand
    // (`typeof parsed !== "object"`) of this guard also survives with no
    // observable difference for a number/string/boolean input — every JS
    // primitive except `null`/`undefined` auto-boxes on property access, so
    // `(42).mcpServers` reads `undefined` (no throw) rather than crashing,
    // and `serverNamesFromJson`'s OWN downstream shape check on `servers`
    // independently rejects `undefined` the same way. `undefined` itself is
    // unreachable here (a `JSON.parse` result is never `undefined`, and a
    // literal `undefined` fails to parse before this function is ever
    // called), so the ONLY value this second operand is load-bearing for is
    // `null` — already covered by the SEPARATE "literal null" case below.
    const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-cov-prim-"));
    const configPath = path.join(home, ".claude.json");
    writeFileSync(configPath, "42");
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverMcpServers(prisma, {
        claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }],
      });

      assert.equal(summary.discovered, 0);
    } finally {
      await close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not throw when the parsed top level is a literal null", async () => {
    // `parsed === null` must be checked BEFORE `(parsed as
    // Record<string,unknown>).mcpServers` is read: skipping the guard would
    // throw synchronously reading a property off `null`, uncaught by
    // anything in `discoverFromJsonConfig` (only `JSON.parse` itself is
    // wrapped in a try/catch) — a genuinely different outcome from the
    // number/array cases above, which happen to fail the SAME check by a
    // different route and would survive a mutant here undetected.
    const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-cov-litnull-"));
    const configPath = path.join(home, ".claude.json");
    writeFileSync(configPath, "null");
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverMcpServers(prisma, {
        claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }],
      });

      assert.equal(summary.discovered, 0);
    } finally {
      await close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("yields no servers when mcpServers is an array instead of a map", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-cov-arr-"));
    const configPath = path.join(home, ".claude.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: ["context7"] }));
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverMcpServers(prisma, {
        claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }],
      });

      assert.equal(
        summary.discovered,
        0,
        "an array would otherwise yield spurious numeric-index server names via Object.keys"
      );
    } finally {
      await close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("yields no servers when mcpServers is null", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-cov-null-"));
    const configPath = path.join(home, ".claude.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: null }));
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverMcpServers(prisma, {
        claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }],
      });

      assert.equal(summary.discovered, 0);
    } finally {
      await close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("discoverMcpServers: a single-quoted Codex TOML header name", () => {
  it("captures the server name from a single-quoted [mcp_servers.'name'] header", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-cov-toml-"));
    const codexHome = path.join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const configPath = path.join(codexHome, "config.toml");
    writeFileSync(
      configPath,
      ["[mcp_servers.'single-quoted']", "command = 'run'"].join("\n")
    );
    const priorCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverMcpServers(prisma, { includeCodex: true });

      assert.equal(summary.discovered, 1);
      const rows = await mcpRows(prisma);
      assert.deepEqual(
        rows.map((r) => r.externalId),
        ["single-quoted"]
      );
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
});

describe("discoverMcpServers: folding the same server under the SAME harness twice in one scan", () => {
  it("leaves the harness unchanged when a second Claude root repeats an already-folded server", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-cov-samefold-"));
    const userConfig = path.join(home, ".claude.json");
    const projectConfig = path.join(home, "project.mcp.json");
    // BOTH roots are Claude JSON configs declaring the SAME server name, in
    // the SAME `discoverMcpServers` call — `foldServer`'s existing branch
    // (`existing.harness !== next.harness`) is false here, so the harness
    // must stay `claude`, never flip or get re-derived.
    writeFileSync(
      userConfig,
      JSON.stringify({ mcpServers: { shared: { command: "run-a" } } })
    );
    writeFileSync(
      projectConfig,
      JSON.stringify({ mcpServers: { shared: { command: "run-b" } } })
    );
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await discoverMcpServers(prisma, {
        claudeJsonConfigs: [
          { path: userConfig, scope: ComponentScope.User },
          { path: projectConfig, scope: ComponentScope.Project },
        ],
      });

      assert.equal(
        summary.discovered,
        1,
        "the same server name across two Claude roots folds to one entry"
      );
      const rows = await mcpRows(prisma);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].harness, Harness.Claude);
    } finally {
      await close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("promotes to Harness.Both when the SAME server is observed under Claude and Codex in ONE call", async () => {
    // The sibling of the same-harness case above: here `existing.harness !==
    // next.harness` genuinely evaluates true (claude vs codex), so a mutant
    // that disables the fold's `if` unconditionally is caught by the harness
    // staying stuck at whichever root happened to be folded first, instead
    // of promoting to `both`.
    const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-cov-dualfold-"));
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
      const summary = await discoverMcpServers(prisma, {
        claudeJsonConfigs: [{ path: claudeConfig, scope: ComponentScope.User }],
        includeCodex: true,
      });

      assert.equal(summary.discovered, 1);
      const rows = await mcpRows(prisma);
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
});

describe("discoverMcpServers: write failures against a real store", () => {
  it("logs and skips both the per-server upsert and the tombstone-scan failure when agent_components cannot be written", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "mcpdisc-cov-fail-"));
    const configPath = path.join(home, ".claude.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { context7: { command: "npx" } } })
    );
    const { prisma, close } = await openTestPrisma();
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // no-op
    });
    try {
      await prisma.write((client) =>
        client.$executeRawUnsafe("DROP TABLE agent_components")
      );

      const summary = await discoverMcpServers(prisma, {
        claudeJsonConfigs: [{ path: configPath, scope: ComponentScope.User }],
      });

      assert.equal(summary.upserted, 0);
      assert.equal(summary.skipped, 1);
      assert.equal(summary.tombstoned, 0);
      const messages = warnSpy.mock.calls.map(([, m]) => String(m));
      assert.ok(
        messages.some((m) =>
          m.includes('failed to upsert mcp server "context7"')
        ),
        "the upsert failure must be logged with the server name"
      );
      assert.ok(
        messages.some((m) => m.includes("tombstone absent mcp servers failed")),
        "the tombstone-scan failure must be logged"
      );
    } finally {
      warnSpy.mockRestore();
      await close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
