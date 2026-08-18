/**
 * ISS-5299 — branch coverage for symphony-loop.ts (gateway partition).
 *
 * Targets exported helpers and the handleLoopKill route handler, which together
 * hold the densest remaining uncovered branch clusters.
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
import type { LocalJob } from "../src/main/jobs/job-store.js";
import { LoopSchedulerContext } from "../src/main/loop/loop-scheduler-context.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  AdditionalRepoError,
  cloneRepoViaGh,
  configureBinaryPathsResolver,
  materializeAgents,
  readBootstrapRepoOutputs,
  registerRecoveredLoop,
  registerSymphonyLoopRoutes,
  resolveAdditionalRepos,
  unregisterLoop,
  type WorktreeProvider,
} from "../src/server/operations/symphony-loop.js";
import { dispatchOperation } from "./helpers/git-gateway-op-harness.js";

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
  // Reset binary paths so one test's override does not leak into the next
  configureBinaryPathsResolver(null);
  // Clean up any registered loops to avoid cross-test state pollution
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 2 });
  }
});

// ---------------------------------------------------------------------------
// Fake WorktreeProvider — never interacts with git
// ---------------------------------------------------------------------------

const noopWt: WorktreeProvider = {
  ensureWorktree: async () => {},
  findWorktreeForBranch: () => null,
  removeWorktree: async () => {},
  getCurrentBranch: () => null,
  branchExists: async () => false,
};

// ---------------------------------------------------------------------------
// Minimal fake JobStore for kill-handler tests
// ---------------------------------------------------------------------------

type MinimalJobStore = {
  getByLoopId(loopId: string): LocalJob | undefined;
  upsert(job: LocalJob): LocalJob;
};

function makeFakeJobStore(
  jobs: Map<string, Partial<LocalJob>>
): MinimalJobStore & { upserted: LocalJob[] } {
  const upserted: LocalJob[] = [];
  return {
    upserted,
    getByLoopId(loopId: string): LocalJob | undefined {
      const j = jobs.get(loopId);
      return j as LocalJob | undefined;
    },
    upsert(job: LocalJob): LocalJob {
      upserted.push(job);
      jobs.set(job.loopId, job);
      return job;
    },
  };
}

// ---------------------------------------------------------------------------
// readBootstrapRepoOutputs + parseAgentFrontmatter (private, via export)
// Target lines: 1148, 1156, 1173, 1183, 1190
// ---------------------------------------------------------------------------

describe("readBootstrapRepoOutputs", () => {
  test("returns empty agents when agents directory does not exist", () => {
    const repoPath = "/nonexistent/repo/path/that/will/never/exist";
    const result = readBootstrapRepoOutputs(repoPath);
    assert.deepEqual(result.agents, []);
    assert.equal(result.criticGates, null);
    assert.equal(result.metadata, null);
  });

  test("returns empty agents for dir with only non-.md files (line 1173 skip)", () => {
    const repoPath = makeTempDir("sl-ops-agents-nonmd-");
    const agentsDir = path.join(repoPath, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path.join(agentsDir, "readme.txt"), "not an agent");
    writeFileSync(path.join(agentsDir, "config.json"), "{}");

    const result = readBootstrapRepoOutputs(repoPath);
    assert.deepEqual(result.agents, []);
  });

  test("reads agents from .md files with complete frontmatter (line 1183 name fallback: false branch)", () => {
    const repoPath = makeTempDir("sl-ops-agents-fm-");
    const agentsDir = path.join(repoPath, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const content = [
      "---",
      "name: My Expert Agent",
      "description: Does expert things",
      "---",
      "Agent instructions here.",
    ].join("\n");
    writeFileSync(path.join(agentsDir, "my-expert.md"), content);

    const result = readBootstrapRepoOutputs(repoPath);
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0].slug, "my-expert");
    assert.equal(result.agents[0].name, "My Expert Agent");
    assert.equal(result.agents[0].description, "Does expert things");
  });

  test("uses slug as name fallback when frontmatter has no name field (line 1156 ?? branch)", () => {
    const repoPath = makeTempDir("sl-ops-agents-noname-");
    const agentsDir = path.join(repoPath, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    // Frontmatter present but no name: field
    const content = [
      "---",
      "description: A nameless helper",
      "---",
      "Body text.",
    ].join("\n");
    writeFileSync(path.join(agentsDir, "helper-slug.md"), content);

    const result = readBootstrapRepoOutputs(repoPath);
    assert.equal(result.agents.length, 1);
    // name falls through nameMatch?.[1]?.trim() ?? "" which gives "" → name || slug
    assert.equal(result.agents[0].name, "helper-slug");
    assert.equal(result.agents[0].description, "A nameless helper");
  });

  test("uses slug as name when file has no YAML frontmatter at all (line 1148 !fmMatch branch)", () => {
    const repoPath = makeTempDir("sl-ops-agents-nofm-");
    const agentsDir = path.join(repoPath, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    // No frontmatter block
    const content = "# Just a bare markdown agent\n\nDo things.\n";
    writeFileSync(path.join(agentsDir, "bare-agent.md"), content);

    const result = readBootstrapRepoOutputs(repoPath);
    assert.equal(result.agents.length, 1);
    // No frontmatter → name="" → name || slug = slug
    assert.equal(result.agents[0].name, "bare-agent");
    assert.equal(result.agents[0].description, "");
  });

  test("reads agents from explicit agentsDir override", () => {
    const repoPath = makeTempDir("sl-ops-agents-override-");
    const customAgentsDir = makeTempDir("sl-ops-custom-agents-");
    const content =
      "---\nname: Custom\ndescription: Custom agent\n---\nBody.\n";
    writeFileSync(path.join(customAgentsDir, "custom.md"), content);

    const result = readBootstrapRepoOutputs(repoPath, customAgentsDir);
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0].name, "Custom");
  });
});

// ---------------------------------------------------------------------------
// materializeAgents
// Target lines: 1240, 1244
// ---------------------------------------------------------------------------

describe("materializeAgents", () => {
  test("returns 0 for empty agents list", async () => {
    const worktreeDir = makeTempDir("sl-ops-mat-empty-");
    const n = await materializeAgents(worktreeDir, []);
    assert.equal(n, 0);
  });

  test("skips agents whose slug or prompt is not a string (type guard continue)", async () => {
    const worktreeDir = makeTempDir("sl-ops-mat-badtype-");
    // Cast through unknown to supply non-string values to test the guard
    const agents = [
      { slug: 42, name: "x", prompt: "body" },
      { slug: "valid", name: "x", prompt: 99 },
    ] as unknown as Parameters<typeof materializeAgents>[1];
    const n = await materializeAgents(worktreeDir, agents);
    assert.equal(n, 0);
    // No .claude/agents dir should have been created for these
  });

  test("skips agent whose slug is empty string — slugifyLoopId returns '' (line 1240 continue)", async () => {
    const worktreeDir = makeTempDir("sl-ops-mat-emptyslug-");
    // An empty slug after slugify is the only way !safeSlug is true
    const agents = [{ slug: "", name: "x", prompt: "body" }];
    const n = await materializeAgents(worktreeDir, agents);
    assert.equal(n, 0);
  });

  test("writes agent file and appends trailing newline when missing", async () => {
    const worktreeDir = makeTempDir("sl-ops-mat-newline-");
    const agents = [
      { slug: "my-agent", name: "My Agent", prompt: "Do stuff." },
    ];
    const n = await materializeAgents(worktreeDir, agents);
    assert.equal(n, 1);

    const written = await fs.readFile(
      path.join(worktreeDir, ".claude", "agents", "my-agent.md"),
      "utf-8"
    );
    assert.ok(written.endsWith("\n"), "trailing newline must be present");
    assert.ok(written.includes("Do stuff."));
  });

  test("preserves existing trailing newline without doubling it", async () => {
    const worktreeDir = makeTempDir("sl-ops-mat-existing-nl-");
    const agents = [{ slug: "clean", name: "C", prompt: "Body text.\n" }];
    const n = await materializeAgents(worktreeDir, agents);
    assert.equal(n, 1);

    const written = await fs.readFile(
      path.join(worktreeDir, ".claude", "agents", "clean.md"),
      "utf-8"
    );
    assert.equal(written, "Body text.\n");
  });
});

// ---------------------------------------------------------------------------
// cloneRepoViaGh — validation branches
// Target lines: 1330, 1336, 1345, 1351, 1362, 1395
// ---------------------------------------------------------------------------

describe("cloneRepoViaGh", () => {
  test("returns ok:false when allowedDirs is empty (line 1330 true branch)", async () => {
    const configDir = makeTempDir("sl-ops-clone-nodir-");
    const result = await cloneRepoViaGh("org/repo", [], "loop-123", configDir);
    assert.equal(result.ok, false);
    assert.ok(
      (result as { ok: false; reason: string }).reason.includes(
        "no allowed directories"
      )
    );
  });

  test("returns ok:false when fullName produces empty repoName (line 1336 true branch)", async () => {
    const configDir = makeTempDir("sl-ops-clone-norepo-");
    const allowedDir = makeTempDir("sl-ops-clone-allowed-a-");
    // "" after split("/").pop() is "" which is falsy
    const result = await cloneRepoViaGh(
      "",
      [allowedDir],
      "loop-123",
      configDir
    );
    assert.equal(result.ok, false);
    assert.ok(
      (result as { ok: false; reason: string }).reason.includes(
        "invalid fullName"
      )
    );
  });

  test("returns ok:false when allowed directory does not exist (line 1345 catch branch)", async () => {
    const configDir = makeTempDir("sl-ops-clone-missing-");
    const result = await cloneRepoViaGh(
      "org/repo",
      ["/nonexistent/allowed/dir/xyz-never-real"],
      "loop-123",
      configDir
    );
    assert.equal(result.ok, false);
    assert.ok(
      (result as { ok: false; reason: string }).reason.includes(
        "allowed directory"
      )
    );
  });

  test("returns ok:false when allowed path is a file not a directory (line 1351 true branch)", async () => {
    const configDir = makeTempDir("sl-ops-clone-isfile-");
    const tempFile = path.join(configDir, "not-a-dir.txt");
    writeFileSync(tempFile, "I am a file");

    const result = await cloneRepoViaGh(
      "org/repo",
      [tempFile],
      "loop-123",
      configDir
    );
    assert.equal(result.ok, false);
    assert.ok(
      (result as { ok: false; reason: string }).reason.includes(
        "allowed directory"
      )
    );
  });

  test("returns ok:false when clone destination already exists (line 1362 true branch)", async () => {
    const configDir = makeTempDir("sl-ops-clone-dest-exists-");
    const allowedDir = makeTempDir("sl-ops-clone-allowed-b-");
    // Pre-create the destination directory
    const destDir = path.join(allowedDir, "repo");
    mkdirSync(destDir, { recursive: true });

    const result = await cloneRepoViaGh(
      "org/repo",
      [allowedDir],
      "loop-123",
      configDir
    );
    assert.equal(result.ok, false);
    assert.ok(
      (result as { ok: false; reason: string }).reason.includes(
        "clone destination already exists"
      )
    );
  });

  test("returns ok:false when gh binary is not executable — catches execFileAsync error (line 1395)", {
    timeout: 10_000,
  }, async () => {
    const configDir = makeTempDir("sl-ops-clone-gh-err-");
    const allowedDir = makeTempDir("sl-ops-clone-allowed-c-");

    // /bin/false exits 1 immediately; tests where gh is missing get ENOENT
    configureBinaryPathsResolver(() => ({ gh: "/bin/false" }));

    const result = await cloneRepoViaGh(
      "org/nonexistent-test-repo-xyz",
      [allowedDir],
      "loop-123",
      configDir,
      5000 // short timeout
    );
    assert.equal(result.ok, false);
    // Reason is sanitized error text — just verify it's a non-ok response
    assert.equal(
      typeof (result as { ok: false; reason: string }).reason,
      "string"
    );
  });
});

// ---------------------------------------------------------------------------
// resolveAdditionalRepos — early-exit branches
// Target lines: 1690, 1705
// ---------------------------------------------------------------------------

describe("resolveAdditionalRepos", () => {
  test("returns empty array immediately for empty entries (line 1690 true branch)", async () => {
    const result = await resolveAdditionalRepos([], ["/tmp"], noopWt);
    assert.deepEqual(result, []);
  });

  test("throws AdditionalRepoError when entries exceed maximum (line 1705 throw branch)", async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      localRepoPath: `/some/path/${i}`,
      branch: "main",
    }));

    await assert.rejects(
      () => resolveAdditionalRepos(entries, ["/tmp"], noopWt),
      (err: unknown) => {
        assert.ok(err instanceof AdditionalRepoError);
        assert.ok(err.message.includes("exceeds maximum"));
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// handleLoopKill route handler
// Target lines: 699, 704, 8644, 8649, 8650, 8673, 8689, 8721
// ---------------------------------------------------------------------------

describe("handleLoopKill route", () => {
  function makeDispatcher(jobStore?: MinimalJobStore): OperationDispatcher {
    const dispatcher = new OperationDispatcher();
    const schedulers = new LoopSchedulerContext();
    const allowedDir = makeTempDir("sl-ops-kill-allowed-");
    registerSymphonyLoopRoutes(
      dispatcher,
      () => [allowedDir],
      schedulers,
      () => "http://localhost:9999",
      jobStore as never
    );
    return dispatcher;
  }

  test("returns 400 for empty request body (line 699 parseJsonBody null branch, line 8644)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = makeDispatcher();
    const { statusCode, body } = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/loop/kill",
      body: "",
    });
    assert.equal(statusCode, 400);
    assert.ok(
      typeof body.error === "string" && body.error.includes("Invalid JSON body")
    );
  });

  test("returns 400 for invalid JSON body (line 704 parseJsonBody catch branch)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = makeDispatcher();
    const { statusCode, body } = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/loop/kill",
      body: "not-json!!!",
    });
    assert.equal(statusCode, 400);
    assert.ok(
      typeof body.error === "string" && body.error.includes("Invalid JSON body")
    );
  });

  test("returns 400 when loopId is missing from body (line 8649 !loopId true branch)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = makeDispatcher();
    const { statusCode, body } = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/loop/kill",
      body: JSON.stringify({ other: "data" }),
    });
    assert.equal(statusCode, 400);
    assert.ok(
      typeof body.error === "string" &&
        body.error.includes("loopId is required")
    );
  });

  test("returns 404 when loopId not in runningLoops and no jobStore (line 8650 entry === undefined branch)", {
    timeout: 5000,
  }, async () => {
    const dispatcher = makeDispatcher();
    const { statusCode, body } = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/loop/kill",
      body: JSON.stringify({ loopId: "nonexistent-loop-xyz" }),
    });
    assert.equal(statusCode, 404);
    assert.ok(
      typeof body.error === "string" &&
        body.error.includes("No running process found")
    );
  });

  test("returns 200 via jobStore restart-fallback with dead PID (lines 8673, 8689)", {
    timeout: 10_000,
  }, async () => {
    const loopId = "test-kill-restart-fallback";
    const deadPid = 99_999_999; // guaranteed non-existent

    const jobsMap = new Map<string, Partial<LocalJob>>([
      [
        loopId,
        {
          id: loopId,
          loopId,
          kind: "SYMPHONY_LOOP",
          command: "PLAN",
          pid: deadPid,
          status: "RUNNING",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } satisfies Partial<LocalJob>,
      ],
    ]);
    const fakeStore = makeFakeJobStore(jobsMap);
    const dispatcher = makeDispatcher(fakeStore);

    const { statusCode, body } = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/symphony/loop/kill",
      body: JSON.stringify({ loopId }),
    });

    assert.equal(statusCode, 200);
    assert.ok(body.success === true);
    // Should have upserted job with CANCELLED status (processWasAlive=false)
    assert.equal(fakeStore.upserted.length, 1);
    assert.equal(fakeStore.upserted[0].status, "CANCELLED");
  });

  test("returns 200 when registered loop has dead PID — falls through try/catch (line 8721)", {
    timeout: 10_000,
  }, async () => {
    const loopId = "test-kill-registered-dead";
    const deadPid = 99_999_998;
    registerRecoveredLoop(loopId, deadPid);
    try {
      const dispatcher = makeDispatcher();
      const { statusCode, body } = await dispatchOperation({
        dispatcher,
        method: "POST",
        pathname: "/api/gateway/symphony/loop/kill",
        body: JSON.stringify({ loopId }),
      });
      assert.equal(statusCode, 200);
      assert.ok(body.success === true);
      assert.ok(
        typeof body.message === "string" &&
          (body.message as string).includes("terminated")
      );
    } finally {
      // Kill handler deletes from runningLoops itself, but ensure cleanup
      unregisterLoop(loopId);
    }
  });
});
