/**
 * @file mutation-kind.test.ts
 * @description FEA-4010 (AA-09 C1) tests for the mutation taxonomy: a mutating
 * tool use is classified by WHAT it touched — source, documentation, or a
 * non-workspace artifact (the harness's own bookkeeping, or a bare transient in
 * the system temp directory).
 *
 * The path shapes below are the ones the golden corpus actually contains, with
 * the usernames the fixtures use, because the rules were chosen to separate
 * exactly these cases: `/tmp/.commit-msg-fea1459` (a transient that anchored
 * `implement` over 10.7 minutes of PR admin) must part company with
 * `/tmp/nrev/perf-pete-7-cursor/…/cursor-parser.ts` (a real source edit in a
 * worktree that happens to live under `/tmp`), and both must part company with
 * `/tmp/cc-expert-training/docs/…` (genuine documentation in a training repo).
 * A rule that got any one of those wrong would look correct on the other two.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claudeAdapter } from "../src/main/collectors/evidence/adapters/claude-adapter.js";
import { codexAdapter } from "../src/main/collectors/evidence/adapters/codex-adapter.js";
import { isAgentToolingStatePath } from "../src/main/collectors/evidence/agent-tooling-state.js";
import { ToolCategory } from "../src/main/collectors/evidence/evidence-model.js";
import {
  isUnderTempRoot,
  mutationCategoryForPath,
  mutationCategoryForTargets,
} from "../src/main/collectors/evidence/mutation-kind.js";

/** No adapter opinion — isolates the harness-blind rules. */
const NO_STATE = () => false;

/** The predicate shape `build-session-evidence` hands the taxonomy. */
function stateFor(adapter: {
  isAgentStatePath?(path: string): boolean;
}): (path: string) => boolean {
  return (path) => adapter.isAgentStatePath?.(path) ?? false;
}

describe("FEA-4010 (AA-09 C1): mutation kind by target", () => {
  test("prose extensions are documents; code, config and data are not", () => {
    for (const path of [
      "/repo/README.md",
      "/repo/docs/runbooks/rotate-secret.md",
      "/repo/guide.mdx",
      "/repo/CHANGELOG.rst",
    ]) {
      assert.equal(
        mutationCategoryForPath(path, NO_STATE),
        ToolCategory.MutateDocument,
        `${path} should be a document`
      );
    }
    // Config and data are SOURCE: one corpus session's single heaviest edit
    // target is a workflow YAML, and calling that documentation would move real
    // CI work out of `implement`.
    for (const path of [
      "/repo/.github/workflows/pr-test.yml",
      "/repo/apps/desktop/package.json",
      "/repo/infra/main.tf",
      "/repo/pyproject.toml",
      "/repo/src/main.ts",
      "/repo/Makefile",
      // `.txt` is source-like in ecosystems this repo is not written in, so it
      // is excluded from the prose set entirely rather than guessed at.
      "/repo/requirements.txt",
      "/repo/constraints.txt",
      "/repo/CMakeLists.txt",
      "/repo/notes.txt",
    ]) {
      assert.equal(
        mutationCategoryForPath(path, NO_STATE),
        ToolCategory.MutateCode,
        `${path} should be source`
      );
    }
  });

  test("a BARE file in a temp root is scratch; a directory tree under temp is a workspace", () => {
    // The transient that anchored implement over PR-admin + CI-triage (6c8d9591).
    for (const path of [
      "/tmp/.commit-msg-fea1459",
      "/tmp/.commit-msg-ci",
      "/private/tmp/pr204-body.md",
      "/var/folders/qd/2m1x9d1n0fl3/T/scratch.py",
      "/private/var/folders/qd/2m1x9d1n0fl3/T/scratch.py",
      "C:\\Users\\dev\\AppData\\Local\\Temp\\notes.txt",
    ]) {
      assert.equal(
        mutationCategoryForPath(path, NO_STATE),
        ToolCategory.MutateScratch,
        `${path} should be scratch`
      );
    }
    // A DIRECTORY under temp is a checkout, not a transient. A naive `/tmp`
    // prefix rule fails every one of these, which is why the depth bound exists.
    assert.equal(
      mutationCategoryForPath(
        "/tmp/nrev/perf-pete-7-cursor/apps/desktop/src/main/collectors/cursor/cursor-parser.ts",
        NO_STATE
      ),
      ToolCategory.MutateCode
    );
    assert.equal(
      mutationCategoryForPath("/tmp/nrev/pp7-closedloop.py", NO_STATE),
      ToolCategory.MutateCode
    );
    assert.equal(
      mutationCategoryForPath(
        "/tmp/cc-expert-training/docs/ONE-DAY-PREWORK-CHECKLIST.md",
        NO_STATE
      ),
      ToolCategory.MutateDocument
    );
  });

  test("isUnderTempRoot spans the temp roots without claiming ordinary paths", () => {
    assert.equal(isUnderTempRoot("/tmp/x"), true);
    assert.equal(isUnderTempRoot("/private/tmp/deep/x"), true);
    assert.equal(isUnderTempRoot("/var/folders/qd/2m1x/T/x"), true);
    // The RESOLVED macOS form: `/var` is a symlink into `/private`, so a tool
    // that calls realpath reports this. Scoping the optional `/private` prefix
    // to the `/tmp` alternative alone left every one of these unrecognized.
    assert.equal(isUnderTempRoot("/private/var/folders/qd/2m1x/T/x"), true);
    assert.equal(isUnderTempRoot("/private/var/tmp/x"), true);
    assert.equal(isUnderTempRoot("/Users/dev/code/repo/src/x.ts"), false);
    // Not a temp ROOT — a project directory that merely contains the word.
    assert.equal(isUnderTempRoot("/Users/dev/code/tmp/x.ts"), false);
  });

  test("Claude declares its state store, and does NOT claim its user-authored config", () => {
    const isState = stateFor(claudeAdapter);
    // Harness-owned state: memory, transcripts, todos, the session scratchpad.
    for (const path of [
      "/Users/testuser5/.claude/projects/-Users-testuser5/memory/MEMORY.md",
      "/Users/testuser4/.claude/projects/-/memory/nightly-dispatch-map.md",
      "/Users/dev/.claude/todos/abc.json",
      "/Users/dev/.claude/shell-snapshots/snapshot-zsh.sh",
      "/private/tmp/claude-501/-Users-testuser5-code-symphony-alpha/3d624f34-1885-4d09-8ee0-f823e91163ad/scratchpad/add-desktop-secret.sh",
    ]) {
      assert.equal(isState(path), true, `${path} should be Claude state`);
      assert.equal(
        mutationCategoryForPath(path, isState),
        ToolCategory.MutateScratch
      );
    }
    // USER-AUTHORED `.claude/` config committed to the repo, and a project file
    // inside a `.claude/worktrees/` checkout: real work, so a blanket `.claude/`
    // match would have been wrong.
    for (const path of [
      "/repo/.claude/agents/design-critic.md",
      "/repo/.claude/skills/local-ci/SKILL.md",
      "/repo/.claude/commands/design.md",
      "/repo/.claude/settings.json",
      "/Users/testuser3/Dev/symphony-alpha/.claude/worktrees/fea-1763/apps/api/service.ts",
    ]) {
      assert.equal(isState(path), false, `${path} should NOT be Claude state`);
    }
    // A repository literally named `claude-3` is not the harness scratchpad.
    assert.equal(isState("/Users/dev/code/claude-3/src/index.ts"), false);
    // The COMBINED near-miss: a checkout cloned INTO temp and named `claude-3`
    // satisfies both the temp test and the `claude-<digits>` test, so requiring
    // the documented `scratchpad/` segment is what keeps this a source edit.
    assert.equal(isState("/tmp/claude-3/src/index.ts"), false);
    assert.equal(
      mutationCategoryForPath("/tmp/claude-3/src/index.ts", isState),
      ToolCategory.MutateCode
    );
    // ...while the real scratchpad shape still resolves, with or without the
    // project/session directories between.
    assert.equal(isState("/tmp/claude-501/scratchpad/probe.sh"), true);
  });

  test("Codex declares its own state store on the same allowlist shape", () => {
    const isState = stateFor(codexAdapter);
    assert.equal(
      isState("/Users/dev/.codex/sessions/2026/rollout.jsonl"),
      true
    );
    assert.equal(isState("/Users/dev/.codex/log/codex-tui.log"), true);
    // User-authored Codex configuration is not bookkeeping.
    assert.equal(isState("/Users/dev/.codex/config.toml"), false);
    assert.equal(isState("/Users/dev/.codex/prompts/review.md"), false);
    // And it does not claim another harness's paths.
    assert.equal(
      isState("/Users/dev/.claude/projects/x/memory/MEMORY.md"),
      false
    );
  });

  test("harness state outranks the extension test, so a memory MEMORY.md is bookkeeping", () => {
    // `.md` would make this a document; it is the agent's own memory store, and
    // documents feed a phase where bookkeeping deliberately does not.
    assert.equal(
      mutationCategoryForPath(
        "/Users/testuser5/.claude/projects/-Users-testuser5/memory/MEMORY.md",
        stateFor(claudeAdapter)
      ),
      ToolCategory.MutateScratch
    );
  });

  test("across several targets, one source file makes the whole tool use a source edit", () => {
    const isState = stateFor(claudeAdapter);
    // The shape a Codex `apply_patch` produces: several files at once.
    assert.equal(
      mutationCategoryForTargets(
        ["/repo/README.md", "/repo/src/main.ts"],
        isState
      ),
      ToolCategory.MutateCode,
      "a mixed patch keeps its implement signal"
    );
    assert.equal(
      mutationCategoryForTargets(
        ["/tmp/.commit-msg-x", "/repo/src/main.ts"],
        isState
      ),
      ToolCategory.MutateCode
    );
    assert.equal(
      mutationCategoryForTargets(["/repo/a.md", "/repo/docs/b.rst"], isState),
      ToolCategory.MutateDocument
    );
    assert.equal(
      mutationCategoryForTargets(
        ["/repo/CHANGELOG.md", "/tmp/.commit-msg-x"],
        isState
      ),
      ToolCategory.MutateDocument,
      "document outranks scratch"
    );
    assert.equal(
      mutationCategoryForTargets(
        [
          "/Users/dev/.claude/todos/a.json",
          "/private/tmp/claude-501/p/s/scratchpad/run.sh",
        ],
        isState
      ),
      ToolCategory.MutateScratch,
      "only when EVERY target is bookkeeping"
    );
  });

  test("an unreadable target list falls back to source — 'we could not tell' is not 'not real work'", () => {
    assert.equal(
      mutationCategoryForTargets([], NO_STATE),
      ToolCategory.MutateCode
    );
    // A harness with no `isAgentStatePath` declaration keeps the pre-C1 answer.
    assert.equal(
      mutationCategoryForPath(
        "/Users/dev/.someharness/sessions/x.json",
        NO_STATE
      ),
      ToolCategory.MutateCode
    );
  });

  test("a published plugin's own bookkeeping tree is scratch, whatever harness ran it", () => {
    // The corpus shape: the code-review plugin writing its per-run state into
    // the repo. One session's ENTIRE mutation signal is six of these, and it
    // reported 40% `implement` on the strength of them.
    for (const path of [
      "/Users/dev/repo/.closedloop-ai/code-review/cr-99578/setup.json",
      "/Users/dev/repo/.closedloop-ai/code-review/cr-99578/github_pr.json",
      "/Users/dev/repo/.closedloop-ai/code-review/cr-81351/run_plan.json",
      "/Users/dev/repo/.closedloop-ai/code-review-threads.json",
      "/Users/dev/repo/.closedloop-ai/code-review-summary.md",
      "/Users/dev/repo/.closedloop-ai/code-review-verifier-stats.md",
      "/Users/dev/repo/.closedloop-ai/runs/run-1/plan.json",
      "/Users/dev/repo/.closedloop-ai/closedloop-loop.local.md",
      // Inside a worktree that itself lives under a harness directory.
      "/Users/dev/repo/.claude/worktrees/fea-1763/.closedloop-ai/code-review/cr-24118/setup.json",
    ]) {
      assert.equal(
        isAgentToolingStatePath(path),
        true,
        `${path} should be plugin bookkeeping`
      );
      assert.equal(
        mutationCategoryForPath(path, NO_STATE),
        ToolCategory.MutateScratch,
        `${path} should be scratch even with no harness opinion`
      );
    }
  });

  test("the plugin's USER-AUTHORED files stay source — the tool's own ignore split", () => {
    // `.closedloop-ai/*` is generated EXCEPT these, per the tool's published
    // .gitignore negations. Editing them is real work, so the inverse allowlist
    // must not swallow them.
    for (const path of [
      "/Users/dev/repo/.closedloop-ai/loops-setup.sh",
      "/Users/dev/repo/.closedloop-ai/settings/critic-gates.json",
      "/Users/dev/repo/.closedloop-ai/settings/verdict-thresholds.json",
    ]) {
      assert.equal(
        isAgentToolingStatePath(path),
        false,
        `${path} is user-authored, not bookkeeping`
      );
      assert.equal(
        mutationCategoryForPath(path, NO_STATE),
        ToolCategory.MutateCode
      );
    }
    // The bare directory name is not enough, and a same-named file is not the root.
    assert.equal(
      isAgentToolingStatePath("/Users/dev/repo/.closedloop-ai"),
      false
    );
    // A CHECKOUT that merely lives in a directory named after the org is not
    // plugin state — the leading dot is what makes it the tool's own root.
    assert.equal(
      isAgentToolingStatePath(
        "/Users/dev/code/closedloop-ai/symphony-alpha/apps/api/service.ts"
      ),
      false
    );
    assert.equal(
      mutationCategoryForPath(
        "/Users/dev/code/closedloop-ai/symphony-alpha/.github/workflows/pr-test.yml",
        NO_STATE
      ),
      ToolCategory.MutateCode
    );
  });

  test("an unknown tool's directory is not assumed to be state", () => {
    assert.equal(
      isAgentToolingStatePath(
        "/Users/dev/repo/.some-other-tool/run/state.json"
      ),
      false
    );
  });
});
