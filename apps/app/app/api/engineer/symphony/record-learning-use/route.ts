import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { NextRequest } from "next/server";
import type { LearningUsed } from "@/lib/engineer/chat-utils";
import {
  expandHome,
  getSymphonyScriptPath,
  getWorktreeParentDir,
} from "@/lib/engineer/repos";

/**
 * POST /api/symphony/record-learning-use
 *
 * Records learnings cited by the LLM in interactive chat to outcomes.log,
 * then triggers compute_success_rates.py to update org-patterns.toon.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { ticketId, repoPath, learnings } = body as {
    ticketId: string;
    repoPath: string;
    learnings: LearningUsed[];
  };

  if (!(ticketId && repoPath)) {
    return new Response(
      JSON.stringify({ error: "ticketId and repoPath are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (!Array.isArray(learnings) || learnings.length === 0) {
    return new Response(
      JSON.stringify({
        error: "learnings array is required and must not be empty",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);

  if (!existsSync(worktreeDir)) {
    return new Response(JSON.stringify({ error: "Work directory not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const claudeWorkDir = join(worktreeDir, ".claude", "work");
  const learningsDir = join(claudeWorkDir, ".learnings");
  mkdirSync(learningsDir, { recursive: true });

  const outcomesPath = join(learningsDir, "outcomes.log");
  const timestamp = new Date().toISOString();
  const runId = `chat-${sanitizedTicket}`;

  const lines = learnings.map((l) => {
    // Replace pipe chars in summary to avoid corrupting the delimiter
    const summary = l.summary.replaceAll("|", "/");
    return `${timestamp}|${runId}|0|interactive-chat|${summary}|applied|`;
  });

  appendFileSync(outcomesPath, `${lines.join("\n")}\n`, "utf-8");

  // Fire-and-forget: run compute_success_rates.py to update org-patterns.toon
  triggerSuccessRateComputation(claudeWorkDir);

  return Response.json({ status: "recorded", count: learnings.length });
}

/**
 * Spawn compute_success_rates.py as a detached process so it doesn't block
 * the API response. Resolves the script path from the Symphony plugin cache.
 */
function triggerSuccessRateComputation(workdir: string) {
  const runLoopPath = getSymphonyScriptPath();
  if (!runLoopPath) {
    return;
  }

  // run-loop.sh lives at <plugin>/scripts/run-loop.sh
  // compute_success_rates.py lives at <plugin>/tools/python/compute_success_rates.py
  const pluginRoot = dirname(dirname(runLoopPath));
  const ratesScript = join(
    pluginRoot,
    "tools",
    "python",
    "compute_success_rates.py"
  );

  if (!existsSync(ratesScript)) {
    return;
  }

  const child = spawn("python3", [ratesScript, "--workdir", workdir], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}
