import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import { extractClaudeText } from "@/lib/engineer/claude-stream-utils";
import { extractVerdictTag } from "@/lib/engineer/codex-review-parser";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";
import { getShellPathSync } from "@/lib/engineer/shell-path";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type VerdictRequest = {
  repoPath: string;
  sessionId: string;
  provider: "codex" | "claude";
};

const VERDICT_PROMPT = `Now perform a Premise Review of the changes you just reviewed. Question whether the changes were necessary at all:

- Non-existent bug "fix": The author claims to fix a bug, but the original code was correct
- Redundant workaround: The problem is already handled by the framework or upstream code
- Phantom dead-code removal: Code removed as "unused" but still referenced elsewhere
- Duplicate abstraction: A new helper was added but an equivalent already exists
- Unnecessary optimization: Caching/batching for a path that is not a bottleneck

Use Read, Grep, and Glob to investigate the existing codebase for evidence.

After your analysis, output exactly one line as the LAST line of your response:
<pr_verdict>{"verdict":"X","reason":"..."}</pr_verdict>

Where verdict is:
- "decline" if you found blocking premise issues (changes are unnecessary or harmful) OR your review found critical/blocking issues
- "needs_attention" if there are high-priority issues but no blocking ones
- "approve" if no blocking or high-priority issues were found

Keep reason under 120 characters. The reason should reference the most important issue.`;

function getWorktreeDir(repoPath: string, ticketId: string): string {
  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  return join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;

  let body: VerdictRequest;
  try {
    body = (await request.json()) as VerdictRequest;
  } catch {
    return Response.json(
      { error: "Invalid or empty JSON body" },
      { status: 400 }
    );
  }

  const { repoPath, sessionId, provider } = body;

  if (!(repoPath && sessionId && provider)) {
    return Response.json(
      { error: "repoPath, sessionId, and provider are required" },
      { status: 400 }
    );
  }

  if (!isRepoAllowed(repoPath)) {
    return Response.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  try {
    const worktreeDir = getWorktreeDir(repoPath, ticketId);

    console.log(
      `[review-verdict] Starting verdict extraction for ${ticketId}, provider=${provider}, session=${sessionId}`
    );
    const collected =
      provider === "codex"
        ? await runCodexVerdict(worktreeDir, sessionId)
        : await runClaudeVerdict(worktreeDir, sessionId);

    console.log(
      `[review-verdict] Collected ${collected.length} chars of output`
    );

    const verdict = extractVerdictTag(collected);
    if (verdict) {
      console.log(
        `[review-verdict] Extracted verdict: ${verdict.verdict} — ${verdict.reason}`
      );
    } else {
      console.log("[review-verdict] No verdict tag found in output");
    }

    return Response.json({ verdict });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[review-verdict] Extraction failed:", msg);
    return Response.json({ verdict: null, error: msg });
  }
}

function runCodexVerdict(
  worktreeDir: string,
  sessionId: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      ["exec", "resume", sessionId, VERDICT_PROMPT, "--full-auto", "--json"],
      {
        cwd: worktreeDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      }
    );

    let buffer = "";
    let collected = "";

    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          const item = event.item as
            | { type?: string; text?: string }
            | undefined;
          if (
            event.type === "item.completed" &&
            item?.text &&
            item.type === "agent_message"
          ) {
            collected += item.text;
          }
        } catch {
          // Not JSON — accumulate raw text as fallback
          collected += trimmed;
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      console.log(
        `[review-verdict] codex stderr: ${data.toString().trim().slice(0, 300)}`
      );
    });

    child.on("close", (code) => {
      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as Record<string, unknown>;
          const item = event.item as
            | { type?: string; text?: string }
            | undefined;
          if (
            event.type === "item.completed" &&
            item?.text &&
            item.type === "agent_message"
          ) {
            collected += item.text;
          }
        } catch {
          collected += buffer.trim();
        }
      }
      console.log(`[review-verdict] Codex exited with code ${code}`);
      if (code === 0) {
        resolve(collected);
      } else {
        reject(new Error(`Codex process exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

function runClaudeVerdict(
  worktreeDir: string,
  sessionId: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--resume",
        sessionId,
        "--output-format",
        "stream-json",
        "--model",
        "sonnet",
        "--allowedTools",
        "Read,Glob,Grep",
      ],
      {
        cwd: worktreeDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: getShellPathSync(),
        },
      }
    );

    child.stdin?.write(VERDICT_PROMPT);
    child.stdin?.end();

    let buffer = "";
    let collected = "";

    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const event = JSON.parse(trimmed);
          const text = extractClaudeText(event);
          if (text) {
            collected += text;
          }
        } catch {
          // Not JSON — ignore
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      console.log(
        `[review-verdict] claude stderr: ${data.toString().trim().slice(0, 300)}`
      );
    });

    child.on("close", (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          const text = extractClaudeText(event);
          if (text) {
            collected += text;
          }
        } catch {
          // ignore
        }
      }
      console.log(`[review-verdict] Claude exited with code ${code}`);
      if (code === 0) {
        resolve(collected);
      } else {
        reject(new Error(`Claude process exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}
