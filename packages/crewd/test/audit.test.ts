import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Harness, RunOpts, RunResult } from "../src/harness/types.js";
import {
  AuditScope,
  DEFAULT_MODEL,
  type HarnessName,
  NativeSchedule,
} from "../src/model.js";
import { type AuditProgressEvent, runAuditPass } from "../src/passes/audit.js";
import {
  GIT_SPAWN_TEST_TIMEOUT_MS,
  runGitFixture,
} from "./helpers/git-fixture.js";
import { registry, res } from "./helpers/harness-fixtures.js";

const FINDINGS_JSONL_RE = /write one JSON finding per line to (\S+)/;
const ELICIT_NOTE_RE = /elicit/i;
const NO_INTERVIEW_RE = /do NOT interview/i;

/** Extract the findings.jsonl path the runtime context told the harness to write. */
function findingsPathFromPrompt(prompt: string): string {
  const m = prompt.match(FINDINGS_JSONL_RE);
  if (!m?.[1]) {
    throw new Error("prompt did not carry a findings path");
  }
  return m[1];
}

/** A harness that writes the given findings JSONL lines, then succeeds. */
function writingHarness(name: HarnessName, lines: string[]): Harness {
  return {
    name,
    capabilities: {
      nativeSchedule: NativeSchedule.None,
      availableModels: [DEFAULT_MODEL[name]],
      defaultModel: DEFAULT_MODEL[name],
    },
    isAvailable: async () => true,
    listModels: async () => [DEFAULT_MODEL[name]],
    run: (o: RunOpts) => {
      const path = findingsPathFromPrompt(o.prompt);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
      o.onOutput?.("scanning docs...\n");
      return Promise.resolve(res({ ok: true, exitCode: 0 }));
    },
  };
}

/**
 * A harness that exits cleanly but ends by ELICITING (interviewing the
 * operator) and writes NO findings — the FEA-4012 hang case. The runner must
 * reclassify it as a failed attempt that cascades, not a live success.
 */
function elicitingHarness(name: HarnessName): Harness {
  return {
    name,
    capabilities: {
      nativeSchedule: NativeSchedule.None,
      availableModels: [DEFAULT_MODEL[name]],
      defaultModel: DEFAULT_MODEL[name],
    },
    isAvailable: async () => true,
    listModels: async () => [DEFAULT_MODEL[name]],
    run: (o: RunOpts) => {
      o.onOutput?.(
        "…then interview me to figure out what I need scheduled and when it should run.\n"
      );
      return Promise.resolve(
        res({
          ok: true,
          exitCode: 0,
          outputTail:
            "…then interview me to figure out what I need scheduled and when it should run.",
        })
      );
    },
  };
}

function harness(name: HarnessName, result: RunResult): Harness {
  return {
    name,
    capabilities: {
      nativeSchedule: NativeSchedule.None,
      availableModels: [DEFAULT_MODEL[name]],
      defaultModel: DEFAULT_MODEL[name],
    },
    isAvailable: async () => true,
    listModels: async () => [DEFAULT_MODEL[name]],
    run: async () => result,
  };
}

function makePromptsDir(character: string): string {
  const dir = mkdtempSync(join(tmpdir(), "crewd-audit-prompts-"));
  const promptPath = join(dir, `${character}.md`);
  // A nested character id (e.g. `kaitic/desktop-denny`) is a promptsDir-relative
  // path, so ensure its parent dir exists before writing the prompt.
  mkdirSync(dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, "# Docs Darwin\nAudit docs vs code.\n", "utf8");
  return dir;
}

const finding = (title: string, signature: string) =>
  JSON.stringify({ title, description: "d", signature });

/** A harness that captures the prompt it was handed, then writes one finding. */
function capturingHarness(
  name: HarnessName,
  sink: { prompt?: string }
): Harness {
  return {
    name,
    capabilities: {
      nativeSchedule: NativeSchedule.None,
      availableModels: [DEFAULT_MODEL[name]],
      defaultModel: DEFAULT_MODEL[name],
    },
    isAvailable: async () => true,
    listModels: async () => [DEFAULT_MODEL[name]],
    run: (o: RunOpts) => {
      sink.prompt = o.prompt;
      const path = findingsPathFromPrompt(o.prompt);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${finding("A", "a")}\n`, "utf8");
      return Promise.resolve(res({ ok: true, exitCode: 0 }));
    },
  };
}

/** Init a real git repo with a committed `main` branch and one extra changed file. */
function makeGitRepoWithChange(): { repoDir: string; changedFile: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "crewd-audit-git-"));
  const run = (args: string[]) => runGitFixture(repoDir, args);
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@t.test"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(repoDir, "base.txt"), "base\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-m", "base"]);
  run(["checkout", "-b", "feature"]);
  const changedFile = "src/changed.ts";
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, changedFile), "export const x = 1;\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-m", "change"]);
  return { repoDir, changedFile };
}

describe("runAuditPass", () => {
  it("runs the cascade against the repo and returns parsed findings", async () => {
    const promptsDir = makePromptsDir("docs-darwin");
    const codex = writingHarness("codex", [
      finding("Stale README", "readme-stale"),
      finding("Dead flag", "flag-dead"),
    ]);

    const result = await runAuditPass({
      character: "docs-darwin",
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex", "claude"],
      registry: registry({ codex }),
    });

    expect(result.ok).toBe(true);
    expect(result.harnessUsed).toBe("codex");
    expect(result.findings.map((f) => f.title)).toEqual([
      "Stale README",
      "Dead flag",
    ]);
    expect(result.error).toBeNull();
  });

  it("streams start, output, attempt, and done progress events", async () => {
    const promptsDir = makePromptsDir("docs-darwin");
    const codex = writingHarness("codex", [finding("A", "a")]);
    const events: AuditProgressEvent[] = [];

    await runAuditPass({
      character: "docs-darwin",
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex"],
      registry: registry({ codex }),
      onProgress: (e) => events.push(e),
    });

    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe("start");
    expect(phases).toContain("output");
    expect(phases).toContain("attempt");
    const done = events.at(-1);
    expect(done).toMatchObject({
      phase: "done",
      ok: true,
      harnessUsed: "codex",
      findingsCount: 1,
    });
  });

  it("forwards the caller's env (e.g. PATH) to the harness child", async () => {
    const promptsDir = makePromptsDir("docs-darwin");
    let seenEnv: Record<string, string> | undefined;
    const codex: Harness = {
      name: "codex",
      capabilities: {
        nativeSchedule: NativeSchedule.None,
        availableModels: [DEFAULT_MODEL.codex],
        defaultModel: DEFAULT_MODEL.codex,
      },
      isAvailable: async () => true,
      listModels: async () => [DEFAULT_MODEL.codex],
      run: (o: RunOpts) => {
        seenEnv = o.env;
        const path = findingsPathFromPrompt(o.prompt);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${finding("A", "a")}\n`, "utf8");
        return Promise.resolve(res({ ok: true, exitCode: 0 }));
      },
    };

    await runAuditPass({
      character: "docs-darwin",
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex"],
      registry: registry({ codex }),
      env: { PATH: "/opt/bin:/usr/bin" },
    });

    expect(seenEnv).toEqual({ PATH: "/opt/bin:/usr/bin" });
  });

  it("returns a setup error when the character prompt is missing", async () => {
    const promptsDir = makePromptsDir("docs-darwin");
    const result = await runAuditPass({
      character: "nonexistent",
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex"],
      registry: registry({}),
    });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.error).toContain("character prompt not found");
  });

  // ── FEA-3850 (M4): scope presets ──

  it("whole-repo scope injects no scope directive (M1 behavior)", async () => {
    const promptsDir = makePromptsDir("docs-darwin");
    const sink: { prompt?: string } = {};
    await runAuditPass({
      character: "docs-darwin",
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex"],
      registry: registry({ codex: capturingHarness("codex", sink) }),
      scopePreset: AuditScope.WholeRepo,
    });
    expect(sink.prompt).toBeDefined();
    expect(sink.prompt).not.toContain("SCOPE:");
  });

  it("docs scope steers the reviewer to documentation surfaces", async () => {
    const promptsDir = makePromptsDir("docs-darwin");
    const sink: { prompt?: string } = {};
    await runAuditPass({
      character: "docs-darwin",
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex"],
      registry: registry({ codex: capturingHarness("codex", sink) }),
      scopePreset: AuditScope.Docs,
    });
    expect(sink.prompt).toContain("SCOPE: focus on documentation surfaces");
  });

  it(
    "changed-since-main scope seeds hot spots from the git diff vs. main",
    async () => {
      const promptsDir = makePromptsDir("code-cassandra");
      const { repoDir, changedFile } = makeGitRepoWithChange();
      const sink: { prompt?: string } = {};
      await runAuditPass({
        character: "code-cassandra",
        repoDir,
        promptsDir,
        cascade: ["codex"],
        registry: registry({ codex: capturingHarness("codex", sink) }),
        scopePreset: AuditScope.ChangedSinceMain,
      });
      // The directive is present AND the changed file is listed in scope, while
      // the unchanged base file is not scoped in.
      expect(sink.prompt).toContain(
        "SCOPE: review ONLY the files changed vs. the merge-base"
      );
      expect(sink.prompt).toContain("Files in scope (review ALL of these):");
      expect(sink.prompt).toContain(changedFile);
      expect(sink.prompt).not.toContain("base.txt");
    },
    GIT_SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "changed-since-main degrades to a whole-repo review when main is unresolvable",
    async () => {
      const promptsDir = makePromptsDir("code-cassandra");
      // A non-git dir: changedSinceMain resolves no main ref.
      const repoDir = mkdtempSync(join(tmpdir(), "crewd-audit-nogit-"));
      const sink: { prompt?: string } = {};
      await runAuditPass({
        character: "code-cassandra",
        repoDir,
        promptsDir,
        cascade: ["codex"],
        registry: registry({ codex: capturingHarness("codex", sink) }),
        scopePreset: AuditScope.ChangedSinceMain,
      });
      expect(sink.prompt).toContain(
        "no diff vs. main could be resolved — review the whole repository"
      );
    },
    GIT_SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "changed-since-main returns an empty result (no cascade) when the branch is clean",
    async () => {
      const promptsDir = makePromptsDir("code-cassandra");
      // A repo whose HEAD equals main: main resolves, but nothing changed.
      const repoDir = mkdtempSync(join(tmpdir(), "crewd-audit-clean-"));
      const run = (args: string[]) => runGitFixture(repoDir, args);
      run(["init", "-b", "main"]);
      run(["config", "user.email", "t@t.test"]);
      run(["config", "user.name", "T"]);
      writeFileSync(join(repoDir, "base.txt"), "base\n", "utf8");
      run(["add", "-A"]);
      run(["commit", "-m", "base"]);
      const sink: { prompt?: string } = {};
      const result = await runAuditPass({
        character: "code-cassandra",
        repoDir,
        promptsDir,
        cascade: ["codex"],
        registry: registry({ codex: capturingHarness("codex", sink) }),
        scopePreset: AuditScope.ChangedSinceMain,
      });
      // No files in scope ⇒ review nothing: the cascade never ran (no prompt
      // captured), and the result is an empty success, NOT a widened whole-repo run.
      expect(sink.prompt).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.harnessUsed).toBeNull();
      expect(result.findings).toEqual([]);
    },
    GIT_SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "changed-since-main lists ALL changed files (uncapped past the 40 hot-spot cap)",
    async () => {
      const promptsDir = makePromptsDir("code-cassandra");
      const repoDir = mkdtempSync(join(tmpdir(), "crewd-audit-many-"));
      const run = (args: string[]) => runGitFixture(repoDir, args);
      run(["init", "-b", "main"]);
      run(["config", "user.email", "t@t.test"]);
      run(["config", "user.name", "T"]);
      writeFileSync(join(repoDir, "base.txt"), "base\n", "utf8");
      run(["add", "-A"]);
      run(["commit", "-m", "base"]);
      run(["checkout", "-b", "feature"]);
      mkdirSync(join(repoDir, "src"), { recursive: true });
      const changedFiles: string[] = [];
      for (let i = 0; i < 45; i++) {
        const rel = `src/file-${i}.ts`;
        changedFiles.push(rel);
        writeFileSync(
          join(repoDir, rel),
          `export const x${i} = ${i};\n`,
          "utf8"
        );
      }
      run(["add", "-A"]);
      run(["commit", "-m", "45 files"]);
      const sink: { prompt?: string } = {};
      await runAuditPass({
        character: "code-cassandra",
        repoDir,
        promptsDir,
        cascade: ["codex"],
        registry: registry({ codex: capturingHarness("codex", sink) }),
        scopePreset: AuditScope.ChangedSinceMain,
      });
      expect(sink.prompt).toBeDefined();
      // Every one of the 45 changed files is in the scoped list — the tail past
      // the 40-file hot-spot cap must NOT be dropped.
      for (const rel of changedFiles) {
        expect(sink.prompt).toContain(rel);
      }
    },
    GIT_SPAWN_TEST_TIMEOUT_MS
  );

  it("reports cascade exhaustion with no findings", async () => {
    const promptsDir = makePromptsDir("docs-darwin");
    const codex = harness("codex", res({ ok: false, outputTail: "boom" }));
    const result = await runAuditPass({
      character: "docs-darwin",
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex"],
      registry: registry({ codex }),
    });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.error).toBe("cascade exhausted");
  });

  it("runs a nested (subfolder) character id without an fs-name crash (FEA-4013)", async () => {
    // The full audit cast lives in author subfolders, so the id carries a `/`
    // (e.g. `kaitic/desktop-denny`). The raw id must resolve the prompt as a
    // path, while temp-dir/findings names flatten it — a `/` in a mkdtemp prefix
    // would demand a non-existent parent and throw before any cascade ran.
    const character = "kaitic/desktop-denny";
    const promptsDir = makePromptsDir(character);
    const codex = writingHarness("codex", [finding("Boot bug", "boot-bug")]);
    const result = await runAuditPass({
      character,
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex", "claude"],
      registry: registry({ codex }),
    });
    expect(result.ok).toBe(true);
    expect(result.character).toBe(character);
    expect(result.findings.map((f) => f.title)).toEqual(["Boot bug"]);
  });

  it("an eliciting harness attempt cascades instead of hanging (FEA-4012)", async () => {
    // codex exits 0 but ends by interviewing the operator and writes NO
    // findings — a non-interactive run has nothing to answer it. The pass must
    // RESOLVE (the attempt fails and cascades to claude), never hang.
    const promptsDir = makePromptsDir("docs-darwin");
    const codex = elicitingHarness("codex");
    const claude = writingHarness("claude", [finding("Real finding", "real")]);
    const result = await runAuditPass({
      character: "docs-darwin",
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex", "claude"],
      registry: registry({ codex, claude }),
    });
    expect(result.harnessUsed).toBe("claude");
    expect(result.attempts.map((a) => a.outcome)).toEqual([
      "failed",
      "success",
    ]);
    expect(result.attempts[0]?.note).toMatch(ELICIT_NOTE_RE);
    expect(result.findings.map((f) => f.title)).toEqual(["Real finding"]);
  });

  it("a run where every harness only elicits resolves as failed, not hung (FEA-4012)", async () => {
    const promptsDir = makePromptsDir("docs-darwin");
    const codex = elicitingHarness("codex");
    const claude = elicitingHarness("claude");
    const result = await runAuditPass({
      character: "docs-darwin",
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex", "claude"],
      registry: registry({ codex, claude }),
    });
    expect(result.ok).toBe(false);
    expect(result.harnessUsed).toBe(null);
    expect(result.attempts.map((a) => a.outcome)).toEqual(["failed", "failed"]);
    expect(result.findings).toEqual([]);
  });

  it("prepends the non-interactive directive so harnesses do not interview (FEA-4012)", async () => {
    const promptsDir = makePromptsDir("docs-darwin");
    const sink: { prompt?: string } = {};
    const codex = capturingHarness("codex", sink);
    await runAuditPass({
      character: "docs-darwin",
      repoDir: "/tmp",
      promptsDir,
      cascade: ["codex"],
      registry: registry({ codex }),
    });
    expect(sink.prompt).toContain("Non-interactive audit");
    expect(sink.prompt).toMatch(NO_INTERVIEW_RE);
  });
});
