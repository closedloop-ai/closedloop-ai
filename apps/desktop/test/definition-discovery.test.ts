/**
 * @file definition-discovery.test.ts
 * @description ISS-5274 — walker parity for the filesystem half of the
 * definition pipeline after it moved out of `definition-content-collector.ts`
 * into `definition-discovery.ts` so it can run in the pack-scan compute worker.
 *
 * The two properties that must survive the move:
 *  1. the SAME identities/content/harness/projectPath come back, including the
 *     project-root skill at `<proj>/skills/x/SKILL.md` that the whole-project
 *     root exists to find (narrowing the roots would silently drop it), and
 *  2. `readContainedDefinition`'s O_NOFOLLOW containment still refuses a
 *     `.claude/agents` symlink escaping the root — a repo can check one in, and
 *     following it would ingest arbitrary Markdown into desktop-synced content.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Harness } from "@repo/api/src/types/agent-component";
import {
  discoverDefinitions,
  readContainedDefinition,
} from "../src/main/packs/definition-discovery.js";

const DEEP_BODY = /deep body/;
const OK_BODY = /ok body/;

function write(filePath: string, body: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function skillBody(name: string): string {
  return `---\nname: ${name}\n---\n\n${name} body\n`;
}

test("discoverDefinitions finds skills, subagents and commands with their harness and projectPath", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cl-def-walk-"));
  try {
    const claudeHome = path.join(tmp, "home", ".claude");
    const project = path.join(tmp, "proj");
    // A skill NOT under `.claude/` — reachable only because the whole project
    // root is a skill root. This is the case that makes "bound the walk to
    // <proj>/.claude" a silent-omission bug.
    write(path.join(project, "skills", "deep", "SKILL.md"), skillBody("deep"));
    write(
      path.join(claudeHome, "skills", "homey", "SKILL.md"),
      skillBody("homey")
    );
    write(path.join(claudeHome, "agents", "rev.md"), skillBody("rev"));
    write(path.join(claudeHome, "commands", "build.md"), skillBody("build"));

    const found = discoverDefinitions({
      skillRoots: [
        { dir: path.join(claudeHome, "skills"), harness: Harness.Claude },
        { dir: project, projectPath: project },
      ],
      claudeRoots: [{ dir: claudeHome, harness: Harness.Claude }],
    });

    const byKey = new Map(
      found.map((f) => [`${f.primary.kind}:${f.primary.externalId}`, f.primary])
    );
    assert.deepEqual(
      [...byKey.keys()].sort(),
      ["command:/build", "skill:deep", "skill:homey", "subagent:rev"],
      "the project-root skill must be discoverable, not just `<proj>/.claude`"
    );

    const deep = byKey.get("skill:deep");
    assert.equal(deep?.projectPath, project);
    assert.equal(deep?.harness, null, "project roots stay unattributed");
    assert.match(deep?.content ?? "", DEEP_BODY);

    const homey = byKey.get("skill:homey");
    assert.equal(homey?.harness, Harness.Claude);
    assert.equal(homey?.projectPath, undefined);

    // Commands are keyed `/<name>` via the shared normalizer, matching the
    // event-driven component_key.
    assert.equal(byKey.get("command:/build")?.name, "/build");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("discoverDefinitions folds one identity found under two harness roots to Harness.Both", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cl-def-fold-"));
  try {
    const claudeSkills = path.join(tmp, "claude", "skills");
    const codexSkills = path.join(tmp, "codex", "skills");
    write(path.join(claudeSkills, "dual", "SKILL.md"), skillBody("dual"));
    write(path.join(codexSkills, "dual", "SKILL.md"), skillBody("dual"));

    const found = discoverDefinitions({
      skillRoots: [
        { dir: claudeSkills, harness: Harness.Claude },
        { dir: codexSkills, harness: Harness.Codex },
      ],
    });

    assert.equal(found.length, 1, "one identity, not two rows");
    assert.equal(found[0].primary.harness, Harness.Both);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readContainedDefinition refuses a definition reached through a symlink escaping the root", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cl-def-symlink-"));
  try {
    const outside = path.join(tmp, "outside");
    write(path.join(outside, "stolen.md"), skillBody("stolen"));
    const root = path.join(tmp, "proj", ".claude");
    mkdirSync(root, { recursive: true });
    // A repo can check `.claude/agents` in as a symlink pointing outside the
    // project; following it would ingest arbitrary Markdown into content that
    // is synced to the cloud.
    symlinkSync(outside, path.join(root, "agents"), "dir");

    const escaped = readContainedDefinition(
      path.join(root, "agents", "stolen.md"),
      root
    );
    assert.equal(escaped, null, "containment must reject the escaping path");

    // The same walk through the same root returns nothing for that identity.
    const found = discoverDefinitions({ claudeRoots: [{ dir: root }] });
    assert.deepEqual(found, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readContainedDefinition reads a contained definition and reports its stat", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cl-def-contained-"));
  try {
    const root = path.join(tmp, ".claude");
    const file = path.join(root, "agents", "ok.md");
    write(file, skillBody("ok"));

    const read = readContainedDefinition(file, root);
    assert.ok(read, "an in-root regular file must be readable");
    assert.match(read.content, OK_BODY);
    assert.ok(read.stat.size > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
