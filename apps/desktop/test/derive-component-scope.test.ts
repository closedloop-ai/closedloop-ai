/**
 * @file derive-component-scope.test.ts
 * @description Unit tests for the pure `deriveComponentScope` helper
 * (scope derivation for agent components). Covers the four Claude Code scoping
 * cases — user (`~/.claude/…`), plugin (`~/.claude/plugins/…`), project
 * (`<proj>/.claude/…`), and null (no install_path / undeterminable path).
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  ComponentScope,
  deriveComponentScope,
} from "../src/main/packs/definition-content-collector.js";

const HOME = path.join(path.sep, "Users", "alice");
const PROJECT = path.join(path.sep, "Users", "alice", "code", "my-app");

test("user scope: definition under <home>/.claude/skills", () => {
  const p = path.join(HOME, ".claude", "skills", "my-skill", "SKILL.md");
  assert.equal(deriveComponentScope(p, undefined, HOME), ComponentScope.User);
  assert.equal(deriveComponentScope(p, undefined, HOME), "user");
});

test("user scope: sub-agent + command under <home>/.claude", () => {
  assert.equal(
    deriveComponentScope(
      path.join(HOME, ".claude", "agents", "reviewer.md"),
      undefined,
      HOME
    ),
    ComponentScope.User
  );
  assert.equal(
    deriveComponentScope(
      path.join(HOME, ".claude", "commands", "deploy.md"),
      undefined,
      HOME
    ),
    ComponentScope.User
  );
});

test("plugin scope: definition under <home>/.claude/plugins/…", () => {
  const p = path.join(
    HOME,
    ".claude",
    "plugins",
    "superpowers",
    "skills",
    "x",
    "SKILL.md"
  );
  // Plugin wins over user even though it is under <home>/.claude.
  assert.equal(deriveComponentScope(p, undefined, HOME), ComponentScope.Plugin);
  assert.equal(deriveComponentScope(p, undefined, HOME), "plugin");
});

test("plugin scope: plugins path under a project also resolves to plugin", () => {
  const p = path.join(
    PROJECT,
    ".claude",
    "plugins",
    "some-plugin",
    "agents",
    "x.md"
  );
  assert.equal(deriveComponentScope(p, PROJECT, HOME), ComponentScope.Plugin);
});

test("project scope: definition under <project>/.claude/agents", () => {
  const p = path.join(PROJECT, ".claude", "agents", "code-reviewer.md");
  assert.equal(deriveComponentScope(p, PROJECT, HOME), ComponentScope.Project);
  assert.equal(deriveComponentScope(p, PROJECT, HOME), "project");
});

test("project scope: .claude dir outside home even without a projectPath", () => {
  const p = path.join(
    path.sep,
    "srv",
    "checkout",
    ".claude",
    "commands",
    "ship.md"
  );
  assert.equal(
    deriveComponentScope(p, undefined, HOME),
    ComponentScope.Project
  );
});

test("project scope: under projectPath even without a literal .claude segment", () => {
  // e.g. a project-root skill discovered by findSkillFiles at <proj>/skills/x.
  const p = path.join(PROJECT, "skills", "x", "SKILL.md");
  assert.equal(deriveComponentScope(p, PROJECT, HOME), ComponentScope.Project);
});

const OPENCODE_CONFIG_HOME = path.join(HOME, ".config", "opencode");

test("user scope: OpenCode config-home definition via userScopeRoots (ISS-4386)", () => {
  // OpenCode's user-global agents/commands live under `~/.config/opencode`,
  // which no `.claude`-shaped branch recognizes — so without the extra
  // user-scope root they persisted with `scope = null` (shafty023). Passed as a
  // userScopeRoot, a definition there is user-scoped.
  const agent = path.join(OPENCODE_CONFIG_HOME, "agents", "reviewer.md");
  const command = path.join(OPENCODE_CONFIG_HOME, "commands", "deploy.md");
  assert.equal(
    deriveComponentScope(agent, undefined, HOME, [OPENCODE_CONFIG_HOME]),
    ComponentScope.User
  );
  assert.equal(
    deriveComponentScope(command, undefined, HOME, [OPENCODE_CONFIG_HOME]),
    ComponentScope.User
  );
  // Without the root passed, it is undeterminable (null), not guessed.
  assert.equal(deriveComponentScope(agent, undefined, HOME), null);
});

test("project scope: a project .opencode wins over a user-scope root (ISS-4386)", () => {
  // A project's `.opencode` carries a `projectPath`; even if it somehow sat
  // under a user-scope root, the more-specific project scope wins.
  const p = path.join(PROJECT, ".opencode", "agents", "build.md");
  assert.equal(
    deriveComponentScope(p, PROJECT, HOME, [OPENCODE_CONFIG_HOME]),
    ComponentScope.Project
  );
});

test("null scope: no install_path (invocation-derived row)", () => {
  assert.equal(deriveComponentScope(null, null, HOME), null);
  assert.equal(deriveComponentScope(undefined, undefined, HOME), null);
  assert.equal(deriveComponentScope("", null, HOME), null);
});

test("null scope: path neither under home, a project, nor any .claude dir", () => {
  const p = path.join(path.sep, "opt", "misc", "skills", "x", "SKILL.md");
  assert.equal(deriveComponentScope(p, undefined, HOME), null);
  // A missing homeDir must not throw; unknown paths still resolve to null.
  assert.equal(deriveComponentScope(p, undefined, undefined), null);
});
