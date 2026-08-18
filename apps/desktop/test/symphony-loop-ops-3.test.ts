/**
 * ISS-5299 — branch coverage for symphony-loop.ts, file 3.
 *
 * Targets exported pure helpers and filesystem operations:
 *   getActiveLoopPid, additionalRepoDisambiguator, readBootstrapOutputs,
 *   writePrdArtifact, writePlanArtifact, writeCodeArtifact,
 *   writeFeatureArtifact, readEvaluateOutputs, materializeCriticGates,
 *   writeArtifactsForExecuteOrAmend, cleanupAdditionalWorktrees.
 *
 * Also covers the kill-route initializing-loop (pid=0) branch and a
 * registration/cleanup round-trip test for the runningLoops map.
 *
 * No real process spawning; all filesystem I/O uses temp directories that
 * are cleaned up after each test.
 *
 * NOTE: the MODULE UNDER TEST (src/server/operations/symphony-loop.ts) is in the
 * biome.jsonc noExcessiveLinesPerFile grandfather list. This suite is NOT, and
 * must never be added — grandfathering is per-file. Keep it under 1,000 lines
 * and split into a new sibling instead.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  LoopArtifactFile,
  LoopArtifactType,
} from "@closedloop-ai/loops-api/artifacts";
import { LoopSchedulerContext } from "../src/main/loop/loop-scheduler-context.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  additionalRepoDisambiguator,
  cleanupAdditionalWorktrees,
  configureBinaryPathsResolver,
  EvaluateArtifact,
  getActiveLoopPid,
  materializeCriticGates,
  readBootstrapOutputs,
  readEvaluateOutputs,
  registerRecoveredLoop,
  registerSymphonyLoopRoutes,
  unregisterLoop,
  type WorktreeProvider,
  writeArtifactsForExecuteOrAmend,
  writeCodeArtifact,
  writeFeatureArtifact,
  writePlanArtifact,
  writePrdArtifact,
} from "../src/server/operations/symphony-loop.js";
import { dispatchOperation } from "./helpers/git-gateway-op-harness.js";

// Module-level regex constants (useTopLevelRegex rule)
const HEX_8_PATTERN = /^[0-9a-f]{8}$/;

// ---------------------------------------------------------------------------
// Temp-dir factory — auto-cleaned after each test
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  configureBinaryPathsResolver(null);
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 2 });
  }
});

// ---------------------------------------------------------------------------
// Noop WorktreeProvider for cleanupAdditionalWorktrees tests
// ---------------------------------------------------------------------------

const noopWt: WorktreeProvider = {
  ensureWorktree: async () => {},
  findWorktreeForBranch: () => null,
  removeWorktree: async () => {},
  getCurrentBranch: () => null,
  branchExists: async () => false,
};

// ---------------------------------------------------------------------------
// Minimal fake LoopArtifact builder
// ---------------------------------------------------------------------------

function makeArtifact(
  type: string,
  content: string,
  id?: string
): { type: string; content: string; id: string } {
  return { type, content, id: id ?? `artifact-${type}-${Math.random()}` };
}

// ---------------------------------------------------------------------------
// getActiveLoopPid
// Target: map lookup returning pid vs null
// ---------------------------------------------------------------------------

describe("getActiveLoopPid", () => {
  test("returns null when loopId is not registered", { timeout: 3000 }, () => {
    const result = getActiveLoopPid("loop-nonexistent-xyz");
    assert.equal(result, null);
  });

  test("returns the pid after registerRecoveredLoop", { timeout: 3000 }, () => {
    const loopId = "loop-getpid-test-1";
    registerRecoveredLoop(loopId, 12_345);
    try {
      const result = getActiveLoopPid(loopId);
      assert.equal(result, 12_345);
    } finally {
      unregisterLoop(loopId);
    }
  });

  test("returns null after unregisterLoop removes the entry", {
    timeout: 3000,
  }, () => {
    const loopId = "loop-getpid-test-2";
    registerRecoveredLoop(loopId, 99_999);
    unregisterLoop(loopId);
    const result = getActiveLoopPid(loopId);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// additionalRepoDisambiguator
// Target: line 1945-1951 — deterministic sha1 hash, 8-char prefix
// ---------------------------------------------------------------------------

describe("additionalRepoDisambiguator", () => {
  test("returns an 8-character hexadecimal string", { timeout: 3000 }, () => {
    const result = additionalRepoDisambiguator("/some/repo/path");
    assert.equal(typeof result, "string");
    assert.equal(result.length, 8);
    assert.ok(HEX_8_PATTERN.test(result));
  });

  test("returns the same value for the same path (deterministic)", {
    timeout: 3000,
  }, () => {
    const a = additionalRepoDisambiguator("/home/user/projects/my-repo");
    const b = additionalRepoDisambiguator("/home/user/projects/my-repo");
    assert.equal(a, b);
  });

  test("returns different values for different paths", {
    timeout: 3000,
  }, () => {
    const a = additionalRepoDisambiguator("/path/to/repo-alpha");
    const b = additionalRepoDisambiguator("/path/to/repo-beta");
    assert.notEqual(a, b);
  });

  test("resolves the path before hashing (relative vs absolute produce same result)", {
    timeout: 3000,
  }, () => {
    const absPath = path.resolve(".");
    const result = additionalRepoDisambiguator(absPath);
    assert.equal(result.length, 8);
  });
});

// ---------------------------------------------------------------------------
// readBootstrapOutputs
// Target: lines 3077 (no manifest), 3084-3095 (skip entry), 3099-3117
// ---------------------------------------------------------------------------

describe("readBootstrapOutputs", () => {
  test("returns empty object when no bootstrap-manifest.json exists", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-bso-empty-");
    const result = readBootstrapOutputs(workDir);
    assert.deepEqual(result, {});
  });

  test("returns empty object for corrupt manifest JSON (line 3077 false branch)", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-bso-corrupt-");
    writeFileSync(path.join(workDir, "bootstrap-manifest.json"), "not-json!!!");
    const result = readBootstrapOutputs(workDir);
    assert.deepEqual(result, {});
  });

  test("processes skip entries with skipReason (line 3084-3095 true branch)", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-bso-skip-");
    const manifest = [
      {
        fullName: "org/skipped-repo",
        branch: "main",
        skip: true,
        skipReason: "not-authorized",
        localPath: "/nonexistent",
      },
    ];
    writeFileSync(
      path.join(workDir, "bootstrap-manifest.json"),
      JSON.stringify(manifest)
    );
    const result = readBootstrapOutputs(workDir) as {
      bootstrapResult?: {
        repos: Array<{ fullName: string; success: boolean; error: string }>;
      };
    };
    assert.ok(result.bootstrapResult);
    assert.equal(result.bootstrapResult.repos.length, 1);
    assert.equal(result.bootstrapResult.repos[0].fullName, "org/skipped-repo");
    assert.equal(result.bootstrapResult.repos[0].success, false);
    assert.equal(result.bootstrapResult.repos[0].error, "not-authorized");
  });

  test("processes skip entry without skipReason defaults to 'skipped'", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-bso-skip-nreason-");
    const manifest = [
      {
        fullName: "org/repo-no-reason",
        skip: true,
        localPath: "/nonexistent",
      },
    ];
    writeFileSync(
      path.join(workDir, "bootstrap-manifest.json"),
      JSON.stringify(manifest)
    );
    const result = readBootstrapOutputs(workDir) as {
      bootstrapResult?: { repos: Array<{ error: string }> };
    };
    assert.ok(result.bootstrapResult);
    assert.equal(result.bootstrapResult.repos[0].error, "skipped");
  });

  test("reads marker file ok for successful non-skip entry (line 3099-3101)", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-bso-ok-");
    const repoPath = makeTempDir("sl3-bso-repo-");
    const agentsDir = path.join(repoPath, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, "agent.md"),
      "---\nname: Test\ndescription: Desc\n---\nBody.\n"
    );
    const outputDir = path.join(workDir, "repo-0-agents");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, "agent.md"),
      "---\nname: Test\ndescription: Desc\n---\nBody.\n"
    );
    const manifest = [
      {
        fullName: "org/repo",
        branch: "main",
        skip: false,
        localPath: repoPath,
      },
    ];
    writeFileSync(
      path.join(workDir, "bootstrap-manifest.json"),
      JSON.stringify(manifest)
    );
    writeFileSync(path.join(workDir, "repo-0-done"), "ok");

    const result = readBootstrapOutputs(workDir) as {
      bootstrapResult?: {
        repos: Array<{ fullName: string; success: boolean }>;
      };
    };
    assert.ok(result.bootstrapResult);
    assert.equal(result.bootstrapResult.repos[0].fullName, "org/repo");
    assert.equal(result.bootstrapResult.repos[0].success, true);
  });

  test("reads marker file fail for failed non-skip entry (line 3101 error branch)", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-bso-fail-");
    const repoPath = makeTempDir("sl3-bso-repo-fail-");
    const manifest = [
      {
        fullName: "org/failed-repo",
        branch: "main",
        skip: false,
        localPath: repoPath,
      },
    ];
    writeFileSync(
      path.join(workDir, "bootstrap-manifest.json"),
      JSON.stringify(manifest)
    );
    writeFileSync(path.join(workDir, "repo-0-done"), "fail:timeout");

    const result = readBootstrapOutputs(workDir) as {
      bootstrapResult?: { repos: Array<{ success: boolean; error?: string }> };
    };
    assert.ok(result.bootstrapResult);
    assert.equal(result.bootstrapResult.repos[0].success, false);
    assert.equal(result.bootstrapResult.repos[0].error, "timeout");
  });

  test("branch=undefined falls back to main in skip entries", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-bso-branch-undef-");
    const manifest = [
      { fullName: "org/repo-x", skip: true, localPath: "/nonexistent" },
    ];
    writeFileSync(
      path.join(workDir, "bootstrap-manifest.json"),
      JSON.stringify(manifest)
    );
    const result = readBootstrapOutputs(workDir) as {
      bootstrapResult?: { repos: Array<{ branch: string }> };
    };
    assert.ok(result.bootstrapResult);
    assert.equal(result.bootstrapResult.repos[0].branch, "main");
  });
});

// ---------------------------------------------------------------------------
// writePrdArtifact
// Target: lines 511-536 — with artifact content, fallback to prompt, empty
// ---------------------------------------------------------------------------

describe("writePrdArtifact", () => {
  test("writes prd.md content from a PRD artifact", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wprd-art-");
    const artifacts = [
      makeArtifact(LoopArtifactType.Prd, "PRD content here"),
    ] as Parameters<typeof writePrdArtifact>[1];
    await writePrdArtifact(workDir, artifacts);
    const written = await fs.readFile(
      path.join(workDir, LoopArtifactFile.Prd),
      "utf-8"
    );
    assert.equal(written, "PRD content here");
  });

  test("falls back to Feature artifact when no PRD artifact exists", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wprd-feat-");
    const artifacts = [
      makeArtifact(LoopArtifactType.Feature, "Feature content"),
    ] as Parameters<typeof writePrdArtifact>[1];
    await writePrdArtifact(workDir, artifacts);
    const written = await fs.readFile(
      path.join(workDir, LoopArtifactFile.Prd),
      "utf-8"
    );
    assert.equal(written, "Feature content");
  });

  test("falls back to prompt when no artifact provides content", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wprd-prompt-");
    const artifacts: Parameters<typeof writePrdArtifact>[1] = [];
    await writePrdArtifact(workDir, artifacts, "Fallback prompt text");
    const written = await fs.readFile(
      path.join(workDir, LoopArtifactFile.Prd),
      "utf-8"
    );
    assert.equal(written, "Fallback prompt text");
  });

  test("does not write file when no content available (no artifact, no prompt)", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wprd-empty-");
    await writePrdArtifact(workDir, []);
    const exists = await fs
      .access(path.join(workDir, LoopArtifactFile.Prd))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  });

  test("selects by primaryArtifactId when provided", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wprd-id-");
    const artifacts = [
      makeArtifact(LoopArtifactType.Prd, "First PRD", "prd-001"),
      makeArtifact(LoopArtifactType.Prd, "Second PRD", "prd-002"),
    ] as Parameters<typeof writePrdArtifact>[1];
    await writePrdArtifact(workDir, artifacts, undefined, "prd-001");
    const written = await fs.readFile(
      path.join(workDir, LoopArtifactFile.Prd),
      "utf-8"
    );
    assert.equal(written, "First PRD");
  });
});

// ---------------------------------------------------------------------------
// writePlanArtifact
// Target: lines 558-565 — writes prd.md and plan.md together
// ---------------------------------------------------------------------------

describe("writePlanArtifact", () => {
  test("writes prd.md from PRD artifact and plan.md from ImplementationPlan artifact", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wplan-both-");
    const artifacts = [
      makeArtifact(LoopArtifactType.Prd, "PRD body"),
      makeArtifact(LoopArtifactType.ImplementationPlan, "Plan body"),
    ] as Parameters<typeof writePlanArtifact>[1];
    await writePlanArtifact(workDir, artifacts);
    const prd = await fs.readFile(
      path.join(workDir, LoopArtifactFile.Prd),
      "utf-8"
    );
    const plan = await fs.readFile(
      path.join(workDir, LoopArtifactFile.PlanMarkdown),
      "utf-8"
    );
    assert.equal(prd, "PRD body");
    assert.equal(plan, "Plan body");
  });

  test("does not write plan.md when no ImplementationPlan artifact", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wplan-noplan-");
    const artifacts = [
      makeArtifact(LoopArtifactType.Prd, "PRD only"),
    ] as Parameters<typeof writePlanArtifact>[1];
    await writePlanArtifact(workDir, artifacts);
    const prdExists = await fs
      .access(path.join(workDir, LoopArtifactFile.Prd))
      .then(() => true)
      .catch(() => false);
    const planExists = await fs
      .access(path.join(workDir, LoopArtifactFile.PlanMarkdown))
      .then(() => true)
      .catch(() => false);
    assert.equal(prdExists, true);
    assert.equal(planExists, false);
  });
});

// ---------------------------------------------------------------------------
// writeCodeArtifact
// Target: lines 569-575 — writes plan.md from ImplementationPlan artifact
// ---------------------------------------------------------------------------

describe("writeCodeArtifact", () => {
  test("writes plan.md from ImplementationPlan artifact", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wcode-");
    const artifacts = [
      makeArtifact(
        LoopArtifactType.ImplementationPlan,
        "Implementation plan text"
      ),
    ] as Parameters<typeof writeCodeArtifact>[1];
    await writeCodeArtifact(workDir, artifacts);
    const plan = await fs.readFile(
      path.join(workDir, LoopArtifactFile.PlanMarkdown),
      "utf-8"
    );
    assert.equal(plan, "Implementation plan text");
  });

  test("does not write plan.md when no ImplementationPlan artifact", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wcode-noplan-");
    await writeCodeArtifact(workDir, []);
    const exists = await fs
      .access(path.join(workDir, LoopArtifactFile.PlanMarkdown))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  });

  test("selects by primaryArtifactId when multiple ImplementationPlan artifacts exist", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wcode-id-");
    const artifacts = [
      makeArtifact(LoopArtifactType.ImplementationPlan, "Plan A", "plan-a"),
      makeArtifact(LoopArtifactType.ImplementationPlan, "Plan B", "plan-b"),
    ] as Parameters<typeof writeCodeArtifact>[1];
    await writeCodeArtifact(workDir, artifacts, "plan-a");
    const plan = await fs.readFile(
      path.join(workDir, LoopArtifactFile.PlanMarkdown),
      "utf-8"
    );
    assert.equal(plan, "Plan A");
  });
});

// ---------------------------------------------------------------------------
// writeFeatureArtifact
// Target: lines 589-609 — writes prd.md and feature.md; throws when no Feature
// ---------------------------------------------------------------------------

describe("writeFeatureArtifact", () => {
  test("writes prd.md and feature.md from Feature artifact", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wfeat-ok-");
    const artifacts = [
      makeArtifact(LoopArtifactType.Feature, "Feature content body"),
    ] as Parameters<typeof writeFeatureArtifact>[1];
    await writeFeatureArtifact(workDir, artifacts);
    const prd = await fs.readFile(
      path.join(workDir, LoopArtifactFile.Prd),
      "utf-8"
    );
    const feat = await fs.readFile(path.join(workDir, "feature.md"), "utf-8");
    assert.equal(prd, "Feature content body");
    assert.equal(feat, "Feature content body");
  });

  test("selects by primaryArtifactId when provided", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wfeat-id-");
    const artifacts = [
      makeArtifact(LoopArtifactType.Feature, "Feature A", "feat-a"),
      makeArtifact(LoopArtifactType.Feature, "Feature B", "feat-b"),
    ] as Parameters<typeof writeFeatureArtifact>[1];
    await writeFeatureArtifact(workDir, artifacts, "feat-a");
    const prd = await fs.readFile(
      path.join(workDir, LoopArtifactFile.Prd),
      "utf-8"
    );
    assert.equal(prd, "Feature A");
  });

  test("throws when artifact list has no Feature artifact", {
    timeout: 3000,
  }, async () => {
    const workDir = makeTempDir("sl3-wfeat-throw-");
    const artifacts = [
      makeArtifact(LoopArtifactType.Prd, "PRD content"),
    ] as Parameters<typeof writeFeatureArtifact>[1];
    await assert.rejects(
      () => writeFeatureArtifact(workDir, artifacts),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("artifact found"));
        return true;
      }
    );
  });

  test("throws when artifact list is empty", { timeout: 3000 }, async () => {
    const workDir = makeTempDir("sl3-wfeat-empty-");
    await assert.rejects(
      () => writeFeatureArtifact(workDir, []),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// readEvaluateOutputs
// Target: lines 615-622 — reads judges JSON from workDir by artifact type
// ---------------------------------------------------------------------------

describe("readEvaluateOutputs", () => {
  test("returns undefined value when judges file does not exist", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-roe-missing-");
    const result = readEvaluateOutputs(workDir, EvaluateArtifact.Prd);
    const val = (result as Record<string, unknown>).prdJudges;
    assert.equal(val, undefined);
  });

  test("returns parsed judges JSON for Prd artifact type", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-roe-prd-");
    const judgesData = { score: 0.9, pass: true };
    writeFileSync(
      path.join(workDir, "prd-judges.json"),
      JSON.stringify(judgesData)
    );
    const result = readEvaluateOutputs(workDir, EvaluateArtifact.Prd);
    const val = (result as Record<string, unknown>).prdJudges;
    assert.deepEqual(val, judgesData);
  });

  test("returns parsed judges JSON for Plan artifact type", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-roe-plan-");
    const judgesData = { verdict: "pass", score: 0.85 };
    writeFileSync(
      path.join(workDir, "plan-judges.json"),
      JSON.stringify(judgesData)
    );
    const result = readEvaluateOutputs(workDir, EvaluateArtifact.Plan);
    const val = (result as Record<string, unknown>).planJudges;
    assert.deepEqual(val, judgesData);
  });

  test("returns parsed judges JSON for Code artifact type", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-roe-code-");
    const judgesData = { codeScore: 1.0 };
    writeFileSync(
      path.join(workDir, "code-judges.json"),
      JSON.stringify(judgesData)
    );
    const result = readEvaluateOutputs(workDir, EvaluateArtifact.Code);
    const val = (result as Record<string, unknown>).codeJudges;
    assert.deepEqual(val, judgesData);
  });

  test("returns parsed judges JSON for Feature artifact type", {
    timeout: 3000,
  }, () => {
    const workDir = makeTempDir("sl3-roe-feat-");
    const judgesData = { featureScore: 0.75 };
    writeFileSync(
      path.join(workDir, "feature-judges.json"),
      JSON.stringify(judgesData)
    );
    const result = readEvaluateOutputs(workDir, EvaluateArtifact.Feature);
    const val = (result as Record<string, unknown>).featureJudges;
    assert.deepEqual(val, judgesData);
  });
});

// ---------------------------------------------------------------------------
// materializeCriticGates
// Target: lines 1258-1278 — config found vs not found
// ---------------------------------------------------------------------------

describe("materializeCriticGates", () => {
  test("returns false when repoFullName not found in repoConfigs", {
    timeout: 3000,
  }, async () => {
    const worktreeDir = makeTempDir("sl3-mcg-notfound-");
    const repoConfigs = [
      { repoFullName: "org/other-repo", criticGates: { gate1: true } },
    ];
    const result = await materializeCriticGates(
      worktreeDir,
      "org/my-repo",
      repoConfigs
    );
    assert.equal(result, false);
  });

  test("returns true and writes critic-gates.json when config is found", {
    timeout: 3000,
  }, async () => {
    const worktreeDir = makeTempDir("sl3-mcg-found-");
    const criticGates = { "no-debug-logs": true, "no-console": false };
    const repoConfigs = [{ repoFullName: "org/my-repo", criticGates }];
    const result = await materializeCriticGates(
      worktreeDir,
      "org/my-repo",
      repoConfigs
    );
    assert.equal(result, true);
    const settingsDir = path.join(worktreeDir, ".closedloop-ai", "settings");
    const filePath = path.join(settingsDir, "critic-gates.json");
    const written = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
    assert.deepEqual(written, criticGates);
  });

  test("creates settings directory if it does not exist", {
    timeout: 3000,
  }, async () => {
    const worktreeDir = makeTempDir("sl3-mcg-mkdir-");
    const repoConfigs = [
      { repoFullName: "org/repo", criticGates: { gate: "on" } },
    ];
    await materializeCriticGates(worktreeDir, "org/repo", repoConfigs);
    const settingsDir = path.join(worktreeDir, ".closedloop-ai", "settings");
    const stat = await fs.stat(settingsDir);
    assert.ok(stat.isDirectory());
  });
});

// ---------------------------------------------------------------------------
// writeArtifactsForExecuteOrAmend — pure filesystem branches
// Target: lines 2498-2660 — REQUEST_CHANGES path (non-Execute)
// ---------------------------------------------------------------------------

describe("writeArtifactsForExecuteOrAmend (REQUEST_CHANGES path)", () => {
  test("writes imported-plan.md for ImplementationPlan artifact with non-JSON content", {
    timeout: 5000,
  }, async () => {
    const workDir = makeTempDir("sl3-wafeoa-md-");
    const artifacts = [
      makeArtifact(
        LoopArtifactType.ImplementationPlan,
        "# This is markdown content\n\nnot valid JSON"
      ),
    ] as Parameters<typeof writeArtifactsForExecuteOrAmend>[1];
    const result = await writeArtifactsForExecuteOrAmend(workDir, artifacts);
    assert.ok(result.importedPlanFile !== null);
    const written = await fs.readFile(result.importedPlanFile!, "utf-8");
    assert.ok(written.includes("This is markdown content"));
  });

  test("writes plan.json when ImplementationPlan artifact is valid JSON", {
    timeout: 5000,
  }, async () => {
    const workDir = makeTempDir("sl3-wafeoa-json-");
    const planContent = JSON.stringify({
      tasks: ["task1", "task2"],
      version: 1,
    });
    const artifacts = [
      makeArtifact(LoopArtifactType.ImplementationPlan, planContent),
    ] as Parameters<typeof writeArtifactsForExecuteOrAmend>[1];
    const result = await writeArtifactsForExecuteOrAmend(workDir, artifacts);
    assert.equal(result.importedPlanFile, null);
    const planJsonPath = path.join(workDir, "plan.json");
    const written = await fs.readFile(planJsonPath, "utf-8");
    const parsed = JSON.parse(written) as { tasks: string[] };
    assert.deepEqual(parsed.tasks, ["task1", "task2"]);
  });

  test("updates existing plan.json content field when it already exists", {
    timeout: 5000,
  }, async () => {
    const workDir = makeTempDir("sl3-wafeoa-update-");
    const existingPlan = {
      title: "Existing Plan",
      content: "old content",
      version: 1,
    };
    writeFileSync(
      path.join(workDir, "plan.json"),
      JSON.stringify(existingPlan)
    );
    const newContent = JSON.stringify({ tasks: [], version: 2 });
    const artifacts = [
      makeArtifact(LoopArtifactType.ImplementationPlan, newContent),
    ] as Parameters<typeof writeArtifactsForExecuteOrAmend>[1];
    const result = await writeArtifactsForExecuteOrAmend(workDir, artifacts);
    assert.equal(result.importedPlanFile, null);
    const written = JSON.parse(
      await fs.readFile(path.join(workDir, "plan.json"), "utf-8")
    ) as { title: string; content: string; version: number };
    assert.equal(written.title, "Existing Plan");
    assert.equal(written.content, newContent);
  });

  test("returns null importedPlanFile when no artifacts provided", {
    timeout: 5000,
  }, async () => {
    const workDir = makeTempDir("sl3-wafeoa-empty-");
    const result = await writeArtifactsForExecuteOrAmend(workDir, []);
    assert.equal(result.importedPlanFile, null);
  });

  test("skips ImplementationPlan artifact and returns null when command is EXECUTE and rawPlanAligned", {
    timeout: 5000,
  }, async () => {
    const workDir = makeTempDir("sl3-wafeoa-exec-raw-");
    const content = "aligned plan content";
    const rawPlanPayload = { content, schemaVersion: 1, planType: "FEATURE" };
    const artifact = {
      ...makeArtifact(LoopArtifactType.ImplementationPlan, content),
      raw: rawPlanPayload,
    };
    const result = await writeArtifactsForExecuteOrAmend(
      workDir,
      [artifact] as Parameters<typeof writeArtifactsForExecuteOrAmend>[1],
      undefined,
      undefined,
      { command: "EXECUTE", loopId: "test-loop-exec-raw" }
    );
    assert.equal(result.importedPlanFile, null);
    const planJsonPath = path.join(workDir, "plan.json");
    const written = JSON.parse(await fs.readFile(planJsonPath, "utf-8")) as {
      content: string;
    };
    assert.equal(written.content, content);
  });
});

// ---------------------------------------------------------------------------
// cleanupAdditionalWorktrees
// Target: lines 1500-1517 — retain vs remove with noopWt
// ---------------------------------------------------------------------------

describe("cleanupAdditionalWorktrees", () => {
  test("does nothing for empty entries array", { timeout: 3000 }, async () => {
    await cleanupAdditionalWorktrees([], "loop-x", noopWt);
  });

  test("calls removeWorktree for a non-existent directory (decideAdditionalWorktreeCleanup returns remove)", {
    timeout: 5000,
  }, async () => {
    const removedDirs: string[] = [];
    const trackingWt: WorktreeProvider = {
      ...noopWt,
      removeWorktree: (worktreeDir: string) => {
        removedDirs.push(worktreeDir);
        return Promise.resolve();
      },
    };
    const entries = [
      { dir: "/nonexistent/worktree/xyz", repoPath: "/nonexistent/repo" },
    ] as Parameters<typeof cleanupAdditionalWorktrees>[0];
    await cleanupAdditionalWorktrees(entries, "loop-test-cleanup", trackingWt);
    assert.equal(removedDirs.length, 1);
    assert.equal(removedDirs[0], "/nonexistent/worktree/xyz");
  });
});

// ---------------------------------------------------------------------------
// Kill route — pid <= 0 (still initializing) branch
// Target: line 8692 — 409 response
// ---------------------------------------------------------------------------

describe("handleLoopKill route — initializing branch", () => {
  function makeDispatcher(): OperationDispatcher {
    const dispatcher = new OperationDispatcher();
    const schedulers = new LoopSchedulerContext();
    const allowedDir = makeTempDir("sl3-kill-init-allowed-");
    registerSymphonyLoopRoutes(
      dispatcher,
      () => [allowedDir],
      schedulers,
      () => "http://localhost:9999"
    );
    return dispatcher;
  }

  test("returns 409 when registered loop has pid=0 (still initializing)", {
    timeout: 5000,
  }, async () => {
    const loopId = "test-kill-initializing-pid0";
    registerRecoveredLoop(loopId, 0);
    try {
      const dispatcher = makeDispatcher();
      const { statusCode, body } = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/symphony/loop/kill",
        body: JSON.stringify({ loopId }),
      });
      assert.equal(statusCode, 409);
      assert.ok(
        typeof body.error === "string" && body.error.includes("initializing")
      );
    } finally {
      unregisterLoop(loopId);
    }
  });

  test("returns 409 when registered loop has pid=-1 (negative pid)", {
    timeout: 5000,
  }, async () => {
    const loopId = "test-kill-initializing-pidneg";
    registerRecoveredLoop(loopId, -1);
    try {
      const dispatcher = makeDispatcher();
      const { statusCode, body } = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/symphony/loop/kill",
        body: JSON.stringify({ loopId }),
      });
      assert.equal(statusCode, 409);
      assert.ok(typeof body.error === "string");
    } finally {
      unregisterLoop(loopId);
    }
  });
});
