import { execFileSync } from "node:child_process";
import path from "node:path";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { ApiKeyProvenance } from "../../main/api-key-store.js";
import type { DesktopPopSigner } from "../../main/desktop-pop.js";
import {
  buildManagedDesktopPopHeaders,
  type DesktopPopUnavailableReporter,
} from "../../main/desktop-pop-sign-utils.js";
import type { JobStore } from "../../main/job-store.js";
import type {
  OperationDispatcher,
  OperationRequestContext,
} from "../operation-dispatcher.js";
import { resolveRepoFullName } from "./git-helpers.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import { getActiveLoopPid, getResolvedGitPath } from "./symphony-loop.js";
import {
  isProcessRunning,
  readProcessPidSync,
  resolveWorktreeDir,
  resolveWorktreeParentDir,
  tryAssertRepoAllowed,
  writeLaunchMetadata,
} from "./symphony-utils.js";

// ---------------------------------------------------------------------------
// Shared prepare/confirm handler implementations
// ---------------------------------------------------------------------------

async function handlePrepare(
  context: OperationRequestContext,
  getAllowedDirectories: () => string[]
): Promise<void> {
  const ticketId = context.params.ticketId;
  const body = parseBody(context);
  if (!body) {
    json(context, 400, { error: "Invalid JSON body" });
    return;
  }

  const repoPath = asString(body.repoPath);
  const baseBranch = asString(body.baseBranch);

  if (!repoPath) {
    json(context, 400, { error: "repoPath is required" });
    return;
  }

  const repoResult = tryAssertRepoAllowed(repoPath, getAllowedDirectories());
  if ("error" in repoResult) {
    json(context, repoResult.status, { error: repoResult.error });
    return;
  }
  const expandedRepoPath = repoResult.path;

  const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);

  const fullName = resolveRepoFullName(expandedRepoPath);
  const branch =
    baseBranch ??
    resolveCurrentBranch(expandedRepoPath) ??
    resolveDefaultBranch(expandedRepoPath);

  json(context, 200, {
    repoPath: expandedRepoPath,
    worktreeDir,
    repo: { fullName: fullName ?? "", branch },
  });
}

async function handleConfirm(
  context: OperationRequestContext,
  ticketId: string,
  getAllowedDirectories: () => string[],
  jobStore: JobStore | undefined
): Promise<void> {
  const body = parseBody(context);
  if (!body) {
    json(context, 400, { error: "Invalid JSON body" });
    return;
  }

  const repoPath = asString(body.repoPath);
  const loopId = asString(body.loopId);
  const artifactId = asString(body.artifactId);
  const artifactSlug = asString(body.artifactSlug);
  const issueId = asString(body.issueId);
  const ticketTitle = asString(body.ticketTitle);
  const outcome = asString(body.outcome);

  if (!repoPath) {
    json(context, 400, { error: "repoPath is required" });
    return;
  }

  const repoResult = tryAssertRepoAllowed(repoPath, getAllowedDirectories());
  if ("error" in repoResult) {
    json(context, repoResult.status, { error: repoResult.error });
    return;
  }
  const expandedRepoPath = repoResult.path;

  const worktreeDir = artifactSlug
    ? resolveLoopWorktreeDir(expandedRepoPath, artifactSlug)
    : resolveWorktreeDir(expandedRepoPath, ticketId);

  if (loopId && artifactId) {
    writeLaunchMetadata(worktreeDir, {
      issueId: issueId ?? undefined,
      ticketTitle: ticketTitle ?? undefined,
      artifactId,
      loopId,
    });
  }

  if (loopId && jobStore) {
    const existing = jobStore.getByLoopId(loopId);

    if (outcome === "already-running") {
      if (!existing) {
        const now = new Date().toISOString();
        jobStore.upsert({
          id: loopId,
          kind: "SYMPHONY_LOOP",
          loopId,
          command: LoopCommand.Plan,
          ticketId: ticketId ?? undefined,
          artifactId: artifactId ?? undefined,
          artifactSlug: artifactSlug ?? undefined,
          issueId: issueId ?? undefined,
          repoPath: expandedRepoPath,
          localRepoPath: expandedRepoPath,
          worktreeDir,
          status: "RUNNING",
          startedAt: now,
          updatedAt: now,
        });
      }
    } else if (!existing) {
      const now = new Date().toISOString();
      jobStore.upsert({
        id: loopId,
        kind: "SYMPHONY_LOOP",
        loopId,
        command: LoopCommand.Plan,
        ticketId: ticketId ?? undefined,
        artifactId: artifactId ?? undefined,
        artifactSlug: artifactSlug ?? undefined,
        issueId: issueId ?? undefined,
        repoPath: expandedRepoPath,
        localRepoPath: expandedRepoPath,
        worktreeDir,
        status: "QUEUED",
        startedAt: now,
        updatedAt: now,
      });
    }
  }

  json(context, 200, { ok: true, worktreeDir });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Resolve the current branch name of a repo.
 */
function resolveCurrentBranch(repoPath: string): string | null {
  try {
    return execFileSync(
      getResolvedGitPath(),
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      }
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the default branch of a repo via symbolic-ref on remote HEAD.
 */
function resolveDefaultBranch(repoPath: string): string {
  try {
    const ref = execFileSync(
      getResolvedGitPath(),
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      }
    ).trim();
    // refs/remotes/origin/main -> main
    return ref.split("/").pop() ?? "main";
  } catch {
    return "main";
  }
}

/**
 * Compute the loop-style worktree directory. Mirrors `resolveLoopWorktreeDir`
 * + `slugifyLoopId` from symphony-loop.ts so the confirm handler produces
 * the same path the loop handler will actually use.
 */
function resolveLoopWorktreeDir(
  expandedRepoPath: string,
  artifactSlug: string
): string {
  const slugified = artifactSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 50);
  const repoName = path.basename(expandedRepoPath);
  return path.join(
    resolveWorktreeParentDir(expandedRepoPath),
    `${repoName}-loop-${slugified}`
  );
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSymphonyPlanLoopRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  getApiKey: () => string | null,
  getApiOrigin: () => string,
  jobStore?: JobStore,
  getApiKeyProvenance?: () => ApiKeyProvenance | null,
  signDesktopRequest?: DesktopPopSigner,
  onDesktopPopUnavailable?: DesktopPopUnavailableReporter
): void {
  // -----------------------------------------------------------------------
  // Operation A: POST /api/gateway/symphony/plan-loop/:ticketId/prepare
  //
  // Filesystem-only: validates repoPath, resolves worktree + git remote info.
  // No API call -- completes instantly. Used for both initial start and
  // select-artifact flows.
  // -----------------------------------------------------------------------
  dispatcher.register(
    "POST",
    "/api/gateway/symphony/plan-loop/:ticketId/prepare",
    (context) => handlePrepare(context, getAllowedDirectories)
  );

  // Also register the same prepare handler for the select-artifact path.
  // The prepare step is identical -- only the subsequent API call differs.
  dispatcher.register(
    "POST",
    "/api/gateway/symphony/plan-loop/:ticketId/select-artifact/prepare",
    (context) => handlePrepare(context, getAllowedDirectories)
  );

  // -----------------------------------------------------------------------
  // Operation B: POST /api/gateway/symphony/plan-loop/:ticketId/confirm
  //
  // Filesystem-only: writes launch-metadata.json and updates JobStore.
  // Called fire-and-forget by the browser after the API returns the loop.
  // No API call.
  // -----------------------------------------------------------------------
  dispatcher.register(
    "POST",
    "/api/gateway/symphony/plan-loop/:ticketId/confirm",
    (context) =>
      handleConfirm(
        context,
        context.params.ticketId,
        getAllowedDirectories,
        jobStore
      )
  );

  // Also register the same confirm handler for the select-artifact path.
  dispatcher.register(
    "POST",
    "/api/gateway/symphony/plan-loop/:ticketId/select-artifact/confirm",
    (context) =>
      handleConfirm(
        context,
        context.params.ticketId,
        getAllowedDirectories,
        jobStore
      )
  );

  // -----------------------------------------------------------------------
  // Operation C: POST /api/gateway/symphony/plan-loop/:ticketId/cancel
  //
  // Cancels DB loop via API + kills local process. The DELETE /loops/:loopId
  // call is a simple idempotent delete that doesn't dispatch a new relay
  // command, so no deadlock risk.
  // -----------------------------------------------------------------------
  dispatcher.register(
    "POST",
    "/api/gateway/symphony/plan-loop/:ticketId/cancel",
    async (context) => {
      const ticketId = context.params.ticketId;
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoPath = asString(body.repoPath);
      const loopId = asString(body.loopId);

      if (!repoPath) {
        json(context, 400, { error: "repoPath is required" });
        return;
      }
      if (!loopId) {
        json(context, 400, { error: "loopId is required" });
        return;
      }

      const repoResult = tryAssertRepoAllowed(
        repoPath,
        getAllowedDirectories()
      );
      if ("error" in repoResult) {
        json(context, repoResult.status, { error: repoResult.error });
        return;
      }
      const expandedRepoPath = repoResult.path;

      // Step 1: Cancel the loop record in the DB via API
      const apiKey = getApiKey();
      if (!apiKey) {
        json(context, 503, { error: "API key not configured" });
        return;
      }
      const apiOrigin = getApiOrigin();

      try {
        const path = `/loops/${loopId}`;
        const popHeaders = await buildManagedDesktopPopHeaders({
          apiKeyProvenance: getApiKeyProvenance?.() ?? "USER_CREATED",
          signDesktopRequest,
          request: {
            method: "DELETE",
            pathname: path,
          },
          surface: path,
          unavailableMessage:
            "PoP signing unavailable for loop cancellation; continuing bearer-only compatibility mode",
          onUnavailable: onDesktopPopUnavailable,
        });
        const cancelResponse = await fetch(`${apiOrigin}${path}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(popHeaders ?? {}),
          },
        });
        if (!cancelResponse.ok && cancelResponse.status !== 404) {
          const errText = await cancelResponse.text().catch(() => "");
          json(context, cancelResponse.status, {
            error: `DB cancel failed: ${errText}`,
          });
          return;
        }
      } catch (err) {
        json(context, 502, {
          error: `Failed to reach API: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      // Step 2: Kill the local process.
      // Check the JobStore first for the actual worktree path (loop-style),
      // falling back to the ticket-based path for legacy sessions.
      let worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      if (jobStore) {
        const job = jobStore.getByLoopId(loopId);
        if (job?.worktreeDir) {
          worktreeDir = job.worktreeDir;
        }
      }
      // Resolve PID: file first, then in-memory tracker, then JobStore fallback
      let pid = readProcessPidSync(worktreeDir);
      if (pid === null) {
        pid = getActiveLoopPid(loopId);
      }
      if (pid === null && jobStore) {
        const job = jobStore.getByLoopId(loopId);
        if (job?.pid != null && isProcessRunning(job.pid)) {
          pid = job.pid;
        }
      }

      if (pid === null) {
        // No PID found -- process state is uncertain
        if (jobStore) {
          const existingJob = jobStore.getByLoopId(loopId);
          if (existingJob) {
            jobStore.upsert({
              ...existingJob,
              status: "CANCEL_PENDING",
              updatedAt: new Date().toISOString(),
              warning: "process-unknown",
            });
          }
        }
        json(context, 200, {
          cancelled: true,
          warning: "process-unknown",
        });
        return;
      }

      // Attempt to kill the process
      try {
        process.kill(-pid, "SIGTERM");

        // Brief wait to allow graceful exit before liveness check
        await new Promise<void>((resolve) => setTimeout(resolve, 500));

        // kill(pid, 0) liveness verification
        let processGone = false;
        try {
          process.kill(pid, 0);
          // Still alive after SIGTERM
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Already gone
          }
          // Check again after SIGKILL
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          try {
            process.kill(pid, 0);
            processGone = false;
          } catch {
            processGone = true;
          }
        } catch {
          // SIGTERM killed it or it was already gone
          processGone = true;
        }

        if (processGone) {
          if (jobStore) {
            const existingJob = jobStore.getByLoopId(loopId);
            if (existingJob) {
              jobStore.upsert({
                ...existingJob,
                status: "CANCELLED",
                updatedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
              });
            }
          }
          json(context, 200, { cancelled: true });
        } else {
          if (jobStore) {
            const existingJob = jobStore.getByLoopId(loopId);
            if (existingJob) {
              jobStore.upsert({
                ...existingJob,
                status: "CANCEL_PENDING",
                updatedAt: new Date().toISOString(),
                warning: "process-still-running",
              });
            }
          }
          json(context, 200, {
            cancelled: true,
            warning: "process-still-running",
          });
        }
      } catch {
        // Could not send signal -- process not found
        const alive = isProcessRunning(pid);
        if (alive) {
          if (jobStore) {
            const existingJob = jobStore.getByLoopId(loopId);
            if (existingJob) {
              jobStore.upsert({
                ...existingJob,
                status: "CANCEL_PENDING",
                updatedAt: new Date().toISOString(),
                warning: "process-still-running",
              });
            }
          }
          json(context, 200, {
            cancelled: true,
            warning: "process-still-running",
          });
        } else {
          if (jobStore) {
            const existingJob = jobStore.getByLoopId(loopId);
            if (existingJob) {
              jobStore.upsert({
                ...existingJob,
                status: "CANCELLED",
                updatedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
              });
            }
          }
          json(context, 200, { cancelled: true });
        }
      }
    }
  );
}
