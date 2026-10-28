/**
 * @file pack-scanner-fs-walkers.test.ts
 * @description ISS-10308 coverage for the filesystem walkers in
 * `packs/pack-scanner.ts`: `scanGStack` (Claude directory install and the
 * Codex one-symlink-per-skill layout), `scanBmad` (legacy global plugin, v6+
 * project install, legacy per-project `_bmad/`), `scanProjectGStackAssociations`,
 * and the VERSION / manifest / marketplace readers behind them.
 *
 * The walkers run against real directory trees under a temp `CLAUDE_HOME` /
 * `CODEX_HOME`. Only `execFileNonBlocking` is faked, so the git-remote probe is
 * deterministic and its exact argv is pinned. Pins current behavior; no
 * source changes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  _internals,
  runPackScanner,
  scanBmad,
  scanGStack,
  scanProjectGStackAssociations,
} from "../src/main/packs/pack-scanner.js";
import { deterministicSkillId } from "../src/main/packs/skill-files.js";
import {
  overrideEnv,
  runWithSink,
  skillMarkdown,
  sortSkills,
  writeFixtureFile,
} from "./helpers/pack-scanner-fixtures.js";
import { createTempDirManager } from "./helpers/temp-dir.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());

// The probes run through `execFileNonBlocking` (ISS-11414), which takes
// `execFileSync`'s arguments and fails the way it throws; this mock keeps the
// sync-shaped scripts below and turns a throw into the matching rejection.
vi.mock("../src/server/non-blocking-exec.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFileNonBlocking: async (...args: unknown[]) => execFileSyncMock(...args),
}));

const BMAD_SOURCE_URL = "https://github.com/bmad-code-org/BMAD-METHOD";
const GIT_PROBE_OPTIONS = {
  timeout: 1500,
  stdio: ["ignore", "pipe", "ignore"],
};

const { makeTempDir } = createTempDirManager("pack-scanner-walkers-");
/** Directory (realpath) → `git remote get-url origin` stdout. Absent ⇒ git fails. */
const gitRemotes = new Map<string, string>();
const envRestores: Array<() => void> = [];

beforeEach(() => {
  gitRemotes.clear();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((command: string, args: string[]) => {
    if (command !== "git") {
      throw new Error(`unexpected command ${command}`);
    }
    const url = gitRemotes.get(args[1]);
    if (url === undefined) {
      throw new Error("fatal: not a git repository");
    }
    return Buffer.from(url);
  });
});

afterEach(() => {
  for (const restore of envRestores.splice(0).reverse()) {
    restore();
  }
});

/** Point both harness homes at fresh temp dirs for this test. */
function setHomes(): { claudeHome: string; codexHome: string } {
  const claudeHome = makeTempDir();
  const codexHome = makeTempDir();
  envRestores.push(
    overrideEnv("CLAUDE_HOME", claudeHome),
    overrideEnv("CODEX_HOME", codexHome)
  );
  return { claudeHome, codexHome };
}

function gitProbedDirs(): string[] {
  return execFileSyncMock.mock.calls.map((call) => (call[1] as string[])[1]);
}

describe("scanGStack — Claude directory install", () => {
  test("registers one pack with its VERSION and git remote, plus every SKILL.md below it outside node_modules", async () => {
    const { claudeHome } = setHomes();
    const installPath = path.join(claudeHome, "skills", "gstack");
    writeFixtureFile(path.join(installPath, "VERSION"), "1.40.0.0 build-7\n");
    writeFixtureFile(
      path.join(installPath, "ship", "SKILL.md"),
      skillMarkdown({ name: "ship-it", version: "2.1", description: "Ships" })
    );
    writeFixtureFile(
      path.join(installPath, "plan", "SKILL.md"),
      "no frontmatter\n"
    );
    writeFixtureFile(
      path.join(installPath, "node_modules", "dep", "SKILL.md"),
      skillMarkdown({ name: "vendored" })
    );
    writeFixtureFile(
      path.join(claudeHome, "skills", "not-gstack", "x", "SKILL.md"),
      skillMarkdown({ name: "other" })
    );
    const real = fs.realpathSync(installPath);
    gitRemotes.set(real, "https://github.com/garrytan/gstack.git\n");

    const { result, plan } = await runWithSink((sink) => scanGStack(sink));

    assert.deepEqual(result, { installs: 1, skills: 2 });
    assert.deepEqual(plan.packs, [
      {
        pack_id: "gstack",
        harness: "claude",
        install_path: installPath,
        install_kind: "directory",
        source_url: "https://github.com/garrytan/gstack.git",
        version: "1.40.0.0",
      },
    ]);
    assert.deepEqual(sortSkills(plan.skills), [
      {
        skill_id: deterministicSkillId("claude", installPath, "plan"),
        pack_id: "gstack",
        harness: "claude",
        install_path: path.join(real, "plan", "SKILL.md"),
        name: "plan",
        version: null,
        description: null,
        source_url: "https://github.com/garrytan/gstack.git",
      },
      {
        skill_id: deterministicSkillId("claude", installPath, "ship-it"),
        pack_id: "gstack",
        harness: "claude",
        install_path: path.join(real, "ship", "SKILL.md"),
        name: "ship-it",
        version: "2.1",
        description: "Ships",
        source_url: "https://github.com/garrytan/gstack.git",
      },
    ]);
    assert.deepEqual(execFileSyncMock.mock.calls, [
      ["git", ["-C", real, "remote", "get-url", "origin"], GIT_PROBE_OPTIONS],
    ]);
  });

  test("a symlinked gstack install is recorded as install_kind symlink, with skill paths under the link target", async () => {
    const { claudeHome } = setHomes();
    const target = makeTempDir();
    writeFixtureFile(
      path.join(target, "review", "SKILL.md"),
      skillMarkdown({ name: "review" })
    );
    const installPath = path.join(claudeHome, "skills", "gstack");
    fs.mkdirSync(path.dirname(installPath), { recursive: true });
    fs.symlinkSync(target, installPath, "dir");

    const { result, plan } = await runWithSink((sink) => scanGStack(sink));

    const real = fs.realpathSync(target);
    assert.deepEqual(result, { installs: 1, skills: 1 });
    assert.equal(plan.packs[0]?.install_kind, "symlink");
    assert.equal(plan.packs[0]?.install_path, installPath);
    // No VERSION file and no git remote: both degrade to null.
    assert.equal(plan.packs[0]?.version, null);
    assert.equal(plan.packs[0]?.source_url, null);
    assert.equal(
      plan.skills[0]?.install_path,
      path.join(real, "review", "SKILL.md")
    );
    assert.deepEqual(gitProbedDirs(), [real]);
  });

  test("a gstack directory holding no SKILL.md registers nothing", async () => {
    const { claudeHome } = setHomes();
    writeFixtureFile(
      path.join(claudeHome, "skills", "gstack", "VERSION"),
      "1.0.0\n"
    );

    const { result, plan } = await runWithSink((sink) => scanGStack(sink));

    assert.deepEqual(result, { installs: 0, skills: 0 });
    assert.deepEqual(plan, { packs: [], skills: [], associations: [] });
  });

  test("empty Claude and Codex homes register nothing and never probe git", async () => {
    setHomes();

    const { result, plan } = await runWithSink((sink) => scanGStack(sink));

    assert.deepEqual(result, { installs: 0, skills: 0 });
    assert.deepEqual(plan.packs, []);
    assert.equal(execFileSyncMock.mock.calls.length, 0);
  });
});

describe("scanGStack — Codex one-symlink-per-skill layout", () => {
  test("collapses every gstack entry into ONE pack keyed on the codex skills root, with the version and remote found by walking up", async () => {
    const { codexHome } = setHomes();
    const repo = makeTempDir();
    writeFixtureFile(path.join(repo, "VERSION"), "0.9.1\n");
    writeFixtureFile(
      path.join(repo, ".agents", "skills", "ship", "SKILL.md"),
      skillMarkdown({ name: "gstack-ship", description: "Ship it" })
    );
    writeFixtureFile(
      path.join(repo, ".agents", "skills", "review", "SKILL.md"),
      "plain\n"
    );
    const skillsRoot = path.join(codexHome, "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.symlinkSync(
      path.join(repo, ".agents", "skills", "ship"),
      path.join(skillsRoot, "gstack-ship"),
      "dir"
    );
    fs.symlinkSync(
      path.join(repo, ".agents", "skills", "review"),
      path.join(skillsRoot, "gstack-review"),
      "dir"
    );
    // A regular FILE with a gstack- name is neither a directory nor a symlink.
    writeFixtureFile(
      path.join(skillsRoot, "gstack-notes"),
      "not a skill dir\n"
    );
    writeFixtureFile(
      path.join(skillsRoot, "other", "SKILL.md"),
      skillMarkdown({ name: "other" })
    );
    const realRepo = fs.realpathSync(repo);
    gitRemotes.set(realRepo, "git@github.com:garrytan/gstack.git");

    const { result, plan } = await runWithSink((sink) => scanGStack(sink));

    assert.deepEqual(result, { installs: 1, skills: 2 });
    assert.deepEqual(plan.packs, [
      {
        pack_id: "gstack",
        harness: "codex",
        install_path: skillsRoot,
        install_kind: "symlink",
        source_url: "git@github.com:garrytan/gstack.git",
        version: "0.9.1",
      },
    ]);
    assert.deepEqual(sortSkills(plan.skills), [
      {
        skill_id: deterministicSkillId("codex", skillsRoot, "gstack-ship"),
        pack_id: "gstack",
        harness: "codex",
        install_path: path.join(
          realRepo,
          ".agents",
          "skills",
          "ship",
          "SKILL.md"
        ),
        name: "gstack-ship",
        version: null,
        description: "Ship it",
        source_url: "git@github.com:garrytan/gstack.git",
      },
      {
        skill_id: deterministicSkillId("codex", skillsRoot, "review"),
        pack_id: "gstack",
        harness: "codex",
        install_path: path.join(
          realRepo,
          ".agents",
          "skills",
          "review",
          "SKILL.md"
        ),
        name: "review",
        version: null,
        description: null,
        source_url: "git@github.com:garrytan/gstack.git",
      },
    ]);
    // The walk stops probing git once a remote answers: skill dir, skills,
    // .agents, then the repo root (where both VERSION and the remote live).
    const firstEntryReal = gitProbedDirs()[0] ?? "";
    assert.deepEqual(gitProbedDirs(), [
      firstEntryReal,
      path.join(realRepo, ".agents", "skills"),
      path.join(realRepo, ".agents"),
      realRepo,
    ]);
  });

  test("an exact `gstack` entry counts, and with no VERSION or remote anywhere the pack is still registered with nulls", async () => {
    const { codexHome } = setHomes();
    const skillsRoot = path.join(codexHome, "skills");
    writeFixtureFile(
      path.join(skillsRoot, "gstack", "core", "SKILL.md"),
      "plain\n"
    );

    const { result, plan } = await runWithSink((sink) => scanGStack(sink));

    assert.deepEqual(result, { installs: 1, skills: 1 });
    assert.deepEqual(plan.packs, [
      {
        pack_id: "gstack",
        harness: "codex",
        install_path: skillsRoot,
        install_kind: "symlink",
        source_url: null,
        version: null,
      },
    ]);
    assert.equal(plan.skills[0]?.name, "core");
    // The walk probes five levels, starting at the entry itself, and gives up.
    const probed = gitProbedDirs();
    assert.equal(probed[0], fs.realpathSync(path.join(skillsRoot, "gstack")));
    assert.equal(probed[1], fs.realpathSync(skillsRoot));
    assert.equal(probed.length, 5);
  });
});

describe("readGStackVersion", () => {
  const cases: [string, string | null, string | null][] = [
    [
      "first whitespace token of a valid version",
      "2.0.0-beta+5 extra\n",
      "2.0.0-beta+5",
    ],
    ["a leading non-digit is rejected", "v1.2.3\n", null],
    ["a character outside [0-9A-Za-z.-+] is rejected", "1.0_x\n", null],
    ["a whitespace-only file is null", "   \n", null],
    ["an empty file is null", "", null],
    ["a missing file is null", null, null],
  ];
  for (const [name, content, expected] of cases) {
    test(name, () => {
      const dir = makeTempDir();
      if (content !== null) {
        writeFixtureFile(path.join(dir, "VERSION"), content);
      }
      assert.equal(_internals.readGStackVersion(dir), expected);
    });
  }
});

describe("scanBmad — legacy global plugin install", () => {
  test("registers only skills dirs whose marketplace.json names bmad-method, carrying its version", async () => {
    const { claudeHome } = setHomes();
    const skills = path.join(claudeHome, "skills");
    const installPath = path.join(skills, "bmad-legacy");
    writeFixtureFile(
      path.join(installPath, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "bmad-method", version: "4.44.0" })
    );
    writeFixtureFile(
      path.join(installPath, "agents", "pm", "SKILL.md"),
      skillMarkdown({ name: "pm" })
    );
    writeFixtureFile(
      path.join(skills, "other-plugin", ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "not-bmad", version: "1.0.0" })
    );
    writeFixtureFile(
      path.join(skills, "broken", ".claude-plugin", "marketplace.json"),
      "{not json"
    );

    const { result, plan } = await runWithSink((sink) => scanBmad(sink));

    assert.deepEqual(result, { installs: 1, skills: 1, projects: 0 });
    assert.deepEqual(plan.packs, [
      {
        pack_id: "bmad-method",
        harness: "claude",
        install_path: installPath,
        install_kind: "directory",
        source_url: null,
        version: "4.44.0",
      },
    ]);
    assert.equal(plan.skills.length, 1);
    assert.equal(plan.skills[0]?.name, "pm");
    assert.equal(plan.skills[0]?.pack_id, "bmad-method");
    assert.deepEqual(plan.associations, []);
  });
});

describe("scanBmad — v6+ project install", () => {
  test("stamps the pack for BOTH claude and codex, ingests only bmad-* skill dirs, and records the project association", async () => {
    setHomes();
    const root = makeTempDir();
    const skillsRoot = path.join(root, ".agents", "skills");
    writeFixtureFile(
      path.join(skillsRoot, "bmad-dev", "SKILL.md"),
      skillMarkdown({ name: "bmad-dev-agent", description: "Dev" })
    );
    writeFixtureFile(
      path.join(skillsRoot, "bmad-qa", "SKILL.md"),
      skillMarkdown({ version: "7.0.0" })
    );
    fs.mkdirSync(path.join(skillsRoot, "bmad-empty"), { recursive: true });
    writeFixtureFile(
      path.join(skillsRoot, "helper", "SKILL.md"),
      skillMarkdown({ name: "helper" })
    );
    writeFixtureFile(
      path.join(root, "_bmad", "_config", "manifest.yaml"),
      "# BMad manifest\ninstallation:\n  date: 2026-01-01\n  version: '6.0.0-alpha.3'\nmodules:\n  - core\n"
    );

    const { result, plan } = await runWithSink(
      (sink) => scanBmad(sink),
      [root]
    );

    // The `_bmad/` dir exists too, but the legacy branch is skipped once v6 matched.
    assert.deepEqual(result, { installs: 2, skills: 4, projects: 1 });
    const pack = (harness: string) => ({
      pack_id: "bmad-method",
      harness,
      install_path: skillsRoot,
      install_kind: "directory",
      source_url: BMAD_SOURCE_URL,
      version: "6.0.0-alpha.3",
    });
    assert.deepEqual(plan.packs, [pack("claude"), pack("codex")]);
    const skill = (
      harness: string,
      name: string,
      dir: string,
      version: string,
      description: string | null
    ) => ({
      skill_id: deterministicSkillId(harness, skillsRoot, name),
      pack_id: "bmad-method",
      harness,
      install_path: path.join(skillsRoot, dir, "SKILL.md"),
      name,
      // Per-skill frontmatter version wins; otherwise the manifest version.
      version,
      description,
      source_url: BMAD_SOURCE_URL,
    });
    assert.deepEqual(sortSkills(plan.skills), [
      skill("claude", "bmad-dev-agent", "bmad-dev", "6.0.0-alpha.3", "Dev"),
      skill("claude", "bmad-qa", "bmad-qa", "7.0.0", null),
      skill("codex", "bmad-dev-agent", "bmad-dev", "6.0.0-alpha.3", "Dev"),
      skill("codex", "bmad-qa", "bmad-qa", "7.0.0", null),
    ]);
    assert.deepEqual(plan.associations, [
      { project_path: root, pack_id: "bmad-method" },
    ]);
  });
});

describe("scanBmad — legacy per-project _bmad/ install", () => {
  test("ingests _bmad/ for claude, takes the version from the nearest marketplace.json, and associates each installing project", async () => {
    setHomes();
    const withMarketplace = makeTempDir();
    writeFixtureFile(
      path.join(withMarketplace, "_bmad", "core", "SKILL.md"),
      skillMarkdown({ name: "bmad-master" })
    );
    writeFixtureFile(
      path.join(withMarketplace, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "bmad-method", version: "4.1.0" })
    );
    const withoutMarketplace = makeTempDir();
    writeFixtureFile(
      path.join(withoutMarketplace, "_bmad", "core", "SKILL.md"),
      "plain\n"
    );
    const unrelated = makeTempDir();

    const { result, plan } = await runWithSink(
      (sink) => scanBmad(sink),
      [withMarketplace, withoutMarketplace, unrelated]
    );

    assert.deepEqual(result, { installs: 2, skills: 2, projects: 2 });
    assert.deepEqual(
      plan.packs.map((p) => [p.install_path, p.harness, p.version]),
      [
        [path.join(withMarketplace, "_bmad"), "claude", "4.1.0"],
        [path.join(withoutMarketplace, "_bmad"), "claude", null],
      ]
    );
    assert.deepEqual(plan.associations, [
      { project_path: withMarketplace, pack_id: "bmad-method" },
      { project_path: withoutMarketplace, pack_id: "bmad-method" },
    ]);
  });
});

describe("readBmadMarketplace", () => {
  test("returns the version for a bmad-method marketplace, null version when it has none", () => {
    const withVersion = makeTempDir();
    writeFixtureFile(
      path.join(withVersion, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "bmad-method", version: "5.0.0" })
    );
    const noVersion = makeTempDir();
    writeFixtureFile(
      path.join(noVersion, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "bmad-method" })
    );
    assert.deepEqual(_internals.readBmadMarketplace(withVersion), {
      version: "5.0.0",
    });
    assert.deepEqual(_internals.readBmadMarketplace(noVersion), {
      version: null,
    });
  });

  test("returns null for a different name, malformed JSON, a JSON null, or no file", () => {
    const otherName = makeTempDir();
    writeFixtureFile(
      path.join(otherName, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "x" })
    );
    const malformed = makeTempDir();
    writeFixtureFile(
      path.join(malformed, ".claude-plugin", "marketplace.json"),
      "{nope"
    );
    const jsonNull = makeTempDir();
    writeFixtureFile(
      path.join(jsonNull, ".claude-plugin", "marketplace.json"),
      "null"
    );
    for (const dir of [otherName, malformed, jsonNull, makeTempDir()]) {
      assert.equal(_internals.readBmadMarketplace(dir), null);
    }
  });
});

describe("readBmadProjectManifest", () => {
  function manifestAt(content: string): string {
    const root = makeTempDir();
    writeFixtureFile(
      path.join(root, "_bmad", "_config", "manifest.yaml"),
      content
    );
    return root;
  }

  test("reads a double-quoted version from a CRLF manifest", () => {
    const root = manifestAt('installation:\r\n  version: "6.1.0"\r\n');
    assert.deepEqual(_internals.readBmadProjectManifest(root), {
      version: "6.1.0",
    });
  });

  test("stops at the next top-level key, so a version under a later section is ignored", () => {
    const root = manifestAt(
      "installation:\n  date: x\nmodules:\n  version: 1.0.0\n"
    );
    assert.equal(_internals.readBmadProjectManifest(root), null);
  });

  test("ignores a version line that appears before the installation section", () => {
    const root = manifestAt("  version: 9.9.9\ninstallation:\n  date: x\n");
    assert.equal(_internals.readBmadProjectManifest(root), null);
  });

  test("a non-numeric version never matches", () => {
    const root = manifestAt("installation:\n  version: latest\n");
    assert.equal(_internals.readBmadProjectManifest(root), null);
  });

  test("no manifest file is null", () => {
    assert.equal(_internals.readBmadProjectManifest(makeTempDir()), null);
  });
});

describe("detectBmadProjectInstall", () => {
  test("null without a .agents/skills root", () => {
    assert.equal(_internals.detectBmadProjectInstall(makeTempDir()), null);
  });

  test("null when no bmad-* dir holds a SKILL.md", () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, ".agents", "skills", "bmad-empty"), {
      recursive: true,
    });
    writeFixtureFile(
      path.join(root, ".agents", "skills", "helper", "SKILL.md"),
      "x\n"
    );
    assert.equal(_internals.detectBmadProjectInstall(root), null);
  });

  test("returns the skills root with a null version when there is no manifest", () => {
    const root = makeTempDir();
    writeFixtureFile(
      path.join(root, ".agents", "skills", "bmad-x", "SKILL.md"),
      "x\n"
    );
    assert.deepEqual(_internals.detectBmadProjectInstall(root), {
      installPath: path.join(root, ".agents", "skills"),
      version: null,
    });
  });
});

describe("scanProjectGStackAssociations", () => {
  test("associates only roots that carry .gstack/conductor.json", async () => {
    const marked = makeTempDir();
    writeFixtureFile(path.join(marked, ".gstack", "conductor.json"), "{}");
    const dirOnly = makeTempDir();
    fs.mkdirSync(path.join(dirOnly, ".gstack"), { recursive: true });
    const missing = path.join(makeTempDir(), "gone");

    const { result, plan } = await runWithSink(
      (sink) => scanProjectGStackAssociations(sink),
      [marked, dirOnly, missing]
    );

    assert.equal(result, 1);
    assert.deepEqual(plan.associations, [
      { project_path: marked, pack_id: "gstack" },
    ]);
    assert.deepEqual(plan.packs, []);
  });
});

describe("walker edge cases", () => {
  test("a blank git remote output is treated as no remote", async () => {
    const { claudeHome } = setHomes();
    const installPath = path.join(claudeHome, "skills", "gstack");
    writeFixtureFile(path.join(installPath, "core", "SKILL.md"), "plain\n");
    gitRemotes.set(fs.realpathSync(installPath), "  \n");

    const { plan } = await runWithSink((sink) => scanGStack(sink));

    assert.equal(plan.packs[0]?.source_url, null);
    assert.equal(plan.skills[0]?.source_url, null);
  });

  test("a v6 project without a manifest stamps null versions, and a symlinked bmad-* skill dir counts", async () => {
    setHomes();
    const root = makeTempDir();
    const skillsRoot = path.join(root, ".agents", "skills");
    const linkedTarget = makeTempDir();
    writeFixtureFile(path.join(linkedTarget, "SKILL.md"), "plain\n");
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.symlinkSync(linkedTarget, path.join(skillsRoot, "bmad-linked"), "dir");

    const { result, plan } = await runWithSink(
      (sink) => scanBmad(sink),
      [root]
    );

    const skillFile = path.join(skillsRoot, "bmad-linked", "SKILL.md");
    assert.deepEqual(result, { installs: 2, skills: 2, projects: 1 });
    assert.deepEqual(
      plan.packs.map((p) => [p.harness, p.version]),
      [
        ["claude", null],
        ["codex", null],
      ]
    );
    assert.deepEqual(
      sortSkills(plan.skills).map((s) => [
        s.harness,
        s.name,
        s.version,
        s.install_path,
      ]),
      [
        ["claude", "bmad-linked", null, skillFile],
        ["codex", "bmad-linked", null, skillFile],
      ]
    );
  });

  test("runPackScanner reads recent roots from the DB, scans the real homes and writes the plan through the sole writer", async () => {
    const { claudeHome } = setHomes();
    envRestores.push(overrideEnv("SKIP_CATALOG_DETECTORS", "1"));
    writeFixtureFile(
      path.join(claudeHome, "skills", "gstack", "core", "SKILL.md"),
      skillMarkdown({ name: "core" })
    );
    const { prisma, close } = await openTestPrisma();
    try {
      const summary = await runPackScanner(prisma);

      assert.deepEqual(summary.gstack, { installs: 1, skills: 1 });
      assert.deepEqual(summary.bmad, { installs: 0, skills: 0, projects: 0 });
      // An empty CLAUDE_HOME still takes the populated-result path, so the
      // per-plugin counter is present (at zero).
      assert.deepEqual(summary.marketplaces, {
        installs: 0,
        skills: 0,
        marketplaces: 0,
        plugins: 0,
      });
      assert.deepEqual(summary.catalogDetectors, {});
      assert.deepEqual(summary.scopes, {
        gstack: true,
        bmad: true,
        marketplaces: true,
        gstackProjects: true,
        catalogDetectors: true,
      });
      assert.equal(summary.pruned, true);
      const packs = await prisma.client.agentPack.findMany({
        select: { packId: true, harness: true },
      });
      assert.deepEqual(packs, [{ packId: "gstack", harness: "claude" }]);
    } finally {
      await close();
    }
  });
});

describe("walker bounds and parsers, pinned against mutation", () => {
  test("a VERSION file with leading whitespace is trimmed before its first token is read", () => {
    const dir = makeTempDir();
    writeFixtureFile(path.join(dir, "VERSION"), "  \n2.0.0 extra\n");
    assert.equal(_internals.readGStackVersion(dir), "2.0.0");
  });

  test("the Codex version/remote walk probes exactly five levels, even far above the filesystem root", async () => {
    setHomes();
    const deepCodexHome = path.join(
      makeTempDir(),
      "a",
      "b",
      "c",
      "d",
      "e",
      "f"
    );
    envRestores.push(overrideEnv("CODEX_HOME", deepCodexHome));
    const skillDir = path.join(deepCodexHome, "skills", "gstack-core");
    writeFixtureFile(path.join(skillDir, "SKILL.md"), "plain\n");

    await runWithSink((sink) => scanGStack(sink));

    const expected: string[] = [];
    let probe = fs.realpathSync(skillDir);
    for (let level = 0; level < 5; level++) {
      expected.push(probe);
      probe = path.dirname(probe);
    }
    assert.deepEqual(gitProbedDirs(), expected);
  });

  test("once a Codex probe level answers with a remote, higher levels are probed for VERSION only", async () => {
    const { codexHome } = setHomes();
    const repo = makeTempDir();
    writeFixtureFile(path.join(repo, "VERSION"), "3.1.0\n");
    const skillDir = path.join(repo, "skills", "ship");
    writeFixtureFile(path.join(skillDir, "SKILL.md"), "plain\n");
    const skillsRoot = path.join(codexHome, "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.symlinkSync(skillDir, path.join(skillsRoot, "gstack-ship"), "dir");
    const realSkillDir = fs.realpathSync(skillDir);
    gitRemotes.set(
      path.dirname(realSkillDir),
      "https://example.test/gstack.git"
    );

    const { plan } = await runWithSink((sink) => scanGStack(sink));

    assert.equal(plan.packs[0]?.source_url, "https://example.test/gstack.git");
    assert.equal(plan.packs[0]?.version, "3.1.0");
    assert.deepEqual(gitProbedDirs(), [
      realSkillDir,
      path.dirname(realSkillDir),
    ]);
  });

  test("the legacy _bmad marketplace lookup probes the project root and three ancestors, no further", async () => {
    setHomes();
    const base = makeTempDir();
    writeFixtureFile(
      path.join(base, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "bmad-method", version: "4.9.0" })
    );
    const threeBelow = path.join(base, "a", "b", "c");
    const fourBelow = path.join(base, "w", "x", "y", "z");
    for (const root of [threeBelow, fourBelow]) {
      writeFixtureFile(path.join(root, "_bmad", "core", "SKILL.md"), "plain\n");
    }

    const { plan } = await runWithSink(
      (sink) => scanBmad(sink),
      [threeBelow, fourBelow]
    );

    assert.deepEqual(
      plan.packs.map((p) => [p.pack_id, p.install_path, p.harness, p.version]),
      [
        ["bmad-method", path.join(threeBelow, "_bmad"), "claude", "4.9.0"],
        ["bmad-method", path.join(fourBelow, "_bmad"), "claude", null],
      ]
    );
  });

  const manifestCases: [string, string, string | null][] = [
    [
      "an unquoted version is read",
      "installation:\n  version: 1.2.3\n",
      "1.2.3",
    ],
    [
      "a version with no space after the colon is read",
      "installation:\n  version:4.5.6\n",
      "4.5.6",
    ],
    [
      "trailing spaces after the version are allowed",
      "installation:\n  version: 7.8.9  \n",
      "7.8.9",
    ],
    [
      "trailing spaces after the section header are allowed",
      "installation:  \n  version: 1.0.1\n",
      "1.0.1",
    ],
    [
      "a trailing comment disqualifies the version line",
      "installation:\n  version: 1.0.0 # pinned\n",
      null,
    ],
    [
      "a header with text after its colon is not the section",
      "installation: inline\n  version: 2.2.2\n",
      null,
    ],
    [
      "a key that merely ends in installation: is not the section",
      "preinstallation:\n  version: 3.3.3\n",
      null,
    ],
    [
      "a top-level key before the section does not end the scan",
      "modules:\n  - core\ninstallation:\n  version: 4.4.4\n",
      "4.4.4",
    ],
    [
      "a column-0 comment inside the section does not end it",
      "installation:\n# note: pinned\n  version: 5.5.5\n",
      "5.5.5",
    ],
    [
      "a top-level key with a trailing space still ends the section",
      "installation:\n  date: x\nmodules: \n  version: 9.9.9\n",
      null,
    ],
  ];
  for (const [name, manifest, expected] of manifestCases) {
    test(`readBmadProjectManifest: ${name}`, () => {
      const root = makeTempDir();
      writeFixtureFile(
        path.join(root, "_bmad", "_config", "manifest.yaml"),
        manifest
      );
      assert.deepEqual(
        _internals.readBmadProjectManifest(root),
        expected === null ? null : { version: expected }
      );
    });
  }
});
