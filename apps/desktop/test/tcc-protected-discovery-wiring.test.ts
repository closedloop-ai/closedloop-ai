/**
 * @file tcc-protected-discovery-wiring.test.ts
 * @description ISS-11914: the discovery passes that look inside recent session
 * cwds (pack, MCP and definition discovery, live definition capture, Session
 * Mesh workspace resolution, code-review findings attribution) must not read
 * inside a TCC-protected folder, which raises a macOS permission prompt. Each
 * case seeds the same content under `<home>/Documents/proj` and under a plain
 * `<home>/code/proj`, drives the production entry point, and asserts only the
 * plain copy is read. A bare existence check stays allowed (ISS-11914 probe),
 * so the stat-only GStack marker is still found in the protected folder.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type * as NodeFs from "node:fs";
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createNormalizedSession,
  HarnessImportMode,
} from "@repo/lib/harness/types";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { hermeticGitEnv } from "../scripts/hermetic-git-env.mjs";
import { stampCodeReviewFindingsOnCandidates } from "../src/main/database/component-invocation-findings-attribution.js";
import { readClaudeInstalledPluginRegistry } from "../src/main/packs/claude-plugin-registry.js";
import { captureInvocationDefinitionEvidence } from "../src/main/packs/definition-content-collector.js";
import {
  discoverDefinitions,
  resolveDefinitionRoots,
} from "../src/main/packs/definition-discovery.js";
import { discoverMcpServersFromDefaults } from "../src/main/packs/mcp-discovery.js";
import {
  computePackScan,
  type PackScannerDb,
} from "../src/main/packs/pack-scanner.js";
import { resolveSessionMeshWorkspace } from "../src/main/session-mesh/session-mesh-workspace.js";
import { initGitRepoWithOrigin } from "./attribution-test-helpers.js";
import {
  envelopeNaming,
  reviewSession,
  writeEnvelope,
} from "./helpers/code-review-findings-locator.js";

// The readers import `readdirSync` by name. `vi.spyOn(fs, …)` plus
// `syncBuiltinESMExports()` stops reaching that binding under the dd-trace
// NODE_OPTIONS that pr-test.yml sets for merge-group and scheduled runs, so the
// spy saw no calls there. A module mock reaches it with or without dd-trace.
const mocks = vi.hoisted(() => ({ readdirSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  mocks.readdirSync.mockImplementation(actual.readdirSync);
  return { ...actual, readdirSync: mocks.readdirSync };
});

const TCC_PROTECTED_CWD_RE = /TCC-protected cwd/;
const SKILL_INVOKED_AT = "2026-10-06T10:00:01.000Z";
const SKILL_MODIFIED_AT = new Date("2026-10-06T10:00:00.000Z");
const ENV_KEYS = ["CLAUDE_HOME", "CODEX_HOME"] as const;

let fakeHome: string;
let protectedRoot: string;
let plainRoot: string;
let savedEnv: Map<string, string | undefined>;

beforeEach(async () => {
  fakeHome = realpathSync(
    await mkdtemp(path.join(os.tmpdir(), "iss11914-discovery-"))
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
  protectedRoot = path.join(fakeHome, "Documents", "proj");
  plainRoot = path.join(fakeHome, "code", "proj");
  mkdirSync(protectedRoot, { recursive: true });
  mkdirSync(plainRoot, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv.has(key)) {
      process.env[key] = savedEnv.get(key);
    } else {
      Reflect.deleteProperty(process.env, key);
    }
  }
  await rm(fakeHome, { recursive: true, force: true });
});

describe("pack discovery over recent session cwds", () => {
  test("detects BMad only outside the protected folder, but still stats the GStack marker", async () => {
    for (const root of [protectedRoot, plainRoot]) {
      seedFile(
        [root, ".agents", "skills", "bmad-help", "SKILL.md"],
        "---\nname: bmad-help\n---\nHelp.\n"
      );
    }
    seedFile([protectedRoot, ".gstack", "conductor.json"], "{}");

    const result = await computePackScan(
      { recentProjectRoots: [protectedRoot, plainRoot] },
      {
        scanGStack: async () => ({ installs: 0, skills: 0 }),
        scanClaudeMarketplaces: async () => ({
          installs: 0,
          skills: 0,
          marketplaces: 0,
        }),
        runCatalogDetectorAdapters: async () => ({}),
      }
    );

    assert.deepEqual(
      result.plan.associations
        .map((row) => `${row.pack_id} ${row.project_path}`)
        .sort(),
      [`bmad-method ${plainRoot}`, `gstack ${protectedRoot}`]
    );
  });

  test("MCP discovery reads .mcp.json only outside the protected folder", async () => {
    seedFile(
      [protectedRoot, ".mcp.json"],
      JSON.stringify({ mcpServers: { "documents-server": { command: "x" } } })
    );
    seedFile(
      [plainRoot, ".mcp.json"],
      JSON.stringify({ mcpServers: { "code-server": { command: "x" } } })
    );

    const summary = await discoverMcpServersFromDefaults(
      recentRootsDb([protectedRoot, plainRoot])
    );

    assert.equal(summary.discovered, 1);
  });

  test("definition discovery roots leave out the protected project", () => {
    const { scanRoots } = resolveDefinitionRoots([protectedRoot, plainRoot]);

    const projectPaths = [
      ...(scanRoots.skillRoots ?? []),
      ...(scanRoots.claudeRoots ?? []),
      ...(scanRoots.openCodeRoots ?? []),
    ].flatMap((root) =>
      typeof root === "string" || !root.projectPath ? [] : [root.projectPath]
    );
    assert.deepEqual([...new Set(projectPaths)], [plainRoot]);
  });

  test("definition discovery from a session run in the home dir walks past the protected folders", () => {
    const library = path.join(fakeHome, "Library");
    for (const [root, name] of [
      [protectedRoot, "hidden-skill"],
      [path.join(library, "Application Support", "AddressBook"), "contacts"],
      [path.join(library, "Calendars"), "calendars"],
      [
        path.join(library, "Group Containers", "group.com.apple.reminders"),
        "reminders",
      ],
      [plainRoot, "visible-skill"],
      [path.join(library, "Application Support", "Other"), "other-app"],
    ]) {
      seedFile(
        [root, ".claude", "skills", name, "SKILL.md"],
        `---\nname: ${name}\n---\nBody.\n`
      );
    }

    const seeded = new Set([
      "hidden-skill",
      "contacts",
      "calendars",
      "reminders",
      "visible-skill",
      "other-app",
    ]);
    const names = discoverDefinitions(
      resolveDefinitionRoots([fakeHome]).scanRoots
    )
      .map((found) => found.primary.name)
      .filter((name) => seeded.has(name))
      .sort();

    assert.deepEqual(names, ["other-app", "visible-skill"]);
  });

  test("a recent root that is a symlink into a protected folder is not read", async () => {
    seedFile(
      [protectedRoot, ".agents", "skills", "bmad-help", "SKILL.md"],
      "---\nname: bmad-help\n---\nHelp.\n"
    );
    seedFile(
      [protectedRoot, ".mcp.json"],
      JSON.stringify({ mcpServers: { "documents-server": { command: "x" } } })
    );
    const link = path.join(fakeHome, "code", "link");
    symlinkSync(protectedRoot, link);

    const scan = await computePackScan(
      { recentProjectRoots: [link] },
      {
        scanGStack: async () => ({ installs: 0, skills: 0 }),
        scanClaudeMarketplaces: async () => ({
          installs: 0,
          skills: 0,
          marketplaces: 0,
        }),
        runCatalogDetectorAdapters: async () => ({}),
      }
    );
    const mcp = await discoverMcpServersFromDefaults(recentRootsDb([link]));
    const { scanRoots } = resolveDefinitionRoots([link]);

    assert.deepEqual(scan.plan, { packs: [], skills: [], associations: [] });
    assert.equal(mcp.discovered, 0);
    assert.deepEqual(
      (scanRoots.skillRoots ?? []).flatMap((root) =>
        typeof root === "string" || !root.projectPath ? [] : [root.projectPath]
      ),
      []
    );
  });
});

describe("a BMad skill linked into a protected folder", () => {
  test("is not read from a plain project", async () => {
    seedFile(
      [plainRoot, ".agents", "skills", "bmad-help", "SKILL.md"],
      "---\nname: bmad-help\n---\nHelp.\n"
    );
    const target = path.join(fakeHome, "Documents", "skill");
    seedFile([target, "SKILL.md"], "---\nname: bmad-linked\n---\nPrivate.\n");
    symlinkSync(
      target,
      path.join(plainRoot, ".agents", "skills", "bmad-linked")
    );

    const scan = await computePackScan(
      { recentProjectRoots: [plainRoot] },
      {
        scanGStack: async () => ({ installs: 0, skills: 0 }),
        scanClaudeMarketplaces: async () => ({
          installs: 0,
          skills: 0,
          marketplaces: 0,
        }),
        runCatalogDetectorAdapters: async () => ({}),
      }
    );

    assert.deepEqual(
      [...new Set(scan.plan.skills.map((row) => row.name))],
      ["bmad-help"]
    );
  });
});

describe("a harness home or config inside a protected folder", () => {
  test("definition discovery and live capture read the Claude home only outside it", () => {
    const readFrom = (home: string) => {
      process.env.CLAUDE_HOME = home;
      seedFile([home, "agents", "planner.md"], "---\nname: planner\n---\n");
      seedFile([home, "commands", "ship.md"], "---\nname: ship\n---\n");
      const skill = path.join(home, "skills", "review", "SKILL.md");
      seedFile([skill], "---\nname: review\n---\nReview it.\n");
      utimesSync(skill, SKILL_MODIFIED_AT, SKILL_MODIFIED_AT);
      const seeded = new Set(["planner", "/ship", "review"]);
      mocks.readdirSync.mockClear();
      const names = discoverDefinitions(resolveDefinitionRoots([]).scanRoots)
        .map((found) => found.primary.name)
        .filter((name) => seeded.has(name))
        .sort();
      const evidence = captureInvocationDefinitionEvidence(
        createNormalizedSession({
          sessionId: `home-${path.basename(path.dirname(home))}`,
          cwd: plainRoot,
          skills: [
            {
              name: "review",
              timestamp: SKILL_INVOKED_AT,
              providerToolUseId: "toolu_review",
            },
          ],
        }),
        {
          importMode: HarnessImportMode.LiveWatcher,
          now: () => new Date("2026-10-06T10:00:02.000Z"),
        }
      );
      const listed = mocks.readdirSync.mock.calls.some(([dir]) =>
        String(dir).startsWith(home)
      );
      return { names, evidence: evidence.length, listed };
    };

    assert.deepEqual(readFrom(path.join(fakeHome, "Documents", ".claude")), {
      names: [],
      evidence: 0,
      listed: false,
    });
    assert.deepEqual(readFrom(path.join(fakeHome, "code", ".claude")), {
      names: ["/ship", "planner", "review"],
      evidence: 1,
      listed: true,
    });
  });

  test("the plugin registry in a protected Claude home is unreadable, not empty", () => {
    const statusIn = (home: string) => {
      process.env.CLAUDE_HOME = home;
      seedFile([home, "plugins", "installed_plugins.json"], '{"plugins":{}}');
      return readClaudeInstalledPluginRegistry().status;
    };

    assert.equal(
      statusIn(path.join(fakeHome, "Documents", ".claude")),
      "unreadable"
    );
    assert.equal(statusIn(path.join(fakeHome, "code", ".claude")), "ok");
  });

  test("MCP discovery reads the user Claude and Codex configs only outside it", async () => {
    const discoveredIn = async (dir: string) => {
      process.env.CLAUDE_HOME = path.join(dir, ".claude");
      process.env.CODEX_HOME = path.join(dir, ".codex");
      seedFile(
        [dir, ".claude.json"],
        JSON.stringify({ mcpServers: { "claude-user": { command: "x" } } })
      );
      seedFile([dir, ".codex", "config.toml"], "[mcp_servers.codex-user]\n");
      return (await discoverMcpServersFromDefaults(recentRootsDb([])))
        .discovered;
    };

    assert.equal(
      await discoveredIn(path.join(fakeHome, "Library", "CloudStorage", "Box")),
      0
    );
    assert.equal(await discoveredIn(path.join(fakeHome, "code", "homes")), 2);
  });
});

describe("GStack installed for Codex", () => {
  test("a skill linked into a protected repo reads no VERSION and runs no git; a plain one does", async () => {
    const codexPackFor = async (repo: string) => {
      seedFile([repo, "VERSION"], "1.2.3\n");
      seedFile([repo, "review", "SKILL.md"], "---\nname: review\n---\n");
      initGitRepoWithOrigin(repo, "acme/widget");
      const link = path.join(fakeHome, ".codex", "skills", "gstack-review");
      rmSync(link, { recursive: true, force: true });
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(path.join(repo, "review"), link);
      const scan = await computePackScan(
        { recentProjectRoots: [] },
        {
          scanBmad: async () => ({ installs: 0, skills: 0, projects: 0 }),
          scanClaudeMarketplaces: async () => ({
            installs: 0,
            skills: 0,
            marketplaces: 0,
          }),
          scanProjectGStackAssociations: async () => 0,
          runCatalogDetectorAdapters: async () => ({}),
        }
      );
      return {
        pack: scan.plan.packs.find((row) => row.harness === "codex"),
        skills: scan.plan.skills.length,
      };
    };

    const plain = await codexPackFor(path.join(fakeHome, "code", "gstack"));
    const guarded = await codexPackFor(
      path.join(fakeHome, "Documents", "gstack")
    );

    assert.equal(plain.pack?.version, "1.2.3");
    assert.ok(plain.pack?.source_url);
    assert.equal(plain.skills, 1);
    assert.equal(guarded.pack?.version, null);
    assert.equal(guarded.pack?.source_url, null);
    assert.equal(guarded.skills, 0);
  });
});

describe("live definition capture", () => {
  test("reads a project skill only outside the protected folder", () => {
    const evidenceFor = (cwd: string) => {
      seedFile(
        [cwd, ".claude", "skills", "review", "SKILL.md"],
        "---\nname: review\n---\nReview it.\n"
      );
      utimesSync(
        path.join(cwd, ".claude", "skills", "review", "SKILL.md"),
        SKILL_MODIFIED_AT,
        SKILL_MODIFIED_AT
      );
      return captureInvocationDefinitionEvidence(
        createNormalizedSession({
          sessionId: `live-${path.basename(path.dirname(cwd))}`,
          cwd,
          skills: [
            {
              name: "review",
              timestamp: SKILL_INVOKED_AT,
              providerToolUseId: "toolu_review",
            },
          ],
        }),
        {
          importMode: HarnessImportMode.LiveWatcher,
          now: () => new Date("2026-10-06T10:00:02.000Z"),
        }
      );
    };

    assert.deepEqual(evidenceFor(protectedRoot), []);
    assert.equal(evidenceFor(plainRoot).length, 1);
  });
});

describe("Session Mesh workspace resolution", () => {
  // Without the guard the git calls run and fail on this origin-less repo with
  // git's own message, so matching the guard's message is what pins the guard.
  test("refuses a protected cwd before running git", async () => {
    execFileSync("git", ["init", "-q"], {
      cwd: protectedRoot,
      env: hermeticGitEnv(),
      stdio: "pipe",
    });

    await assert.rejects(
      resolveSessionMeshWorkspace(protectedRoot),
      TCC_PROTECTED_CWD_RE
    );
  });
});

describe("code-review findings attribution", () => {
  test("counts a run under the protected folder as unreadable without reading it", async () => {
    for (const root of [protectedRoot, plainRoot]) {
      await writeEnvelope(root, envelopeNaming("auditor"));
    }

    const protectedStamp = await stampCodeReviewFindingsOnCandidates(
      reviewSession("session-protected", protectedRoot),
      []
    );
    const plainStamp = await stampCodeReviewFindingsOnCandidates(
      reviewSession("session-plain", plainRoot),
      []
    );

    assert.equal(protectedStamp.unreadableRuns, 1);
    assert.equal(plainStamp.unreadableRuns, 0);
  });
});

function seedFile(segments: string[], body: string): void {
  const file = path.join(...segments);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

/** Just enough of the store for `getRecentProjectRoots` and the MCP upserts. */
function recentRootsDb(roots: string[]): PackScannerDb {
  return {
    client: {
      session: {
        findMany: async () => roots.map((cwd) => ({ cwd })),
      },
    },
    write: async () => 0,
  } as unknown as PackScannerDb;
}
