/**
 * @file definition-content-collector-coverage.test.ts
 * @description Branch coverage for `definition-content-collector.ts` that the
 * sibling suites do not reach: the focused-capture default roots and clock,
 * invocation grouping and window filtering, candidate-path dedup and the
 * skill-root-is-the-skill-dir shape, the name-mismatch and invalid-timestamp
 * refusals, trailing-separator scope roots, and the best-effort error paths
 * of `applyDiscoveredDefinitions`.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "@repo/api/src/types/agent-component";
import {
  createNormalizedSession,
  HarnessImportMode,
  NormalizedDefinitionKind,
} from "@repo/lib/harness/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  applyDiscoveredDefinitions,
  ComponentScope,
  captureInvocationDefinitionEvidence,
  deriveComponentScope,
} from "../src/main/packs/definition-content-collector.js";
import type { DiscoveredDefinition } from "../src/main/packs/definition-variant-fold.js";
import { silenceWarnings } from "./helpers/gateway-log-spies.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const DEFINITION_MTIME = new Date("2026-07-22T10:00:00.000Z");
const CAPTURED_AT = "2026-07-22T10:00:20.000Z";
const LOG_SOURCE = "definition-content-collector";
// Unlikely to collide with anything in the real `~/.agents/skills`, which the
// default focused roots always include.
const UNIQUE_SKILL = "iss10514-l7b-coverage-skill";
const UNIQUE_COMMAND = "iss10514-l7b-coverage-command";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeStamped(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  utimesSync(file, DEFINITION_MTIME, DEFINITION_MTIME);
}

function fixedNow(): Date {
  return new Date(CAPTURED_AT);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("deriveComponentScope with trailing-separator roots", () => {
  test("a user-scope root ending in a separator matches its children but not a sibling prefix", () => {
    const root = `${path.join(path.sep, "cfg", "opencode")}${path.sep}`;
    const home = path.join(path.sep, "home", "u");

    expect(
      deriveComponentScope(
        path.join(path.sep, "cfg", "opencode", "agents", "a.md"),
        null,
        home,
        [root]
      )
    ).toBe(ComponentScope.User);
    expect(
      deriveComponentScope(
        path.join(path.sep, "cfg", "opencode-other", "agents", "a.md"),
        null,
        home,
        [root]
      )
    ).toBeNull();
    // The same sibling-prefix boundary when the root has NO trailing separator.
    expect(
      deriveComponentScope(
        path.join(path.sep, "cfg", "opencode-other", "agents", "a.md"),
        null,
        home,
        [path.join(path.sep, "cfg", "opencode")]
      )
    ).toBeNull();
  });
});

describe("captureInvocationDefinitionEvidence default roots", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CLAUDE_HOME = process.env.CLAUDE_HOME;
    savedEnv.CODEX_HOME = process.env.CODEX_HOME;
  });

  afterEach(() => {
    for (const key of ["CLAUDE_HOME", "CODEX_HOME"] as const) {
      const value = savedEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  test("with a cwd, resolves project .claude skills and commands without explicit roots", () => {
    const cwd = makeTempDir("defcap-cwd-");
    process.env.CLAUDE_HOME = makeTempDir("defcap-claude-home-");
    process.env.CODEX_HOME = makeTempDir("defcap-codex-home-");
    const skillFile = path.join(
      cwd,
      ".claude",
      "skills",
      UNIQUE_SKILL,
      "SKILL.md"
    );
    const commandFile = path.join(
      cwd,
      ".claude",
      "commands",
      `${UNIQUE_COMMAND}.md`
    );
    writeStamped(skillFile, `---\nname: ${UNIQUE_SKILL}\n---\nSkill body\n`);
    writeStamped(commandFile, "Command body\n");

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "default-roots-cwd",
        cwd,
        skills: [
          {
            name: UNIQUE_SKILL,
            timestamp: "2026-07-22T10:00:01.000Z",
            providerToolUseId: "toolu_skill",
          },
        ],
        slashCommands: [
          {
            name: UNIQUE_COMMAND,
            timestamp: "2026-07-22T10:00:02.000Z",
            userTurnId: "turn_command",
          },
        ],
      }),
      { importMode: HarnessImportMode.LiveWatcher, now: fixedNow }
    );

    expect(
      evidence.map((e) => [e.invocationId, e.sourcePath, e.normalizedName])
    ).toEqual([
      ["toolu_skill", skillFile, UNIQUE_SKILL],
      ["turn_command", commandFile, `/${UNIQUE_COMMAND}`],
    ]);
  });

  test("with a cwd, resolves project .agents and .codex skills without explicit roots", () => {
    const cwd = makeTempDir("defcap-cwd-agents-");
    process.env.CLAUDE_HOME = makeTempDir("defcap-claude-home-");
    process.env.CODEX_HOME = makeTempDir("defcap-codex-home-");
    const agentsSkill = `${UNIQUE_SKILL}-agents`;
    const codexSkill = `${UNIQUE_SKILL}-codex`;
    const agentsFile = path.join(
      cwd,
      ".agents",
      "skills",
      agentsSkill,
      "SKILL.md"
    );
    const codexFile = path.join(
      cwd,
      ".codex",
      "skills",
      codexSkill,
      "SKILL.md"
    );
    writeStamped(agentsFile, `---\nname: ${agentsSkill}\n---\nAgents body\n`);
    writeStamped(codexFile, `---\nname: ${codexSkill}\n---\nCodex body\n`);

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "default-roots-agents-codex",
        cwd,
        skills: [
          { name: agentsSkill, timestamp: "2026-07-22T10:00:01.000Z" },
          { name: codexSkill, timestamp: "2026-07-22T10:00:01.000Z" },
        ],
      }),
      { importMode: HarnessImportMode.LiveWatcher, now: fixedNow }
    );

    expect(evidence.map((e) => e.sourcePath)).toEqual([agentsFile, codexFile]);
  });

  test("without a cwd, resolves the CLAUDE_HOME skill using the real clock", () => {
    const claudeHome = makeTempDir("defcap-claude-home-");
    process.env.CLAUDE_HOME = claudeHome;
    process.env.CODEX_HOME = makeTempDir("defcap-codex-home-");
    const skillFile = path.join(claudeHome, "skills", UNIQUE_SKILL, "SKILL.md");
    writeStamped(skillFile, `---\nname: ${UNIQUE_SKILL}\n---\nHome body\n`);

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "default-roots-no-cwd",
        cwd: null,
        skills: [
          {
            name: UNIQUE_SKILL,
            timestamp: "2026-07-22T10:00:01.000Z",
            providerToolUseId: "toolu_home",
          },
        ],
      }),
      { importMode: HarnessImportMode.LiveWatcher }
    );

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.sourcePath).toBe(skillFile);
    expect(evidence[0]?.content).toBe(
      `---\nname: ${UNIQUE_SKILL}\n---\nHome body\n`
    );
  });
});

describe("captureInvocationDefinitionEvidence invocation handling", () => {
  test("groups same-name invocations, reads for the latest, and keeps only those inside the window", () => {
    const root = makeTempDir("defcap-group-");
    writeStamped(
      path.join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\n---\nBody\n"
    );

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "grouped",
        skills: [
          {
            name: "review",
            timestamp: "2026-07-22T10:00:05.000Z",
            providerToolUseId: "a",
          },
          {
            name: "review",
            timestamp: "2026-07-22T09:59:00.000Z",
            providerToolUseId: "b-before-mtime",
          },
          {
            name: "review",
            timestamp: "2026-07-22T10:00:10.000Z",
            providerToolUseId: "c",
          },
          { name: "review", timestamp: null, providerToolUseId: "no-time" },
        ],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [path.join(root, "skills")] },
        now: fixedNow,
      }
    );

    expect(evidence.map((e) => e.invocationId)).toEqual(["a", "c"]);
    expect(evidence.map((e) => e.invokedAt)).toEqual([
      "2026-07-22T10:00:05.000Z",
      "2026-07-22T10:00:10.000Z",
    ]);
  });

  test("the latest same-name invocation drives the read regardless of its position in the session", () => {
    const root = makeTempDir("defcap-latest-order-");
    writeStamped(
      path.join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\n---\nBody\n"
    );
    const early = {
      name: "review",
      timestamp: "2026-07-22T09:59:00.000Z",
      providerToolUseId: "early-before-mtime",
    };
    const late = {
      name: "review",
      timestamp: "2026-07-22T10:00:10.000Z",
      providerToolUseId: "late",
    };
    const capture = (skills: (typeof early)[]) =>
      captureInvocationDefinitionEvidence(
        createNormalizedSession({ sessionId: "latest-order", skills }),
        {
          importMode: HarnessImportMode.LiveWatcher,
          roots: { skillRoots: [path.join(root, "skills")] },
          now: fixedNow,
        }
      ).map((e) => e.invocationId);

    expect(capture([early, late])).toEqual(["late"]);
    expect(capture([late, early])).toEqual(["late"]);
  });

  test("a timestamp-less skill listed first does not become the group's latest", () => {
    const root = makeTempDir("defcap-null-first-");
    writeStamped(
      path.join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\n---\nBody\n"
    );

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "null-first",
        skills: [
          { name: "review", timestamp: null, providerToolUseId: "no-time" },
          {
            name: "review",
            timestamp: "2026-07-22T10:00:01.000Z",
            providerToolUseId: "timed",
          },
        ],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [path.join(root, "skills")] },
        now: fixedNow,
      }
    );

    expect(evidence.map((e) => e.invocationId)).toEqual(["timed"]);
  });

  test("the evidence window is inclusive at both the file mtime and the capture time", () => {
    const root = makeTempDir("defcap-inclusive-");
    writeStamped(
      path.join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\n---\nBody\n"
    );

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "inclusive",
        skills: [
          {
            name: "review",
            timestamp: DEFINITION_MTIME.toISOString(),
            providerToolUseId: "at-mtime",
          },
          {
            name: "review",
            timestamp: CAPTURED_AT,
            providerToolUseId: "at-capture-1",
          },
          {
            name: "review",
            timestamp: CAPTURED_AT,
            providerToolUseId: "at-capture-2",
          },
        ],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [path.join(root, "skills")] },
        now: fixedNow,
      }
    );

    expect(evidence.map((e) => e.invocationId)).toEqual([
      "at-mtime",
      "at-capture-1",
      "at-capture-2",
    ]);
  });

  test("a group member numerically after the capture time is excluded even when string order picked an earlier latest", () => {
    const root = makeTempDir("defcap-offset-");
    writeStamped(
      path.join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\n---\nBody\n"
    );

    // pins current behavior; looks odd because the group's latest is chosen by
    // STRING order of the raw timestamps, so an offset timestamp that is
    // numerically later (11:00:10Z) sorts before 10:00:15Z. The per-member
    // numeric window check is what keeps it out.
    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "offset",
        skills: [
          {
            name: "review",
            timestamp: "2026-07-22T10:00:15.000Z",
            providerToolUseId: "string-latest",
          },
          {
            name: "review",
            timestamp: "2026-07-22T10:00:10.000-01:00",
            providerToolUseId: "numerically-after-capture",
          },
        ],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [path.join(root, "skills")] },
        now: fixedNow,
      }
    );

    expect(evidence.map((e) => e.invocationId)).toEqual(["string-latest"]);
  });

  test("a SKILL.md directly in a skills root is not a candidate for a differently named root", () => {
    const root = makeTempDir("defcap-root-skillmd-");
    const skillsRoot = path.join(root, "skills");
    writeStamped(
      path.join(skillsRoot, "SKILL.md"),
      "---\nname: review\n---\nBody\n"
    );

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "root-skillmd",
        skills: [{ name: "review", timestamp: "2026-07-22T10:00:01.000Z" }],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [skillsRoot] },
        now: fixedNow,
      }
    );

    expect(evidence).toEqual([]);
  });

  test("a candidate path reached from two roots keeps the FIRST root for containment", () => {
    const root = makeTempDir("defcap-first-root-");
    const outside = makeTempDir("defcap-first-root-outside-");
    const skillsRoot = path.join(root, "skills");
    mkdirSync(skillsRoot, { recursive: true });
    writeStamped(
      path.join(outside, "SKILL.md"),
      "---\nname: review\n---\nBody\n"
    );
    const linkedSkillDir = path.join(skillsRoot, "review");
    symlinkSync(outside, linkedSkillDir, "dir");
    const session = createNormalizedSession({
      sessionId: "first-root",
      skills: [{ name: "review", timestamp: "2026-07-22T10:00:01.000Z" }],
    });

    // Control: the symlinked skill dir as its own root contains the file.
    expect(
      captureInvocationDefinitionEvidence(session, {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [linkedSkillDir] },
        now: fixedNow,
      })
    ).toHaveLength(1);
    // The same candidate path is first derived from `skills`, whose real path
    // does not contain the symlink target, so it is refused.
    expect(
      captureInvocationDefinitionEvidence(session, {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [skillsRoot, linkedSkillDir] },
        now: fixedNow,
      })
    ).toEqual([]);
  });

  test("a skill root listed twice yields one candidate, not an ambiguous pair", () => {
    const root = makeTempDir("defcap-dup-root-");
    const skillsRoot = path.join(root, "skills");
    writeStamped(
      path.join(skillsRoot, "review", "SKILL.md"),
      "---\nname: review\n---\nBody\n"
    );

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "dup-root",
        skills: [{ name: "review", timestamp: "2026-07-22T10:00:01.000Z" }],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [skillsRoot, skillsRoot] },
        now: fixedNow,
      }
    );

    expect(evidence).toHaveLength(1);
  });

  test("a skill root that IS the skill directory resolves its SKILL.md, named from the directory when frontmatter has no name", () => {
    const root = makeTempDir("defcap-skill-dir-root-");
    const skillDir = path.join(root, "skills", "review");
    const skillFile = path.join(skillDir, "SKILL.md");
    writeStamped(skillFile, "No frontmatter here\n");

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "skill-dir-root",
        skills: [{ name: "review", timestamp: "2026-07-22T10:00:01.000Z" }],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [skillDir] },
        now: fixedNow,
      }
    );

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.sourcePath).toBe(skillFile);
    expect(evidence[0]?.normalizedName).toBe("review");
  });

  test("refuses a file whose frontmatter name differs from the invoked name", () => {
    const root = makeTempDir("defcap-mismatch-");
    writeStamped(
      path.join(root, "skills", "review", "SKILL.md"),
      "---\nname: something-else\n---\nBody\n"
    );

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "mismatch",
        skills: [{ name: "review", timestamp: "2026-07-22T10:00:01.000Z" }],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [path.join(root, "skills")] },
        now: fixedNow,
      }
    );

    expect(evidence).toEqual([]);
  });

  test("refuses an invocation whose timestamp does not parse", () => {
    const root = makeTempDir("defcap-bad-time-");
    writeStamped(
      path.join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\n---\nBody\n"
    );

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "bad-time",
        skills: [{ name: "review", timestamp: "not-a-timestamp" }],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [path.join(root, "skills")] },
        now: fixedNow,
      }
    );

    expect(evidence).toEqual([]);
  });

  test("a skill resolves only through skillRoots and a command only through claudeRoots", () => {
    const root = makeTempDir("defcap-no-roots-");
    writeStamped(
      path.join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\n---\nBody\n"
    );
    writeStamped(path.join(root, ".claude", "commands", "ship.md"), "Ship\n");

    const session = createNormalizedSession({
      sessionId: "no-roots",
      skills: [{ name: "review", timestamp: "2026-07-22T10:00:01.000Z" }],
      slashCommands: [{ name: "ship", timestamp: "2026-07-22T10:00:01.000Z" }],
    });

    const skillsDir = path.join(root, "skills");
    const claudeDir = path.join(root, ".claude");

    // Controls: each fixture is found through its own field.
    expect(
      captureInvocationDefinitionEvidence(session, {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [skillsDir] },
        now: fixedNow,
      }).map((row) => row.kind)
    ).toEqual([NormalizedDefinitionKind.Skill]);
    expect(
      captureInvocationDefinitionEvidence(session, {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { claudeRoots: [claudeDir] },
        now: fixedNow,
      }).map((row) => row.kind)
    ).toEqual([NormalizedDefinitionKind.Command]);

    // Swapped: the skill's own root rides claudeRoots and the command's own
    // root rides skillRoots, so a fallback to the other field would find it.
    expect(
      captureInvocationDefinitionEvidence(session, {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { claudeRoots: [skillsDir] },
        now: fixedNow,
      })
    ).toEqual([]);
    expect(
      captureInvocationDefinitionEvidence(session, {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { skillRoots: [claudeDir] },
        now: fixedNow,
      })
    ).toEqual([]);
  });
});

describe("applyDiscoveredDefinitions best-effort error paths", () => {
  let handle: OpenTestPrisma;

  beforeEach(async () => {
    handle = await openTestPrisma();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await handle.close();
  });

  function definition(name: string): DiscoveredDefinition {
    return {
      kind: "skill",
      externalId: name,
      name,
      installPath: path.join(os.tmpdir(), "defcap-apply", name, "SKILL.md"),
      content: `Body of ${name}`,
      harness: Harness.Claude,
    };
  }

  test("skips a definition whose upsert throws (Error or non-Error) and logs each", async () => {
    const warn = silenceWarnings();
    vi.spyOn(handle.prisma, "write")
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce("raw failure");

    const summary = await applyDiscoveredDefinitions(
      handle.prisma,
      [
        { primary: definition("first"), variants: [] },
        { primary: definition("second"), variants: [] },
      ],
      { homeDir: os.tmpdir(), userScopeRoots: [] },
      "2026-07-22T10:00:00.000Z"
    );

    expect(summary).toEqual({ upserted: 0, skipped: 2 });
    expect(warn.mock.calls).toEqual([
      [LOG_SOURCE, 'failed to upsert skill "first": disk full'],
      [LOG_SOURCE, 'failed to upsert skill "second": raw failure'],
    ]);
    const rows = await handle.prisma.read((client) =>
      client.$queryRawUnsafe<{ n: number }[]>(
        "SELECT COUNT(*) AS n FROM agent_components"
      )
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  test("a failing access-state reconcile (Error or non-Error) is logged and does not throw", async () => {
    const warn = silenceWarnings();
    vi.spyOn(handle.prisma, "read")
      .mockRejectedValueOnce(new Error("read failed"))
      .mockRejectedValueOnce(42);
    const context = { homeDir: os.tmpdir(), userScopeRoots: [] };

    await expect(
      applyDiscoveredDefinitions(handle.prisma, [], context)
    ).resolves.toEqual({ upserted: 0, skipped: 0 });
    await expect(
      applyDiscoveredDefinitions(handle.prisma, [], context)
    ).resolves.toEqual({ upserted: 0, skipped: 0 });

    expect(warn.mock.calls).toEqual([
      [LOG_SOURCE, "failed to reconcile definition access state: read failed"],
      [LOG_SOURCE, "failed to reconcile definition access state: 42"],
    ]);
  });
});
