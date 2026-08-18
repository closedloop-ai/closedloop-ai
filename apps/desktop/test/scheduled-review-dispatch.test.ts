import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  type Harness,
  NIGHT_CREW_CONFIG_META_KEY,
  PassKind,
  type RunOpts,
  type RunResult,
  RunStatus,
  type ScheduledTask,
  scheduledTaskSchema,
} from "@repo/crewd";
import type { HarnessName } from "@repo/crewd/model";
import type { AuditWorkspace } from "@repo/crewd/passes/audit-workspace";
import { vi } from "vitest";
import { AuditService } from "../src/main/audit/audit-service.js";
import { createScheduledReviewDispatch } from "../src/main/scheduler/scheduled-review-dispatch.js";
import { runScheduledReviewThroughAuditService } from "../src/main/scheduler/scheduled-review-runner.js";
import type {
  ScheduledReviewRequest,
  ScheduledReviewResult,
} from "../src/shared/scheduled-review-contract.js";
import { stubHarnessBase } from "./helpers/crewd-harness-stub.js";

/**
 * FEA-4143 Slice 1: the real scheduled review dispatch. Proves the daemon
 * dispatch actually EXECUTES a configured review (not the M1 skip), that the run
 * is composed through the on-demand `AuditService` against a THROWAWAY workspace
 * copy (never the operator's live checkout), and that a non-review / unconfigured
 * task degrades to a recorded skip.
 */

const NO_CHARACTERS_RE = /no review characters/;
const UNKNOWN_CHARACTER_RE = /unknown review character/;
const THROWN_CHARACTER_RE = /docs-darwin: work-directory setup exploded/;
const PARTIAL_RUN_RE = /cascade attempt 2 timed out/;
const PARTIAL_FILE_ERROR_RE = /2 finding\(s\) failed to file/;
const PARTIAL_FILE_SUMMARY_RE = /2 failed to file/;

const ctx = {
  defaultCascade: [{ harness: "codex" as HarnessName }],
  log: () => {},
};

function makeReviewTask(
  meta: Record<string, unknown>,
  kind: (typeof PassKind)[keyof typeof PassKind] = PassKind.Review
): ScheduledTask {
  return scheduledTaskSchema.parse({
    id: "task-1",
    name: "nightly review",
    cron: "0 3 * * *",
    kind,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    meta,
  });
}

describe("createScheduledReviewDispatch", () => {
  test("executes a configured review task through the injected runner (not skipped)", async () => {
    const seen: ScheduledReviewRequest[] = [];
    const runReview = (request: ScheduledReviewRequest) => {
      seen.push(request);
      return Promise.resolve<ScheduledReviewResult>({
        ok: true,
        created: 2,
        skipped: 1,
        failed: 0,
        summary: "2 issue(s) filed, 1 deduped",
        error: null,
      });
    };
    const dispatch = createScheduledReviewDispatch(runReview);
    const task = makeReviewTask({
      [NIGHT_CREW_CONFIG_META_KEY]: {
        repoDir: "/repos/app",
        characters: ["docs-darwin"],
        projectSlug: "night-crew",
        assigneeId: "user-1",
      },
    });

    const outcome = await dispatch(task, ctx);

    // The run actually executed — not the M1 recorded-skip.
    assert.equal(outcome.status, RunStatus.Success);
    assert.equal(outcome.error, null);
    // The dispatch mapped the validated night-crew config into the run request.
    assert.deepEqual(seen, [
      {
        repoDir: "/repos/app",
        characters: ["docs-darwin"],
        projectSlug: "night-crew",
        assigneeId: "user-1",
      },
    ]);
  });

  test("maps a runner failure to a failed run", async () => {
    const dispatch = createScheduledReviewDispatch(() =>
      Promise.resolve<ScheduledReviewResult>({
        ok: false,
        created: 0,
        skipped: 0,
        failed: 0,
        summary: "run failed",
        error: "cascade exhausted",
      })
    );
    const outcome = await dispatch(
      makeReviewTask({
        [NIGHT_CREW_CONFIG_META_KEY]: {
          repoDir: "/repos/app",
          characters: ["docs-darwin"],
        },
      }),
      ctx
    );
    assert.equal(outcome.status, RunStatus.Failed);
    assert.equal(outcome.error, "cascade exhausted");
  });

  test("skips (does not run) a review task with no night-crew config", async () => {
    let called = 0;
    const dispatch = createScheduledReviewDispatch(() => {
      called++;
      return Promise.resolve<ScheduledReviewResult>({
        ok: true,
        created: 0,
        skipped: 0,
        failed: 0,
        summary: "",
        error: null,
      });
    });
    const outcome = await dispatch(makeReviewTask({}), ctx);
    assert.equal(outcome.status, RunStatus.Skipped);
    assert.equal(called, 0, "the runner must not be invoked without config");
  });

  test("skips a non-review task even with config present", async () => {
    let called = 0;
    const dispatch = createScheduledReviewDispatch(() => {
      called++;
      return Promise.resolve<ScheduledReviewResult>({
        ok: true,
        created: 0,
        skipped: 0,
        failed: 0,
        summary: "",
        error: null,
      });
    });
    const outcome = await dispatch(
      makeReviewTask(
        {
          [NIGHT_CREW_CONFIG_META_KEY]: {
            repoDir: "/repos/app",
            characters: ["docs-darwin"],
          },
        },
        PassKind.Custom
      ),
      ctx
    );
    assert.equal(outcome.status, RunStatus.Skipped);
    assert.equal(called, 0);
  });

  test("skips when no review runner is wired (pre-FEA-4143 degrade)", async () => {
    const dispatch = createScheduledReviewDispatch(undefined);
    const outcome = await dispatch(
      makeReviewTask({
        [NIGHT_CREW_CONFIG_META_KEY]: {
          repoDir: "/repos/app",
          characters: ["docs-darwin"],
        },
      }),
      ctx
    );
    assert.equal(outcome.status, RunStatus.Skipped);
  });
});

// ── The run is composed through AuditService against a throwaway workspace ──

function res(partial: Partial<RunResult>): RunResult {
  return {
    ok: false,
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 1,
    outputTail: "",
    ...partial,
  };
}

/** A harness that runs cleanly (writes no findings) and records the cwd it saw. */
function cleanHarness(name: HarnessName, onRun: (o: RunOpts) => void): Harness {
  return {
    ...stubHarnessBase(name),
    isAvailable: async () => true,
    run: (o: RunOpts) => {
      onRun(o);
      return Promise.resolve(res({ ok: true, exitCode: 0 }));
    },
  };
}

function unavailable(name: HarnessName): Harness {
  return {
    ...stubHarnessBase(name),
    isAvailable: async () => false,
    run: async () => res({}),
  };
}

function stubWorkspace(workspaceDir: string) {
  const calls: { repoDir: string }[] = [];
  const prepareWorkspace = (repoDir: string): Promise<AuditWorkspace> => {
    calls.push({ repoDir });
    return Promise.resolve({
      dir: workspaceDir,
      isGitWorktree: false,
      dispose: () => Promise.resolve(),
    });
  };
  return { prepareWorkspace, calls };
}

function promptsDirWith(character: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sched-review-prompts-"));
  writeFileSync(join(dir, `${character}.md`), "audit\n", "utf8");
  return dir;
}

describe("runScheduledReviewThroughAuditService", () => {
  test("runs the cascade against the throwaway workspace copy, never the live checkout", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sched-review-repo-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "sched-review-ws-"));
    const ws = stubWorkspace(workspaceDir);
    let seenCwd: string | undefined;
    const auditService = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [repoDir],
      resolveShellPath: async () => "",
      prepareWorkspace: ws.prepareWorkspace,
      registry: {
        codex: cleanHarness("codex", (o) => {
          seenCwd = o.cwd;
        }),
        opencode: unavailable("opencode"),
        claude: unavailable("claude"),
      },
    });

    const result = await runScheduledReviewThroughAuditService(auditService, {
      repoDir,
      characters: ["docs-darwin"],
    });

    // The harness ran against the disposable copy — never the operator repo.
    assert.equal(seenCwd, workspaceDir);
    assert.notEqual(seenCwd, repoDir);
    assert.deepEqual(ws.calls, [{ repoDir }]);
    // A clean run (no findings) files nothing and reports success.
    assert.equal(result.ok, true);
    assert.equal(result.created, 0);
    assert.equal(result.error, null);
  });

  test("parity: composes through AuditService.run + .file — the SAME methods the on-demand Audit IPC path drives (not runReviewPass)", async () => {
    // The on-demand path (audit-ipc.ts) calls `auditService.run(...)` then
    // `auditService.file(...)`. Asserting the scheduled runner drives those exact
    // instance methods on the SAME `AuditService` class is the parity contract:
    // the scheduled path cannot diverge onto a parallel `runReviewPass` that
    // would skip the throwaway-workspace copy + main-side credential boundary.
    const auditService = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [],
      resolveShellPath: async () => "",
    });
    const runSpy = vi.spyOn(auditService, "run").mockImplementation(() =>
      Promise.resolve({
        ok: true,
        character: "docs-darwin",
        harnessUsed: "codex" as HarnessName,
        attempts: [],
        findings: [{ title: "Stale doc", description: "d" }],
        reason: null,
        error: null,
      })
    );
    const fileSpy = vi.spyOn(auditService, "file").mockImplementation(() =>
      Promise.resolve({
        ok: true,
        filed: [],
        created: 1,
        skipped: 0,
        reason: null,
        error: null,
      })
    );

    const result = await runScheduledReviewThroughAuditService(auditService, {
      repoDir: "/repos/app",
      characters: ["docs-darwin"],
      projectSlug: "night-crew",
      assigneeId: "user-1",
    });

    assert.equal(runSpy.mock.calls.length, 1);
    assert.equal(fileSpy.mock.calls.length, 1);
    // The run drove the configured repo + character through AuditService.run.
    assert.deepEqual(runSpy.mock.calls[0][0], {
      character: "docs-darwin",
      repoDir: "/repos/app",
      cascade: undefined,
    });
    // The findings AuditService.run produced were filed via AuditService.file
    // with the configured project + assignee.
    assert.deepEqual(fileSpy.mock.calls[0][0], {
      character: "docs-darwin",
      findings: [{ title: "Stale doc", description: "d" }],
      projectSlug: "night-crew",
      assigneeId: "user-1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, 1);
  });

  test("rejects a character outside the shipped roster before spawning (parity with the on-demand IPC gate)", async () => {
    let ran = 0;
    const auditService = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [],
      resolveShellPath: async () => "",
    });
    vi.spyOn(auditService, "run").mockImplementation(() => {
      ran++;
      return Promise.resolve({
        ok: true,
        character: "x",
        harnessUsed: null,
        attempts: [],
        findings: [],
        reason: null,
        error: null,
      });
    });
    const result = await runScheduledReviewThroughAuditService(auditService, {
      repoDir: "/repos/app",
      // A path-traversal-shaped id that is not in the roster.
      characters: ["../../etc/shadow"],
    });
    assert.equal(ran, 0, "an out-of-roster character must never reach run()");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", UNKNOWN_CHARACTER_RE);
  });

  test("rejects an empty character list without touching the audit service", async () => {
    const auditService = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [],
      resolveShellPath: async () => "",
      prepareWorkspace: () => {
        throw new Error("must not prepare a workspace for an empty run");
      },
    });
    const result = await runScheduledReviewThroughAuditService(auditService, {
      repoDir: "/repos/app",
      characters: [],
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", NO_CHARACTERS_RE);
  });

  test("a run that returns ok:false WITH findings is a PARTIAL run — files what it got but does NOT persist as a clean success (Tzqf2)", async () => {
    // AuditRunResult.ok can be false while still carrying findings: the cascade
    // partially failed but produced findings the runner files. Filing them is
    // correct, but the character — and the aggregate run — must NOT read as a
    // clean success, or a half-broken review is persisted as `ok`.
    const auditService = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [],
      resolveShellPath: async () => "",
    });
    vi.spyOn(auditService, "run").mockImplementation(() =>
      Promise.resolve({
        ok: false,
        character: "docs-darwin",
        harnessUsed: "codex" as HarnessName,
        attempts: [],
        findings: [{ title: "Stale doc", description: "d" }],
        reason: null,
        error: "cascade attempt 2 timed out",
      })
    );
    const fileSpy = vi.spyOn(auditService, "file").mockImplementation(() =>
      Promise.resolve({
        ok: true,
        filed: [],
        created: 1,
        skipped: 0,
        failed: 0,
        reason: null,
        error: null,
      })
    );

    const result = await runScheduledReviewThroughAuditService(auditService, {
      repoDir: "/repos/app",
      characters: ["docs-darwin"],
      projectSlug: "night-crew",
    });

    // The partial-run findings were still filed…
    assert.equal(fileSpy.mock.calls.length, 1);
    assert.equal(result.created, 1);
    // …but the run is NOT a clean success: the partial-run reason surfaces.
    assert.equal(result.ok, false);
    assert.equal(result.failed, 0);
    assert.match(result.error ?? "", PARTIAL_RUN_RE);
  });

  test("a filing batch that returns ok:true with failed>0 is a PARTIAL file — surfaces the unfiled count and is NOT a clean success (Tzqf2)", async () => {
    // AuditService.file can return ok:true with a nonzero `failed` count on a
    // partial-batch failure (some findings kept in triage for retry). The run
    // must reflect those unfiled findings, not collapse to a clean success.
    const auditService = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [],
      resolveShellPath: async () => "",
    });
    vi.spyOn(auditService, "run").mockImplementation(() =>
      Promise.resolve({
        ok: true,
        character: "docs-darwin",
        harnessUsed: "codex" as HarnessName,
        attempts: [],
        findings: [
          { title: "A", description: "d" },
          { title: "B", description: "d" },
          { title: "C", description: "d" },
        ],
        reason: null,
        error: null,
      })
    );
    vi.spyOn(auditService, "file").mockImplementation(() =>
      Promise.resolve({
        ok: true,
        filed: [],
        created: 1,
        skipped: 0,
        failed: 2,
        reason: null,
        error: null,
      })
    );

    const result = await runScheduledReviewThroughAuditService(auditService, {
      repoDir: "/repos/app",
      characters: ["docs-darwin"],
      projectSlug: "night-crew",
    });

    assert.equal(result.created, 1);
    assert.equal(result.failed, 2);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", PARTIAL_FILE_ERROR_RE);
    // The partial-file count is reflected in the human summary too.
    assert.match(result.summary, PARTIAL_FILE_SUMMARY_RE);
  });

  test("a thrown character is recorded as that character's error and does NOT abort the rest of the list", async () => {
    // `AuditService.run`/`.file` are contracted never to throw for an operational
    // failure, but a work-directory fs/git setup error (or any unexpected throw)
    // must not escape the per-character boundary and abort the loop — the runner
    // catches it, records it against that character, and keeps going.
    const auditService = new AuditService({
      promptsDir: promptsDirWith("docs-darwin"),
      getAllowedDirectories: () => [],
      resolveShellPath: async () => "",
    });
    let ranSecond = false;
    vi.spyOn(auditService, "run").mockImplementation(
      (options: { character: string }) => {
        if (options.character === "docs-darwin") {
          // Simulate an unexpected throw from setup (e.g. work-dir fs/git failure).
          throw new Error("work-directory setup exploded");
        }
        ranSecond = true;
        return Promise.resolve({
          ok: true,
          character: options.character,
          harnessUsed: null,
          attempts: [],
          findings: [],
          reason: null,
          error: null,
        });
      }
    );

    const result = await runScheduledReviewThroughAuditService(auditService, {
      repoDir: "/repos/app",
      characters: ["docs-darwin", "code-cassandra"],
    });

    // The second character still ran despite the first throwing.
    assert.equal(ranSecond, true, "a thrown character must not abort the loop");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", THROWN_CHARACTER_RE);
  });
});
