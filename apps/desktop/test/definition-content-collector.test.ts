/**
 * @file definition-content-collector.test.ts
 * @description Unit tests for the FEA-2923 content producer
 * (`collectDefinitionContent`): seeds a tmpdir with skill / sub-agent / command
 * definition files, runs the collector against an ephemeral migrated libSQL
 * store, and asserts it upserts real `content` + `content_hash` keyed so the row
 * ATTACHES to the event-driven identity (no duplicate) for the same component.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
// The DISPLAY harness contract ({claude,codex,both}) — the same union the
// collector persists and the read path coerces to (FEA-4028). NOT the wider
// `@repo/lib/harness/types` parser-source set.
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import {
  createNormalizedSession,
  HarnessImportMode,
} from "@repo/lib/harness/types";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  captureInvocationDefinitionEvidence,
  classifyDefinitionAccess,
  collectDefinitionContent,
} from "../src/main/packs/definition-content-collector.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type ComponentRow = {
  component_kind: string;
  external_id: string;
  component_key: string;
  name: string | null;
  content: string | null;
  content_hash: string | null;
};

type ScopeRow = {
  component_kind: string;
  external_id: string;
  scope: string | null;
  project_path: string | null;
};

type HarnessRow = {
  external_id: string;
  harness: string | null;
};

// Hoisted so the regex literals are compiled once (biome useTopLevelRegex).
const SKILL_BODY_RE = /Do the thing\./;
const COMMAND_BODY_RE = /Ship it safely\./;
const SUBAGENT_BODY_RE = /Review the code carefully\./;
const CHANGED_SKILL_BODY_RE = /Do a DIFFERENT thing\./;
const VERSION_B_RE = /Version B/;
const OPENCODE_AGENT_BODY_RE = /Build the thing\./;
const OPENCODE_COMMAND_BODY_RE = /Explore the repo\./;
const OPENCODE_ALIAS_AGENT_BODY_RE = /General-purpose agent/;
const OPENCODE_ALIAS_COMMAND_BODY_RE = /Ship via the singular alias/;

test("focused live capture reads the invoked definition after edit and brackets its evidence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "defcapture-live-"));
  const skillDir = path.join(root, "skills", "review");
  const skillFile = path.join(skillDir, "SKILL.md");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, "---\nname: review\n---\nVersion A\n");
  writeFileSync(skillFile, "---\nname: review\n---\nVersion B\n");
  const modifiedAt = new Date("2026-07-22T10:00:00.000Z");
  utimesSync(skillFile, modifiedAt, modifiedAt);
  const session = createNormalizedSession({
    sessionId: "live-session",
    skills: [
      {
        name: "review",
        timestamp: "2026-07-22T10:00:01.000Z",
        providerToolUseId: "toolu_review_1",
      },
    ],
  });
  try {
    const evidence = captureInvocationDefinitionEvidence(session, {
      importMode: HarnessImportMode.LiveWatcher,
      roots: { skillRoots: [path.join(root, "skills")] },
      now: () => new Date("2026-07-22T10:00:02.000Z"),
    });

    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].invocationId, "toolu_review_1");
    assert.match(evidence[0].content, VERSION_B_RE);
    assert.equal(evidence[0].sourceModifiedAt, modifiedAt.toISOString());
    assert.equal(evidence[0].capturedAt, "2026-07-22T10:00:02.000Z");
    assert.deepEqual(
      {
        definitionHash: evidence[0].definitionHash,
        normalizerContractVersion: evidence[0].normalizerContractVersion,
      },
      computeDefinitionHash({
        frontmatter: "",
        body: evidence[0].content,
        kind: "skill",
      })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical capture cannot turn a later file with forged old mtime into evidence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "defcapture-history-"));
  const skillDir = path.join(root, "skills", "review");
  const skillFile = path.join(skillDir, "SKILL.md");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, "---\nname: review\n---\nLater content\n");
  const forgedOldMtime = new Date("2026-07-22T09:00:00.000Z");
  utimesSync(skillFile, forgedOldMtime, forgedOldMtime);
  const session = createNormalizedSession({
    sessionId: "historical-session",
    skills: [{ name: "review", timestamp: "2026-07-22T10:00:01.000Z" }],
  });
  try {
    const evidence = captureInvocationDefinitionEvidence(session, {
      importMode: HarnessImportMode.Historical,
      roots: { skillRoots: [path.join(root, "skills")] },
      now: () => new Date("2026-07-22T11:00:00.000Z"),
    });
    assert.deepEqual(evidence, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("focused live capture rejects a file modified after the invocation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "defcapture-future-"));
  const skillDir = path.join(root, "skills", "review");
  const skillFile = path.join(skillDir, "SKILL.md");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, "---\nname: review\n---\nToo new\n");
  const modifiedAfterInvocation = new Date("2026-07-22T10:00:02.000Z");
  utimesSync(skillFile, modifiedAfterInvocation, modifiedAfterInvocation);
  const session = createNormalizedSession({
    sessionId: "future-session",
    skills: [{ name: "review", timestamp: "2026-07-22T10:00:01.000Z" }],
  });
  try {
    const evidence = captureInvocationDefinitionEvidence(session, {
      importMode: HarnessImportMode.LiveWatcher,
      roots: { skillRoots: [path.join(root, "skills")] },
      now: () => new Date("2026-07-22T10:00:03.000Z"),
    });
    assert.deepEqual(evidence, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("focused live capture leaves identical files at multiple paths ambiguous", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "defcapture-ambiguous-"));
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  const content = "---\nname: review\n---\nSame bytes\n";
  const modifiedAt = new Date("2026-07-22T10:00:00.000Z");
  for (const skillRoot of [firstRoot, secondRoot]) {
    const skillDir = path.join(skillRoot, "review");
    const skillFile = path.join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, content);
    utimesSync(skillFile, modifiedAt, modifiedAt);
  }
  const session = createNormalizedSession({
    sessionId: "ambiguous-identical-session",
    skills: [{ name: "review", timestamp: "2026-07-22T10:00:01.000Z" }],
  });
  try {
    const evidence = captureInvocationDefinitionEvidence(session, {
      importMode: HarnessImportMode.LiveWatcher,
      roots: { skillRoots: [firstRoot, secondRoot] },
      now: () => new Date("2026-07-22T10:00:02.000Z"),
    });
    assert.deepEqual(evidence, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("focused command capture shares fallback identity and normalization", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "defcapture-command-"));
  const commandDir = path.join(root, "commands");
  const commandFile = path.join(commandDir, "review.md");
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(commandFile, "# Review\nRun the review.\n");
  const modifiedAt = new Date("2026-07-22T10:00:00.000Z");
  utimesSync(commandFile, modifiedAt, modifiedAt);
  const timestamp = "2026-07-22T10:00:01.000Z";
  const session = createNormalizedSession({
    sessionId: "command-fallback-session",
    slashCommands: [{ name: "review", timestamp }],
  });
  try {
    const evidence = captureInvocationDefinitionEvidence(session, {
      importMode: HarnessImportMode.LiveWatcher,
      roots: { claudeRoots: [root] },
      now: () => new Date("2026-07-22T10:00:02.000Z"),
    });
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.invocationId, `command:0:${timestamp}:/review`);
    assert.equal(evidence[0]?.normalizedName, "/review");
    assert.equal(evidence[0]?.sourcePath, commandFile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("focused live capture reads through a SYMLINKED ancestor of the scan root", () => {
  // Admission is containment (real path under the real root), NOT string
  // equality against the candidate path. A symlinked ANCESTOR is ordinary and
  // must still capture: macOS `$TMPDIR` (`/var` → `/private/var`), a symlinked
  // `~/.claude`, a worktree under `/tmp`. String equality silently dropped ALL
  // evidence on those installs (and reddened this suite on the macOS release
  // runner while the Linux PR gate stayed green).
  const root = mkdtempSync(path.join(os.tmpdir(), "defcapture-symlinked-"));
  const realRoot = path.join(root, "real");
  const skillFile = path.join(realRoot, "skills", "review", "SKILL.md");
  mkdirSync(path.dirname(skillFile), { recursive: true });
  writeFileSync(skillFile, "---\nname: review\n---\nVersion B\n");
  const modifiedAt = new Date("2026-07-22T10:00:00.000Z");
  utimesSync(skillFile, modifiedAt, modifiedAt);
  // <root>/link → <root>/real, so the scan root reached through the link
  // resolves elsewhere on disk while staying self-contained.
  symlinkSync(realRoot, path.join(root, "link"), "dir");
  const session = createNormalizedSession({
    sessionId: "symlinked-root-session",
    skills: [{ name: "review", timestamp: "2026-07-22T10:00:01.000Z" }],
  });
  try {
    const evidence = captureInvocationDefinitionEvidence(session, {
      importMode: HarnessImportMode.LiveWatcher,
      roots: { skillRoots: [path.join(root, "link", "skills")] },
      now: () => new Date("2026-07-22T10:00:02.000Z"),
    });
    assert.equal(evidence.length, 1);
    assert.match(evidence[0].content, VERSION_B_RE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("focused live capture rejects a definition whose real path escapes the root", () => {
  // The invariant the containment check exists for (wongk review, FEA-3294): a
  // repo-committed link under `.claude/` must never exfiltrate a file from
  // outside the scan root as definition evidence — whether the link is the
  // definition file itself or one of its parent directories.
  const root = mkdtempSync(path.join(os.tmpdir(), "defcapture-escape-"));
  const outside = path.join(root, "outside");
  mkdirSync(outside, { recursive: true });
  const modifiedAt = new Date("2026-07-22T10:00:00.000Z");
  for (const name of ["review.md", "deploy.md"]) {
    writeFileSync(path.join(outside, name), `# ${name}\nSecret.\n`);
    utimesSync(path.join(outside, name), modifiedAt, modifiedAt);
  }
  // `commands/` is itself a link out of the root: the leaf is a real file, so
  // only a containment check can reject it.
  const escapingRoot = path.join(root, "scan");
  mkdirSync(escapingRoot, { recursive: true });
  symlinkSync(outside, path.join(escapingRoot, "commands"), "dir");
  // The leaf-symlink form of the same escape.
  const linkedLeafRoot = path.join(root, "leaf");
  mkdirSync(path.join(linkedLeafRoot, "commands"), { recursive: true });
  symlinkSync(
    path.join(outside, "deploy.md"),
    path.join(linkedLeafRoot, "commands", "deploy.md")
  );
  const capture = (claudeRoot: string, sessionId: string, command: string) =>
    captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId,
        slashCommands: [
          { name: command, timestamp: "2026-07-22T10:00:01.000Z" },
        ],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { claudeRoots: [claudeRoot] },
        now: () => new Date("2026-07-22T10:00:02.000Z"),
      }
    );
  try {
    assert.deepEqual(capture(escapingRoot, "escaping-ancestor", "review"), []);
    assert.deepEqual(capture(linkedLeafRoot, "escaping-leaf", "deploy"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("focused live capture does not resolve a name-only subagent from the filesystem", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "defcapture-subagent-"));
  const agentsDir = path.join(root, "agents");
  const agentFile = path.join(agentsDir, "Explore.md");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(agentFile, "---\nname: Explore\n---\nCustom namesake\n");
  const modifiedAt = new Date("2026-07-22T10:00:00.000Z");
  utimesSync(agentFile, modifiedAt, modifiedAt);
  const session = createNormalizedSession({
    sessionId: "name-only-subagent-session",
    subagents: [
      {
        id: "agent-explore",
        name: "Explore",
        rawName: "Explore",
        normalizedName: "Explore",
        type: "Explore",
        startedAt: "2026-07-22T10:00:01.000Z",
      },
    ],
  });
  try {
    const evidence = captureInvocationDefinitionEvidence(session, {
      importMode: HarnessImportMode.LiveWatcher,
      roots: { claudeRoots: [root] },
      now: () => new Date("2026-07-22T10:00:02.000Z"),
    });
    assert.deepEqual(evidence, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedDefinitionFiles(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "defcollect-"));
  mkdirSync(path.join(root, "skills", "my-skill"), { recursive: true });
  writeFileSync(
    path.join(root, "skills", "my-skill", "SKILL.md"),
    "---\nname: my-skill\ndescription: does a thing\n---\n# My Skill\nDo the thing.\n"
  );
  mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, ".claude", "agents", "code-reviewer.md"),
    "---\nname: code-reviewer\n---\nReview the code carefully.\n"
  );
  mkdirSync(path.join(root, ".claude", "commands"), { recursive: true });
  writeFileSync(
    path.join(root, ".claude", "commands", "deploy.md"),
    "# Deploy\nShip it safely.\n"
  );
  return root;
}

function allComponents(prisma: DesktopPrisma): Promise<ComponentRow[]> {
  return prisma.write((client) =>
    client.$queryRawUnsafe<ComponentRow[]>(
      `SELECT component_kind, external_id, component_key, name, content, content_hash
       FROM agent_components ORDER BY component_kind, external_id`
    )
  );
}

test("collectDefinitionContent upserts content+hash for skills, agents, commands", async () => {
  const root = seedDefinitionFiles();
  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      skillRoots: [path.join(root, "skills")],
      claudeRoots: [path.join(root, ".claude")],
    });
    assert.equal(summary.upserted, 3);
    assert.equal(summary.skipped, 0);

    const rows = await allComponents(prisma);
    assert.equal(rows.length, 3);

    const byKind = new Map(rows.map((r) => [r.component_kind, r]));

    const skill = byKind.get("skill");
    assert.ok(skill);
    assert.equal(skill.external_id, "my-skill");
    assert.equal(skill.component_key, "my-skill");
    assert.match(skill.content ?? "", SKILL_BODY_RE);
    // content_hash is the sha256 of the FULL file text.
    assert.equal(
      skill.content_hash,
      createHash("sha256")
        .update(skill.content ?? "")
        .digest("hex")
    );

    const command = byKind.get("command");
    assert.ok(command);
    // Keyed `/<name>` to match the event-driven component_key.
    assert.equal(command.external_id, "/deploy");
    assert.equal(command.component_key, "/deploy");
    assert.match(command.content ?? "", COMMAND_BODY_RE);

    const subagent = byKind.get("subagent");
    assert.ok(subagent);
    assert.equal(subagent.external_id, "code-reviewer");
    assert.match(subagent.content ?? "", SUBAGENT_BODY_RE);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectDefinitionContent derives scope from install path (user vs project)", async () => {
  // Two homes so we can exercise both user- and project-scoped derivation:
  // `home` is the fake `$HOME` (its `.claude` → user scope); `proj` is a
  // separate project root (its `.claude` → project scope).
  const home = mkdtempSync(path.join(os.tmpdir(), "defscope-home-"));
  const proj = mkdtempSync(path.join(os.tmpdir(), "defscope-proj-"));
  // User-global skill under <home>/.claude/skills.
  mkdirSync(path.join(home, ".claude", "skills", "user-skill"), {
    recursive: true,
  });
  writeFileSync(
    path.join(home, ".claude", "skills", "user-skill", "SKILL.md"),
    "---\nname: user-skill\n---\nUser thing.\n"
  );
  // Project-local sub-agent + command under <proj>/.claude.
  mkdirSync(path.join(proj, ".claude", "agents"), { recursive: true });
  writeFileSync(
    path.join(proj, ".claude", "agents", "proj-agent.md"),
    "---\nname: proj-agent\n---\nProject thing.\n"
  );

  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      skillRoots: [path.join(home, ".claude", "skills")],
      claudeRoots: [{ dir: path.join(proj, ".claude"), projectPath: proj }],
      homeDir: home,
    });
    assert.equal(summary.upserted, 2);

    const rows = await prisma.write((client) =>
      client.$queryRawUnsafe<ScopeRow[]>(
        `SELECT component_kind, external_id, scope, project_path
         FROM agent_components ORDER BY component_kind, external_id`
      )
    );
    const byExt = new Map(rows.map((r) => [r.external_id, r]));

    const userSkill = byExt.get("user-skill");
    assert.ok(userSkill);
    assert.equal(userSkill.scope, "user");
    assert.equal(userSkill.project_path, null);

    const projAgent = byExt.get("proj-agent");
    assert.ok(projAgent);
    assert.equal(projAgent.scope, "project");
    assert.equal(projAgent.project_path, proj);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("collectDefinitionContent attributes Codex skills to Codex, not Claude (FEA-4028)", async () => {
  // A Codex-home skill MUST persist `harness=codex`, a Claude-home skill
  // `harness=claude`, and a harness-agnostic root's skill MUST stay NULL (never
  // guessed). Attribution is by the scan ROOT's `harness`, not a path segment,
  // so a relocated `$CODEX_HOME` with no literal `.codex` in its path still
  // attributes codex (codex review). The Codex root is placed under a
  // deliberately non-`.codex` directory to prove that.
  const home = mkdtempSync(path.join(os.tmpdir(), "defharness-home-"));
  // Relocated Codex home (no `.codex` segment) — attribution comes from the
  // root tag, not the path.
  const codexRoot = path.join(home, "relocated-codex", "skills");
  mkdirSync(path.join(codexRoot, "codex-skill"), { recursive: true });
  writeFileSync(
    path.join(codexRoot, "codex-skill", "SKILL.md"),
    "---\nname: codex-skill\n---\nCodex thing.\n"
  );
  const claudeRoot = path.join(home, ".claude", "skills");
  mkdirSync(path.join(claudeRoot, "claude-skill"), { recursive: true });
  writeFileSync(
    path.join(claudeRoot, "claude-skill", "SKILL.md"),
    "---\nname: claude-skill\n---\nClaude thing.\n"
  );
  // Harness-agnostic root (untagged) — stays unattributed.
  const agnosticRoot = path.join(home, ".agents", "skills");
  mkdirSync(path.join(agnosticRoot, "shared-skill"), { recursive: true });
  writeFileSync(
    path.join(agnosticRoot, "shared-skill", "SKILL.md"),
    "---\nname: shared-skill\n---\nShared thing.\n"
  );

  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      skillRoots: [
        { dir: codexRoot, harness: Harness.Codex },
        { dir: claudeRoot, harness: Harness.Claude },
        // Agnostic root omits `harness` → definitions stay NULL.
        agnosticRoot,
      ],
      homeDir: home,
    });
    assert.equal(summary.upserted, 3);

    const rows = await prisma.write((client) =>
      client.$queryRawUnsafe<HarnessRow[]>(
        "SELECT external_id, harness FROM agent_components ORDER BY external_id"
      )
    );
    const byExt = new Map(rows.map((r) => [r.external_id, r]));

    const codexSkill = byExt.get("codex-skill");
    assert.ok(codexSkill);
    assert.equal(codexSkill.harness, Harness.Codex);

    const claudeSkill = byExt.get("claude-skill");
    assert.ok(claudeSkill);
    assert.equal(claudeSkill.harness, Harness.Claude);

    // Never guessed for a harness-agnostic root.
    const sharedSkill = byExt.get("shared-skill");
    assert.ok(sharedSkill);
    assert.equal(sharedSkill.harness, null);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("collectDefinitionContent folds a dual-installed skill to Both (FEA-4028)", async () => {
  // The SAME skill name installed under BOTH the Claude and Codex homes must
  // NOT read back as Claude just because the Claude root is scanned first
  // (wongk review). Per-name dedup used to drop the Codex copy; now the two
  // discoveries fold to `both`.
  const home = mkdtempSync(path.join(os.tmpdir(), "deffold-home-"));
  const claudeRoot = path.join(home, ".claude", "skills");
  const codexRoot = path.join(home, ".codex", "skills");
  for (const root of [claudeRoot, codexRoot]) {
    mkdirSync(path.join(root, "review"), { recursive: true });
    writeFileSync(
      path.join(root, "review", "SKILL.md"),
      "---\nname: review\n---\nReview thing.\n"
    );
  }

  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      // Claude root FIRST (production order) — the fold must still reach `both`.
      skillRoots: [
        { dir: claudeRoot, harness: Harness.Claude },
        { dir: codexRoot, harness: Harness.Codex },
      ],
      homeDir: home,
    });
    // Deduped to one row (one identity), not two.
    assert.equal(summary.upserted, 1);

    const rows = await prisma.write((client) =>
      client.$queryRawUnsafe<HarnessRow[]>(
        "SELECT external_id, harness FROM agent_components WHERE external_id = 'review'"
      )
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].harness, Harness.Both);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("collectDefinitionContent discovers OpenCode agents+commands as opencode components (ISS-4386)", async () => {
  // OpenCode agents/commands live under its config home in PLURAL dirs
  // (`agents/`, `commands/`); each is discovered as a subagent/command component
  // attributed `harness=opencode` by the scan root — NOT defaulted to Claude by
  // the read path. Attribution is by the `openCodeRoots` entry's `harness`, so a
  // relocated OpenCode config home (no literal `.opencode` in its path) still
  // attributes opencode. The root is placed under a deliberately
  // non-`.opencode` directory to prove that.
  const home = mkdtempSync(path.join(os.tmpdir(), "defopencode-home-"));
  const openCodeRoot = path.join(home, "relocated-opencode");
  mkdirSync(path.join(openCodeRoot, "agents"), { recursive: true });
  writeFileSync(
    path.join(openCodeRoot, "agents", "build.md"),
    "---\nname: build\n---\nBuild the thing.\n"
  );
  mkdirSync(path.join(openCodeRoot, "commands"), { recursive: true });
  writeFileSync(
    path.join(openCodeRoot, "commands", "explore.md"),
    "---\nname: explore\n---\nExplore the repo.\n"
  );

  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      openCodeRoots: [{ dir: openCodeRoot, harness: Harness.Opencode }],
      homeDir: home,
    });
    assert.equal(summary.upserted, 2);
    assert.equal(summary.skipped, 0);

    const rows = await allComponents(prisma);
    const byExt = new Map(rows.map((r) => [r.external_id, r]));

    const agent = byExt.get("build");
    assert.ok(agent);
    assert.equal(agent.component_kind, AgentComponentKind.Subagent);
    assert.match(agent.content ?? "", OPENCODE_AGENT_BODY_RE);

    // Commands are keyed `/<name>` to match the event-driven component_key.
    const command = byExt.get("/explore");
    assert.ok(command);
    assert.equal(command.component_kind, AgentComponentKind.Command);
    assert.match(command.content ?? "", OPENCODE_COMMAND_BODY_RE);

    const harnessRows = await prisma.write((client) =>
      client.$queryRawUnsafe<HarnessRow[]>(
        "SELECT external_id, harness FROM agent_components ORDER BY external_id"
      )
    );
    for (const row of harnessRows) {
      assert.equal(row.harness, Harness.Opencode);
    }
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("collectDefinitionContent reads OpenCode's singular agent/+command/ backwards-compat aliases (ISS-4386)", async () => {
  // OpenCode keeps SINGULAR `agent/`/`command/` as a backwards-compat alias for
  // the plural default dirs; a definition under EITHER alias must still be
  // discovered. Seed both so dropping `command` from OPENCODE_COMMAND_SUBDIRS
  // would fail this test (shafty023).
  const home = mkdtempSync(path.join(os.tmpdir(), "defopencode-alias-"));
  const openCodeRoot = path.join(home, ".config", "opencode");
  mkdirSync(path.join(openCodeRoot, "agent"), { recursive: true });
  writeFileSync(
    path.join(openCodeRoot, "agent", "general.md"),
    "---\nname: general\n---\nGeneral-purpose agent.\n"
  );
  mkdirSync(path.join(openCodeRoot, "command"), { recursive: true });
  writeFileSync(
    path.join(openCodeRoot, "command", "ship.md"),
    "---\nname: ship\n---\nShip via the singular alias.\n"
  );

  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      openCodeRoots: [{ dir: openCodeRoot, harness: Harness.Opencode }],
      homeDir: home,
    });
    assert.equal(summary.upserted, 2);

    const rows = await allComponents(prisma);
    assert.equal(rows.length, 2);
    const byExt = new Map(rows.map((r) => [r.external_id, r]));

    const agent = byExt.get("general");
    assert.ok(agent);
    assert.equal(agent.component_kind, AgentComponentKind.Subagent);
    assert.match(agent.content ?? "", OPENCODE_ALIAS_AGENT_BODY_RE);

    // The command alias is keyed `/<name>`.
    const command = byExt.get("/ship");
    assert.ok(command);
    assert.equal(command.component_kind, AgentComponentKind.Command);
    assert.match(command.content ?? "", OPENCODE_ALIAS_COMMAND_BODY_RE);

    const harnessRows = await prisma.write((client) =>
      client.$queryRawUnsafe<HarnessRow[]>(
        "SELECT external_id, harness FROM agent_components ORDER BY external_id"
      )
    );
    for (const row of harnessRows) {
      assert.equal(row.harness, Harness.Opencode);
    }
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("collectDefinitionContent appends a new version row when content changes", async () => {
  const root = seedDefinitionFiles();
  const skillFile = path.join(root, "skills", "my-skill", "SKILL.md");
  const { prisma, close } = await openTestPrisma();
  try {
    await collectDefinitionContent(prisma, {
      skillRoots: [path.join(root, "skills")],
      claudeRoots: [],
    });
    // Edit the definition → a new content hash → a new revision row.
    writeFileSync(
      skillFile,
      "---\nname: my-skill\n---\n# My Skill\nDo a DIFFERENT thing.\n"
    );
    await collectDefinitionContent(prisma, {
      skillRoots: [path.join(root, "skills")],
      claudeRoots: [],
    });

    const versions = await prisma.write((client) =>
      client.$queryRawUnsafe<{ content_hash: string; content: string }[]>(
        `SELECT content_hash, content FROM agent_component_versions
         WHERE component_kind = 'skill' AND component_key = 'my-skill'`
      )
    );
    // Two distinct revisions retained; the inventory row holds the latest.
    assert.equal(versions.length, 2);
    const current = await prisma.write((client) =>
      client.$queryRawUnsafe<{ content: string }[]>(
        `SELECT content FROM agent_components
         WHERE component_kind = 'skill' AND external_id = 'my-skill'`
      )
    );
    assert.match(current[0].content, CHANGED_SKILL_BODY_RE);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectDefinitionContent ATTACHES content to an existing event-driven row (no duplicate)", async () => {
  const root = seedDefinitionFiles();
  const { prisma, close } = await openTestPrisma();
  try {
    // Simulate the event-driven inventory row (usage-discovered, no content).
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name, first_seen_at, last_seen_at)
         VALUES ('evt-row-1', 'skill', 'my-skill', 'my-skill', 'my-skill',
                 '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`
      )
    );

    await collectDefinitionContent(prisma, {
      skillRoots: [path.join(root, "skills")],
      claudeRoots: [],
    });

    const skills = (await allComponents(prisma)).filter(
      (r) => r.component_kind === "skill"
    );
    // Still exactly one skill row — content was attached, not duplicated.
    assert.equal(skills.length, 1);
    assert.equal(skills[0].external_id, "my-skill");
    assert.match(skills[0].content ?? "", SKILL_BODY_RE);
    assert.ok(skills[0].content_hash);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F1 (FEA-3290 / PRD-527 Slice 4) — resolution state + definition-backed gate
// (AC-4/AC-5/AC-6/AC-7).
// ---------------------------------------------------------------------------

type ResolvedRow = { external_id: string; resolved_state: string };

function resolvedStates(prisma: DesktopPrisma): Promise<ResolvedRow[]> {
  return prisma.write((client) =>
    client.$queryRawUnsafe<ResolvedRow[]>(
      `SELECT external_id, resolved_state
       FROM agent_components ORDER BY component_kind, external_id`
    )
  );
}

// The EXACT SQL the event-driven mint (`upsertEventDrivenComponents` in
// write-core) runs for a label-only row with no captured definition. Mirrored
// here so this contract test locks the gate: unresolved on mint, never demoted
// on re-mint.
async function mintLabelOnly(
  prisma: DesktopPrisma,
  kind: string,
  key: string,
  now: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, resolved_state,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, 'unresolved', $5, $6)
       ON CONFLICT (component_kind, external_id) DO UPDATE SET
         resolved_state = COALESCE(agent_components.resolved_state, 'unresolved'),
         last_seen_at   = excluded.last_seen_at`,
      createHash("sha256").update(`${kind}|${key}`).digest("hex").slice(0, 32),
      kind,
      key,
      key,
      now,
      now
    )
  );
}

test("AC-7/AC-4: a label-minted row with no definition stays 'unresolved'", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // A runtime usage LABEL with no user definition — the anonymous-label case.
    await mintLabelOnly(
      prisma,
      "skill",
      "phantom-label",
      "2026-01-01T00:00:00.000Z"
    );
    const rows = await resolvedStates(prisma);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].external_id, "phantom-label");
    // Never a *configured* (resolved) component without a captured definition.
    assert.equal(rows[0].resolved_state, "unresolved");
  } finally {
    await close();
  }
});

test("AC-6: collector promotes a label-minted 'unresolved' row to 'resolved'", async () => {
  const root = seedDefinitionFiles();
  const { prisma, close } = await openTestPrisma();
  try {
    // Pre-mint the event-driven label-only row (unresolved).
    await mintLabelOnly(
      prisma,
      "skill",
      "my-skill",
      "2026-01-01T00:00:00.000Z"
    );
    let rows = await resolvedStates(prisma);
    assert.equal(rows[0].resolved_state, "unresolved");

    // Exact definition evidence arrives → promotion.
    await collectDefinitionContent(prisma, {
      skillRoots: [path.join(root, "skills")],
      claudeRoots: [],
    });
    rows = await resolvedStates(prisma);
    const skill = rows.find((r) => r.external_id === "my-skill");
    assert.ok(skill);
    assert.equal(skill.resolved_state, "resolved");
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC-7: re-minting a resolved row does NOT demote it (no data loss)", async () => {
  const root = seedDefinitionFiles();
  const { prisma, close } = await openTestPrisma();
  try {
    // Capture exact content → resolved.
    await collectDefinitionContent(prisma, {
      skillRoots: [path.join(root, "skills")],
      claudeRoots: [],
    });
    let skill = (await resolvedStates(prisma)).find(
      (r) => r.external_id === "my-skill"
    );
    assert.equal(skill?.resolved_state, "resolved");

    // A later usage event re-mints the SAME (kind, key) label with no content.
    await mintLabelOnly(
      prisma,
      "skill",
      "my-skill",
      "2026-02-01T00:00:00.000Z"
    );
    skill = (await resolvedStates(prisma)).find(
      (r) => r.external_id === "my-skill"
    );
    // The mint must never clobber a resolved definition back to unresolved.
    assert.equal(skill?.resolved_state, "resolved");
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC-5: classifyDefinitionAccess distinguishes inaccessible (EACCES) from missing (ENOENT)", () => {
  // A path that does not exist → missing (ENOENT).
  const gone = path.join(
    os.tmpdir(),
    `defclass-gone-${Date.now()}`,
    "SKILL.md"
  );
  assert.equal(classifyDefinitionAccess(gone), "missing");

  // A readable file → accessible.
  const dir = mkdtempSync(path.join(os.tmpdir(), "defclass-ok-"));
  const file = path.join(dir, "SKILL.md");
  writeFileSync(file, "---\nname: x\n---\nbody\n");
  try {
    assert.equal(classifyDefinitionAccess(file), "accessible");
    // A directory read with R_OK succeeds, but a path whose PARENT lacks a
    // segment (ENOENT under it) is missing — asserted above. An unreadable file
    // (chmod 000) is inaccessible on POSIX where the test runner is non-root.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = path.join(dir, "locked.md");
      writeFileSync(locked, "secret\n");
      chmodSync(locked, 0o000);
      assert.equal(classifyDefinitionAccess(locked), "inaccessible");
      chmodSync(locked, 0o644); // restore so cleanup can remove it
    }
    // A null install path cannot assert "missing" — never fabricates a deletion.
    assert.equal(classifyDefinitionAccess(null), "inaccessible");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-5: reconcile flips a resolved row to inaccessible on EACCES, preserving content", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return; // POSIX permission semantics only; skip as non-applicable.
  }
  const root = seedDefinitionFiles();
  const skillFile = path.join(root, "skills", "my-skill", "SKILL.md");
  const { prisma, close } = await openTestPrisma();
  try {
    // First pass captures content → resolved.
    await collectDefinitionContent(prisma, {
      skillRoots: [path.join(root, "skills")],
      claudeRoots: [],
    });
    // Make the file unreadable, then re-run: not re-observed as readable, so the
    // reconcile pass classifies it inaccessible (EACCES), NOT missing.
    chmodSync(skillFile, 0o000);
    await collectDefinitionContent(prisma, {
      skillRoots: [path.join(root, "skills")],
      claudeRoots: [],
    });
    chmodSync(skillFile, 0o644); // restore for cleanup

    const rows = await prisma.write((client) =>
      client.$queryRawUnsafe<
        { resolved_state: string; content: string | null }[]
      >(
        `SELECT resolved_state, content FROM agent_components
         WHERE component_kind = 'skill' AND external_id = 'my-skill'`
      )
    );
    assert.equal(rows[0].resolved_state, "inaccessible");
    // Last-known-good content preserved (never cleared on inaccessible).
    assert.ok(rows[0].content);
    assert.match(rows[0].content ?? "", SKILL_BODY_RE);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC-5: reconcile flips a resolved row to missing on ENOENT, preserving content", async () => {
  const root = seedDefinitionFiles();
  const skillDir = path.join(root, "skills", "my-skill");
  const { prisma, close } = await openTestPrisma();
  try {
    await collectDefinitionContent(prisma, {
      skillRoots: [path.join(root, "skills")],
      claudeRoots: [],
    });
    // Delete the definition file (ENOENT) then re-run.
    rmSync(skillDir, { recursive: true, force: true });
    await collectDefinitionContent(prisma, {
      skillRoots: [path.join(root, "skills")],
      claudeRoots: [],
    });

    const rows = await prisma.write((client) =>
      client.$queryRawUnsafe<
        { resolved_state: string; content: string | null }[]
      >(
        `SELECT resolved_state, content FROM agent_components
         WHERE component_kind = 'skill' AND external_id = 'my-skill'`
      )
    );
    // missing is DISTINCT from inaccessible (AC-5).
    assert.equal(rows[0].resolved_state, "missing");
    // Last-known-good content preserved even when the file is gone.
    assert.ok(rows[0].content);
    assert.match(rows[0].content ?? "", SKILL_BODY_RE);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
