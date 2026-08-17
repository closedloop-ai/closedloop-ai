/**
 * @file definition-root-set.test.ts
 * @description ISS-5274 — pins the exact scan-root set and scope context that
 * `resolveDefaultDefinitionScanRoots` / `deriveDefinitionApplyContext` produce.
 *
 * WHY THIS IS ITS OWN TEST. Those two functions were lifted out of an inline
 * object literal inside `collectDefinitionContentFromDefaults`, and nothing else
 * pins the lists themselves: the walker test proves discovery GIVEN roots, the
 * coordinator test proves the roots are forwarded verbatim, and the scope tests
 * prove derivation on the apply side. Dropping one root here would produce a
 * payload the coordinator treats as COMPLETE (presence asserts completeness), and
 * because the on-host fallback consumes the SAME function it would be identically
 * wrong — so no differential test between the two paths could ever catch it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Harness } from "@repo/api/src/types/agent-component";
import {
  type DefinitionScanRoot,
  deriveDefinitionApplyContext,
  resolveDefaultDefinitionScanRoots,
} from "../src/main/packs/definition-discovery.js";

const ENV_KEYS = [
  "CLAUDE_HOME",
  "CODEX_HOME",
  "OPENCODE_CONFIG",
  "XDG_CONFIG_HOME",
] as const;

type EnvSnapshot = Map<string, string | undefined>;

function snapshotEnv(): EnvSnapshot {
  const snapshot: EnvSnapshot = new Map();
  for (const key of ENV_KEYS) {
    snapshot.set(
      key,
      Object.hasOwn(process.env, key) ? process.env[key] : undefined
    );
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      // Assigning `undefined` would store the STRING "undefined" in Node.
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
}

/** The roots pinned as plain objects, so a shape change is visible in the diff. */
function normalized(
  roots: readonly DefinitionScanRoot[] | undefined
): unknown[] {
  return (roots ?? []).map((root) =>
    typeof root === "string" ? { dir: root } : root
  );
}

test("resolveDefaultDefinitionScanRoots pins the exact skill/claude/openCode root set", () => {
  const env = snapshotEnv();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cl-root-set-"));
  const claudeHome = path.join(tmp, "claude-home");
  const codexHome = path.join(tmp, "codex-home");
  const xdgConfig = path.join(tmp, "xdg");
  process.env.CLAUDE_HOME = claudeHome;
  process.env.CODEX_HOME = codexHome;
  process.env.XDG_CONFIG_HOME = xdgConfig;
  Reflect.deleteProperty(process.env, "OPENCODE_CONFIG");
  const openCodeHome = path.join(xdgConfig, "opencode");

  try {
    const roots = resolveDefaultDefinitionScanRoots(["/p1", "/p2"]);

    // Home skill roots are harness-tagged by the home they resolve to — this is
    // what attributes a Codex-home skill to `codex` even when $CODEX_HOME is
    // relocated somewhere with no literal `.codex` segment (FEA-4028). Project
    // roots are fed WHOLE (not `<proj>/.claude/skills`), which is why a skill at
    // `<proj>/skills/x/SKILL.md` is discoverable, and deliberately UNTAGGED —
    // a project tree can hold either harness's definitions.
    assert.deepEqual(normalized(roots.skillRoots), [
      { dir: path.join(claudeHome, "skills"), harness: Harness.Claude },
      { dir: path.join(codexHome, "skills"), harness: Harness.Codex },
      { dir: "/p1", projectPath: "/p1" },
      { dir: "/p2", projectPath: "/p2" },
    ]);

    assert.deepEqual(normalized(roots.claudeRoots), [
      { dir: claudeHome, harness: Harness.Claude },
      { dir: path.join("/p1", ".claude"), projectPath: "/p1" },
      { dir: path.join("/p2", ".claude"), projectPath: "/p2" },
    ]);

    // Both the config home AND each project `.opencode` are tagged `opencode`:
    // unlike a project `.claude` dir, `.opencode` is an OpenCode-specific
    // literal, so its harness is not a guess. Leaving it untagged stored NULL,
    // which both read paths coerce to Claude.
    assert.deepEqual(normalized(roots.openCodeRoots), [
      { dir: openCodeHome, harness: Harness.Opencode },
      {
        dir: path.join("/p1", ".opencode"),
        projectPath: "/p1",
        harness: Harness.Opencode,
      },
      {
        dir: path.join("/p2", ".opencode"),
        projectPath: "/p2",
        harness: Harness.Opencode,
      },
    ]);
  } finally {
    restoreEnv(env);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveDefinitionApplyContext returns the config-home-only userScopeRoots", () => {
  const env = snapshotEnv();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cl-root-ctx-"));
  const xdgConfig = path.join(tmp, "xdg");
  process.env.CLAUDE_HOME = path.join(tmp, "claude-home");
  process.env.CODEX_HOME = path.join(tmp, "codex-home");
  process.env.XDG_CONFIG_HOME = xdgConfig;
  Reflect.deleteProperty(process.env, "OPENCODE_CONFIG");

  try {
    const roots = resolveDefaultDefinitionScanRoots(["/p1", "/p2"]);
    const context = deriveDefinitionApplyContext(roots);

    // Only OpenCode roots WITHOUT a projectPath are user-scope roots: a project
    // `.opencode` stays project-scoped through the projectPath branch. Including
    // one here would mislabel every project-local OpenCode agent as `user`.
    assert.deepEqual(context.userScopeRoots, [
      path.join(xdgConfig, "opencode"),
    ]);
    assert.equal(context.homeDir, os.homedir());
  } finally {
    restoreEnv(env);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveDefinitionApplyContext honors an injected homeDir", () => {
  const context = deriveDefinitionApplyContext({
    homeDir: "/injected/home",
    openCodeRoots: [
      { dir: "/cfg/opencode", harness: Harness.Opencode },
      { dir: "/p1/.opencode", projectPath: "/p1", harness: Harness.Opencode },
    ],
  });

  assert.equal(context.homeDir, "/injected/home");
  assert.deepEqual(context.userScopeRoots, ["/cfg/opencode"]);
});
