/**
 * @file pack-scanner-catalog-detectors.test.ts
 * @description ISS-10308 coverage for the catalog-detection adapters in
 * `packs/pack-scanner.ts` — VoltAgent, alirezarezvani, SuperClaude, the
 * official plugins marketplace, binary CLIs (`detectBinaryTool` / rtk),
 * claude-code-router, and the bundled Closedloop web command pack under an
 * Electron `resourcesPath` — plus `runCatalogDetectorAdapters`, the per-phase
 * failure isolation and cooperative pauses of `computePackScan`, and the
 * best-effort failure paths of `getRecentProjectRoots` / `pruneStaleRows`.
 *
 * Detectors read real directory trees under a temp `CLAUDE_HOME`; the binary
 * lookups (`execFileNonBlocking`, `resolveBinaryFromLoginShellSync`) are faked so the
 * probe argv is pinned and no process spawns. Pins current behavior; no
 * source changes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  _internals,
  computePackScan,
  type PackScannerDb,
  type PackScanSink,
  runCatalogDetectorAdapters,
} from "../src/main/packs/pack-scanner.js";
import { deterministicSkillId } from "../src/main/packs/skill-files.js";
import { silenceWarnings } from "./helpers/gateway-log-spies.js";
import {
  overrideEnv,
  runWithSink,
  skillMarkdown,
  sortSkills,
  writeFixtureFile,
} from "./helpers/pack-scanner-fixtures.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const resolveBinaryMock = vi.hoisted(() => vi.fn());

// The probes run through `execFileNonBlocking` (ISS-11414), which takes
// `execFileSync`'s arguments and fails the way it throws; this mock keeps the
// sync-shaped scripts below and turns a throw into the matching rejection.
vi.mock("../src/server/non-blocking-exec.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFileNonBlocking: async (...args: unknown[]) => execFileSyncMock(...args),
}));
vi.mock("../src/server/shell-path.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveBinaryFromLoginShellSync: resolveBinaryMock,
}));

const VOLTAGENT_URL =
  "https://github.com/VoltAgent/awesome-claude-code-subagents";
const ALIREZA_URL = "https://github.com/alirezarezvani/claude-skills";
const SUPERCLAUDE_URL =
  "https://github.com/SuperClaude-Org/SuperClaude_Framework";
const PLUGINS_OFFICIAL_URL =
  "https://github.com/anthropics/claude-plugins-official";
const RTK_URL = "https://github.com/rtk-ai/rtk";
const ROUTER_URL = "https://github.com/musistudio/claude-code-router";
const PROBE_STDIO = ["ignore", "pipe", "ignore"];

const { makeTempDir } = createTempDirManager("pack-scanner-detectors-");
const restores: Array<() => void> = [];

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((command: string) => {
    throw new Error(`${command}: command not found`);
  });
  resolveBinaryMock.mockReset();
  resolveBinaryMock.mockImplementation((bin: string) => ({
    path: bin,
    source: "fallback",
  }));
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
  vi.restoreAllMocks();
});

function setClaudeHome(): string {
  const claudeHome = makeTempDir();
  restores.push(overrideEnv("CLAUDE_HOME", claudeHome));
  return claudeHome;
}

describe("detectVoltagentSubagents", () => {
  test("an absent install returns false and emits nothing", async () => {
    setClaudeHome();
    const { result, plan } = await runWithSink((sink) =>
      _internals.detectVoltagentSubagents(sink)
    );
    assert.equal(result, false);
    assert.deepEqual(plan, { packs: [], skills: [], associations: [] });
  });

  // Pins current behavior; looks odd because a symlinked category dir is
  // skipped (Dirent.isDirectory() is false for a symlink) even though it points
  // at a directory of agents, while the skill walkers elsewhere follow symlinks.
  test("registers the pack and one skill per category agent .md, skipping READMEs, non-.md files and symlinked category dirs", async () => {
    const claudeHome = setClaudeHome();
    const root = path.join(claudeHome, "skills", "voltagent-subagents");
    const category = path.join(root, "categories", "core-dev");
    writeFixtureFile(path.join(category, "backend-developer.md"), "# agent\n");
    writeFixtureFile(path.join(category, "README.md"), "# readme\n");
    writeFixtureFile(path.join(category, "readme-extra.md"), "# readme too\n");
    writeFixtureFile(path.join(category, "notes.txt"), "not an agent\n");
    const linkedAgents = makeTempDir();
    writeFixtureFile(path.join(linkedAgents, "ghost-agent.md"), "# agent\n");
    fs.symlinkSync(
      linkedAgents,
      path.join(root, "categories", "linked"),
      "dir"
    );

    const { result, plan } = await runWithSink((sink) =>
      _internals.detectVoltagentSubagents(sink)
    );

    assert.equal(result, true);
    assert.deepEqual(plan.packs, [
      {
        pack_id: "voltagent-subagents",
        harness: "claude",
        install_path: root,
        install_kind: "directory",
        source_url: VOLTAGENT_URL,
        version: null,
      },
    ]);
    assert.deepEqual(plan.skills, [
      {
        skill_id: deterministicSkillId("claude", root, "backend-developer"),
        pack_id: "voltagent-subagents",
        harness: "claude",
        install_path: path.join(category, "backend-developer.md"),
        name: "backend-developer",
        version: null,
        description: null,
        source_url: VOLTAGENT_URL,
      },
    ]);
  });

  test("an install without a categories/ dir registers the pack and no skills", async () => {
    const claudeHome = setClaudeHome();
    fs.mkdirSync(path.join(claudeHome, "skills", "voltagent-subagents"), {
      recursive: true,
    });
    const { result, plan } = await runWithSink((sink) =>
      _internals.detectVoltagentSubagents(sink)
    );
    assert.equal(result, true);
    assert.equal(plan.packs.length, 1);
    assert.deepEqual(plan.skills, []);
  });
});

describe("detectAlirezaSkills", () => {
  test("an absent install returns false", async () => {
    setClaudeHome();
    const { result, plan } = await runWithSink((sink) =>
      _internals.detectAlirezaSkills(sink)
    );
    assert.equal(result, false);
    assert.deepEqual(plan.packs, []);
  });

  test("registers the pack and every SKILL.md, naming a skill from frontmatter or else its directory", async () => {
    const claudeHome = setClaudeHome();
    const root = path.join(
      claudeHome,
      "skills",
      "alirezarezvani-claude-skills"
    );
    writeFixtureFile(
      path.join(root, "marketing", "seo", "SKILL.md"),
      skillMarkdown({
        name: "seo-optimizer",
        version: "1.1",
        description: "SEO",
      })
    );
    writeFixtureFile(path.join(root, "plain", "SKILL.md"), "no frontmatter\n");

    const { result, plan } = await runWithSink((sink) =>
      _internals.detectAlirezaSkills(sink)
    );

    assert.equal(result, true);
    assert.deepEqual(plan.packs, [
      {
        pack_id: "alirezarezvani-claude-skills",
        harness: "claude",
        install_path: root,
        install_kind: "directory",
        source_url: ALIREZA_URL,
        version: null,
      },
    ]);
    assert.deepEqual(sortSkills(plan.skills), [
      {
        skill_id: deterministicSkillId("claude", root, "plain"),
        pack_id: "alirezarezvani-claude-skills",
        harness: "claude",
        install_path: path.join(root, "plain", "SKILL.md"),
        name: "plain",
        version: null,
        description: null,
        source_url: ALIREZA_URL,
      },
      {
        skill_id: deterministicSkillId("claude", root, "seo-optimizer"),
        pack_id: "alirezarezvani-claude-skills",
        harness: "claude",
        install_path: path.join(root, "marketing", "seo", "SKILL.md"),
        name: "seo-optimizer",
        version: "1.1",
        description: "SEO",
        source_url: ALIREZA_URL,
      },
    ]);
  });
});

describe("detectSuperClaude", () => {
  test("an absent commands/sc dir returns false", async () => {
    setClaudeHome();
    const { result } = await runWithSink((sink) =>
      _internals.detectSuperClaude(sink)
    );
    assert.equal(result, false);
  });

  test("registers each command .md as an `sc:`-prefixed skill, skipping READMEs, other files and subdirectories", async () => {
    const claudeHome = setClaudeHome();
    const root = path.join(claudeHome, "commands", "sc");
    writeFixtureFile(path.join(root, "build.md"), "# build\n");
    writeFixtureFile(path.join(root, "README.md"), "# readme\n");
    writeFixtureFile(path.join(root, "notes.txt"), "x\n");
    fs.mkdirSync(path.join(root, "nested.md"), { recursive: true });

    const { result, plan } = await runWithSink((sink) =>
      _internals.detectSuperClaude(sink)
    );

    assert.equal(result, true);
    assert.deepEqual(plan.packs, [
      {
        pack_id: "superclaude",
        harness: "claude",
        install_path: root,
        install_kind: "directory",
        source_url: SUPERCLAUDE_URL,
        version: null,
      },
    ]);
    assert.deepEqual(plan.skills, [
      {
        skill_id: deterministicSkillId("claude", root, "sc:build"),
        pack_id: "superclaude",
        harness: "claude",
        install_path: path.join(root, "build.md"),
        name: "sc:build",
        version: null,
        description: null,
        source_url: SUPERCLAUDE_URL,
      },
    ]);
  });
});

describe("detectClaudePluginsOfficial", () => {
  test("an absent marketplace dir returns false", async () => {
    setClaudeHome();
    const { result } = await runWithSink((sink) =>
      _internals.detectClaudePluginsOfficial(sink)
    );
    assert.equal(result, false);
  });

  test("a present marketplace dir registers the pack with no skills", async () => {
    const claudeHome = setClaudeHome();
    const root = path.join(
      claudeHome,
      "plugins",
      "marketplaces",
      "claude-plugins-official"
    );
    fs.mkdirSync(root, { recursive: true });

    const { result, plan } = await runWithSink((sink) =>
      _internals.detectClaudePluginsOfficial(sink)
    );

    assert.equal(result, true);
    assert.deepEqual(plan.packs, [
      {
        pack_id: "claude-plugins-official",
        harness: "claude",
        install_path: root,
        install_kind: "directory",
        source_url: PLUGINS_OFFICIAL_URL,
        version: null,
      },
    ]);
    assert.deepEqual(plan.skills, []);
  });
});

describe("detectBinaryTool", () => {
  test("returns false without running anything when no bin name resolves on the host", async () => {
    const { result, plan } = await runWithSink((sink) =>
      _internals.detectBinaryTool(sink, {
        pack_id: "tool",
        binNames: ["rtk", "ccr"],
        source_url: RTK_URL,
        harnesses: ["claude"],
        versionArgs: ["--version"],
      })
    );
    assert.equal(result, false);
    assert.deepEqual(plan.packs, []);
    assert.deepEqual(resolveBinaryMock.mock.calls, [["rtk"], ["ccr"]]);
    assert.equal(execFileSyncMock.mock.calls.length, 0);
  });

  test("uses the first bin resolved ON the host (not an override), probes its version, and registers one pack per harness", async () => {
    resolveBinaryMock.mockImplementation((bin: string) =>
      bin === "rtk"
        ? { path: "/custom/rtk", source: "override" }
        : { path: "/opt/bin/ccr", source: "known_location" }
    );
    execFileSyncMock.mockImplementation(() =>
      Buffer.from("ccr version 0.12.3 (abc)\n")
    );

    const { result, plan } = await runWithSink((sink) =>
      _internals.detectBinaryTool(sink, {
        pack_id: "tool",
        binNames: ["rtk", "ccr"],
        source_url: RTK_URL,
        harnesses: ["claude", "codex"],
        versionArgs: ["--version"],
      })
    );

    assert.equal(result, true);
    const pack = (harness: string) => ({
      pack_id: "tool",
      harness,
      install_path: "/opt/bin/ccr",
      install_kind: "directory",
      source_url: RTK_URL,
      version: "0.12.3",
    });
    assert.deepEqual(plan.packs, [pack("claude"), pack("codex")]);
    assert.deepEqual(execFileSyncMock.mock.calls, [
      ["/opt/bin/ccr", ["--version"], { stdio: PROBE_STDIO, timeout: 2000 }],
    ]);
  });

  test("a version output without a dotted number, or a failing probe, leaves the version null", async () => {
    resolveBinaryMock.mockImplementation((bin: string) => ({
      path: `/usr/bin/${bin}`,
      source: "path",
    }));
    for (const behave of [
      () => Buffer.from("build 42, v2\n"),
      () => {
        throw new Error("exit 1");
      },
    ]) {
      execFileSyncMock.mockImplementation(behave);
      const { result, plan } = await runWithSink((sink) =>
        _internals.detectBinaryTool(sink, {
          pack_id: "tool",
          binNames: ["rtk"],
          source_url: RTK_URL,
          harnesses: ["claude"],
          versionArgs: ["--version"],
        })
      );
      assert.equal(result, true);
      assert.equal(plan.packs[0]?.version, null);
    }
  });

  test("without version args it never runs the binary, and a null source_url stays null", async () => {
    resolveBinaryMock.mockImplementation((bin: string) => ({
      path: `/usr/bin/${bin}`,
      source: "path",
    }));
    for (const versionArgs of [undefined, []]) {
      const { plan } = await runWithSink((sink) =>
        _internals.detectBinaryTool(sink, {
          pack_id: "tool",
          binNames: ["rtk"],
          source_url: null,
          harnesses: ["claude"],
          versionArgs,
        })
      );
      assert.equal(plan.packs[0]?.version, null);
      assert.equal(plan.packs[0]?.source_url, null);
    }
    assert.equal(execFileSyncMock.mock.calls.length, 0);
  });
});

describe("detectRtk", () => {
  test("registers rtk for claude and codex when the binary is on the login-shell PATH", async () => {
    resolveBinaryMock.mockImplementation(() => ({
      path: "/usr/local/bin/rtk",
      source: "path",
    }));
    execFileSyncMock.mockImplementation(() => Buffer.from("rtk 1.4.0\n"));

    const { result, plan } = await runWithSink((sink) =>
      _internals.detectRtk(sink)
    );

    assert.equal(result, true);
    assert.deepEqual(
      plan.packs.map((p) => [
        p.pack_id,
        p.harness,
        p.install_path,
        p.source_url,
        p.version,
      ]),
      [
        ["rtk", "claude", "/usr/local/bin/rtk", RTK_URL, "1.4.0"],
        ["rtk", "codex", "/usr/local/bin/rtk", RTK_URL, "1.4.0"],
      ]
    );
    assert.deepEqual(resolveBinaryMock.mock.calls, [["rtk"]]);
  });
});

describe("detectClaudeCodeRouter", () => {
  test("a global npm install registers the router without consulting PATH", async () => {
    execFileSyncMock.mockImplementation(() => Buffer.from("/usr/lib\n"));

    const { result, plan } = await runWithSink((sink) =>
      _internals.detectClaudeCodeRouter(sink)
    );

    assert.equal(result, true);
    assert.deepEqual(plan.packs, [
      {
        pack_id: "claude-code-router",
        harness: "claude",
        install_path: "@musistudio/claude-code-router (npm -g)",
        install_kind: "directory",
        source_url: ROUTER_URL,
        version: null,
      },
    ]);
    assert.deepEqual(execFileSyncMock.mock.calls, [
      [
        "npm",
        ["ls", "-g", "--depth=0", "@musistudio/claude-code-router"],
        { stdio: PROBE_STDIO, timeout: 5000 },
      ],
    ]);
    assert.equal(resolveBinaryMock.mock.calls.length, 0);
  });

  test("when npm fails it falls back to the `ccr` binary on the host", async () => {
    resolveBinaryMock.mockImplementation(() => ({
      path: "/opt/bin/ccr",
      source: "known_location",
    }));
    const { result, plan } = await runWithSink((sink) =>
      _internals.detectClaudeCodeRouter(sink)
    );
    assert.equal(result, true);
    assert.equal(plan.packs.length, 1);
    assert.deepEqual(resolveBinaryMock.mock.calls, [["ccr"]]);
  });

  test("when npm fails and `ccr` does not resolve on the host it returns false", async () => {
    const { result, plan } = await runWithSink((sink) =>
      _internals.detectClaudeCodeRouter(sink)
    );
    assert.equal(result, false);
    assert.deepEqual(plan.packs, []);
  });
});

describe("runCatalogDetectorAdapters", () => {
  test("SKIP_CATALOG_DETECTORS=1 returns an empty result without probing anything", async () => {
    restores.push(overrideEnv("SKIP_CATALOG_DETECTORS", "1"));
    const { result, plan } = await runWithSink((sink) =>
      runCatalogDetectorAdapters(sink)
    );
    assert.deepEqual(result, {});
    assert.deepEqual(plan.packs, []);
    assert.equal(resolveBinaryMock.mock.calls.length, 0);
    assert.equal(execFileSyncMock.mock.calls.length, 0);
  });

  test("runs every adapter in order; a throwing adapter reports false and the ones after it still run", async () => {
    restores.push(overrideEnv("SKIP_CATALOG_DETECTORS", undefined));
    setClaudeHome();
    resolveBinaryMock.mockImplementation((bin: string) => {
      if (bin === "ccr") {
        throw new Error("ccr lookup exploded");
      }
      return { path: bin, source: "fallback" };
    });
    const warn = silenceWarnings();

    const { result } = await runWithSink((sink) =>
      runCatalogDetectorAdapters(sink)
    );

    assert.deepEqual(Object.entries(result), [
      ["voltagent-subagents", false],
      ["alirezarezvani-claude-skills", false],
      ["superclaude", false],
      ["claude-code-router", false],
      ["claude-plugins-official", false],
      ["rtk", false],
    ]);
    assert.deepEqual(warn.mock.calls, [
      [
        "catalog-detector",
        "adapter claude-code-router failed: ccr lookup exploded",
      ],
    ]);
    // rtk ran after the throwing adapter.
    assert.deepEqual(resolveBinaryMock.mock.calls, [["ccr"], ["rtk"]]);
  });
});

describe("computePackScan phase isolation and pacing", () => {
  const failAll = () => Promise.reject(new Error("boom"));

  test("every phase failing leaves every scope false and the zero counts, warning once per phase", async () => {
    const warn = silenceWarnings();
    const result = await computePackScan(
      { recentProjectRoots: ["/project"] },
      {
        scanGStack: failAll,
        scanBmad: failAll,
        scanClaudeMarketplaces: failAll,
        scanProjectGStackAssociations: failAll,
        runCatalogDetectorAdapters: failAll,
      }
    );
    assert.deepEqual(result, {
      plan: { packs: [], skills: [], associations: [] },
      counts: {
        gstack: { installs: 0, skills: 0 },
        bmad: { installs: 0, skills: 0, projects: 0 },
        marketplaces: { installs: 0, skills: 0, marketplaces: 0 },
        catalogDetectors: {},
        gstackProjects: 0,
      },
      scopes: {
        gstack: false,
        bmad: false,
        marketplaces: false,
        gstackProjects: false,
        catalogDetectors: false,
      },
    });
    assert.deepEqual(
      warn.mock.calls.map((call) => call[1]),
      [
        "gstack scan failed: boom",
        "bmad scan failed: boom",
        "claude marketplace scan failed: boom",
        "gstack project association scan failed: boom",
        "catalog detectors failed: boom",
      ]
    );
  });

  test("an input cooperativeDelay pauses 25ms before, between and after the five phases", async () => {
    const delay = vi.fn((_ms: number) => Promise.resolve());
    const empty = () =>
      Promise.resolve({ installs: 0, skills: 0, projects: 0, marketplaces: 0 });
    await computePackScan(
      { recentProjectRoots: [], cooperativeDelay: delay },
      {
        scanGStack: empty,
        scanBmad: empty,
        scanClaudeMarketplaces: empty,
        scanProjectGStackAssociations: () => Promise.resolve(0),
        runCatalogDetectorAdapters: () => Promise.resolve({}),
      }
    );
    assert.deepEqual(delay.mock.calls, [[25], [25], [25], [25], [25], [25]]);
  });

  test("an overrides cooperativeDelay wins over the input one", async () => {
    const inputDelay = vi.fn((_ms: number) => Promise.resolve());
    const overrideDelay = vi.fn((_ms: number) => Promise.resolve());
    const empty = () =>
      Promise.resolve({ installs: 0, skills: 0, projects: 0, marketplaces: 0 });
    await computePackScan(
      { recentProjectRoots: [], cooperativeDelay: inputDelay },
      {
        scanGStack: empty,
        scanBmad: empty,
        scanClaudeMarketplaces: empty,
        scanProjectGStackAssociations: () => Promise.resolve(0),
        runCatalogDetectorAdapters: () => Promise.resolve({}),
        cooperativeDelay: overrideDelay,
      }
    );
    assert.equal(inputDelay.mock.calls.length, 0);
    assert.equal(overrideDelay.mock.calls.length, 6);
  });
});

describe("best-effort DB failure paths", () => {
  test("getRecentProjectRoots returns [] when the session read rejects", async () => {
    const db = {
      client: {
        session: { findMany: () => Promise.reject(new Error("closed")) },
      },
    } as unknown as PackScannerDb;
    assert.deepEqual(await _internals.getRecentProjectRoots(db), []);
  });

  test("pruneStaleRows swallows each failed write, attempts all three, and warns for each", async () => {
    const warn = silenceWarnings();
    const write = vi.fn(() => Promise.reject(new Error("database is locked")));
    const db = { write } as unknown as PackScannerDb;

    await _internals.pruneStaleRows(db, "2026-01-01T00:00:00.000Z");

    assert.equal(write.mock.calls.length, 3);
    assert.deepEqual(
      warn.mock.calls.map((call) => call[1]),
      [
        "tombstone agent_packs failed: database is locked",
        "tombstone skills failed: database is locked",
        "prune project_pack_associations failed: database is locked",
      ]
    );
  });
});

describe("non-Error failures are reported by their string form", () => {
  test("computePackScan phases rejecting with a string warn with that string", async () => {
    const warn = silenceWarnings();
    const rejectString = () => Promise.reject("nope");

    const result = await computePackScan(
      { recentProjectRoots: [] },
      {
        scanGStack: rejectString,
        scanBmad: rejectString,
        scanClaudeMarketplaces: rejectString,
        scanProjectGStackAssociations: rejectString,
        runCatalogDetectorAdapters: rejectString,
      }
    );

    assert.deepEqual(Object.values(result.scopes), [
      false,
      false,
      false,
      false,
      false,
    ]);
    assert.deepEqual(
      warn.mock.calls.map((call) => call[1]),
      [
        "gstack scan failed: nope",
        "bmad scan failed: nope",
        "claude marketplace scan failed: nope",
        "gstack project association scan failed: nope",
        "catalog detectors failed: nope",
      ]
    );
  });

  test("pruneStaleRows warns with the string form of a non-Error rejection", async () => {
    const warn = silenceWarnings();
    const db = {
      write: vi.fn(() => Promise.reject("locked")),
    } as unknown as PackScannerDb;

    await _internals.pruneStaleRows(db, "2026-01-01T00:00:00.000Z");

    assert.deepEqual(
      warn.mock.calls.map((call) => call[1]),
      [
        "tombstone agent_packs failed: locked",
        "tombstone skills failed: locked",
        "prune project_pack_associations failed: locked",
      ]
    );
  });

  test("an adapter whose sink write rejects with a string reports false and warns with that string", async () => {
    restores.push(overrideEnv("SKIP_CATALOG_DETECTORS", undefined));
    setClaudeHome();
    resolveBinaryMock.mockImplementation((bin: string) =>
      bin === "rtk"
        ? { path: "/usr/local/bin/rtk", source: "path" }
        : { path: bin, source: "fallback" }
    );
    const warn = silenceWarnings();
    const sink: PackScanSink = {
      pack: () => Promise.reject("sink closed"),
      skill: () => Promise.resolve(),
      association: () => Promise.resolve(),
      recentProjectRoots: () => [],
    };

    const result = await runCatalogDetectorAdapters(sink);

    assert.equal(result.rtk, false);
    assert.deepEqual(warn.mock.calls[0], [
      "catalog-detector",
      "adapter rtk failed: sink closed",
    ]);
  });
});

describe("binary version parsing", () => {
  test("a multi-digit major version is captured whole", async () => {
    resolveBinaryMock.mockImplementation(() => ({
      path: "/usr/bin/rtk",
      source: "path",
    }));
    execFileSyncMock.mockImplementation(() => Buffer.from("rtk 10.12.3\n"));

    const { plan } = await runWithSink((sink) => _internals.detectRtk(sink));

    assert.equal(plan.packs[0]?.version, "10.12.3");
  });
});
