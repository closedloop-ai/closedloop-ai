import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";
import { getShellPath } from "@/lib/engineer/shell-path";

const COMMIT_JSON_REGEX = /\{[\s\S]*"title"[\s\S]*"description"[\s\S]*\}/;

/**
 * Strip any mentions of Claude, Opus, or AI assistant from the commit message
 */
function sanitizeCommitMessage(text: string): string {
  return text
    .replaceAll(/claude\s*code/gi, "")
    .replaceAll(/\bopus\b/gi, "")
    .replaceAll(/\bclaude\b/gi, "")
    .replaceAll(/\bsonnet\b/gi, "")
    .replaceAll(/\bhaiku\b/gi, "")
    .replaceAll(/\banthropic\b/gi, "")
    .replaceAll(/AI\s*assistant/gi, "")
    .replaceAll(/[ \t]{2,}/g, " ") // Collapse multiple spaces/tabs but preserve newlines
    .trim();
}

/**
 * Get git diff for all changes (staged + unstaged)
 * Returns a compact diff suitable for commit message generation
 */
function getGitDiff(worktreeDir: string): string {
  try {
    // Get diff of all changes (staged and unstaged) with some context
    const diff = execSync(
      "git diff HEAD --stat && echo '---' && git diff HEAD",
      {
        cwd: worktreeDir,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024, // 1MB max
        timeout: 10_000,
      }
    );

    // Truncate if too large (keep first 15k chars to leave room for prompt)
    if (diff.length > 15_000) {
      return `${diff.slice(0, 15_000)}\n\n[diff truncated...]`;
    }
    return diff;
  } catch {
    return "";
  }
}

/**
 * Read .gitmessage template if it exists
 */
async function readGitMessageTemplate(
  worktreeDir: string
): Promise<string | null> {
  const templatePath = join(worktreeDir, ".gitmessage");

  if (existsSync(templatePath)) {
    try {
      const content = await readFile(templatePath, "utf-8");
      return content.trim();
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Run claude to generate a commit message from pre-computed diff (fast, no tools)
 */
async function generateWithClaude(
  worktreeDir: string,
  ticketId: string,
  template: string | null,
  diff: string
): Promise<{ title: string; description: string }> {
  const shellPath = await getShellPath();
  return new Promise((resolve, reject) => {
    let prompt = `Generate a git commit message for ticket ${ticketId}.

Here is the diff of all changes:

\`\`\`diff
${diff}
\`\`\`

Return ONLY a JSON object with this exact format (no markdown, no code blocks, no explanation):
{"title": "Short title under 72 chars", "description": "Bullet points of what changed"}

The title should be concise and start with a verb (Add, Fix, Update, Refactor, etc).
The description should cover ALL changed files shown in the diff.

IMPORTANT: Do NOT include any references to AI, Claude, Opus, Sonnet, Haiku, Anthropic, or AI assistants in the commit message.`;

    if (template) {
      prompt += `\n\nUse this commit message template as a guide for formatting:\n\`\`\`\n${template}\n\`\`\``;
    }

    console.log(
      "[Commit Message API] Spawning claude with prompt length:",
      prompt.length
    );
    console.log("[Commit Message API] Working directory:", worktreeDir);

    // No tools needed - diff is already in the prompt
    const args = ["--model", "haiku", "-p", prompt];
    console.log("[Commit Message API] Claude args:", args.slice(0, 4));

    const claude = spawn("claude", args, {
      cwd: worktreeDir,
      env: {
        ...process.env,
        PATH: shellPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    claude.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    claude.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    claude.on("close", (code) => {
      console.log("[Commit Message API] Claude exited with code:", code);
      console.log("[Commit Message API] stdout length:", stdout.length);
      console.log("[Commit Message API] stdout preview:", stdout.slice(0, 500));
      if (stderr) {
        console.log("[Commit Message API] stderr:", stderr);
      }

      if (code !== 0) {
        console.error("[Commit Message API] Claude error:", stderr);
        reject(new Error(`Claude exited with code ${code}`));
        return;
      }

      resolve(parseClaudeCommitOutput(stdout, ticketId));
    });

    claude.on("error", (err) => {
      reject(err);
    });

    // Timeout after 30 seconds (no tools = fast)
    setTimeout(() => {
      claude.kill();
      reject(new Error("Claude timed out"));
    }, 30_000);
  });
}

function parseClaudeCommitOutput(
  stdout: string,
  ticketId: string
): { title: string; description: string } {
  try {
    const jsonMatch = COMMIT_JSON_REGEX.exec(stdout);
    if (jsonMatch) {
      console.log(
        "[Commit Message API] Found JSON match:",
        jsonMatch[0].slice(0, 200)
      );
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        title: sanitizeCommitMessage(parsed.title || `Work on ${ticketId}`),
        description: sanitizeCommitMessage(parsed.description || ""),
      };
    }

    // Try parsing entire output as JSON
    console.log("[Commit Message API] No JSON match, trying direct parse");
    try {
      const parsed = JSON.parse(stdout.trim());
      if (parsed.title) {
        return {
          title: sanitizeCommitMessage(parsed.title),
          description: sanitizeCommitMessage(parsed.description || ""),
        };
      }
    } catch {
      // Not JSON
    }

    // Use the output as-is for description
    console.log("[Commit Message API] Using raw output as description");
    return {
      title: `Work on ${ticketId}`,
      description: sanitizeCommitMessage(stdout.trim().slice(0, 500)),
    };
  } catch (err) {
    console.error("[Commit Message API] Parse error:", err);
    console.error("[Commit Message API] Raw stdout:", stdout.slice(0, 500));
    return { title: `Work on ${ticketId}`, description: "" };
  }
}

/**
 * API route to generate a commit message for a ticket
 *
 * GET /api/symphony/commit-message/[ticketId]?repo=~/Source/claude_code
 *
 * Returns { title, description } for prefilling the commit dialog
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const { ticketId } = await params;
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get("repo");

    // Validate inputs
    if (!ticketId) {
      return NextResponse.json(
        { error: "ticketId is required" },
        { status: 400 }
      );
    }

    if (!repoPath) {
      return NextResponse.json(
        { error: "repo query parameter is required" },
        { status: 400 }
      );
    }

    // Security check
    if (!isRepoAllowed(repoPath)) {
      return NextResponse.json(
        { error: `Repository not allowed: ${repoPath}` },
        { status: 403 }
      );
    }

    // Sanitize ticket identifier
    const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");

    // Build worktree path
    const expandedRepoPath = expandHome(repoPath);
    const repoName = basename(expandedRepoPath);
    const worktreeParentDir = getWorktreeParentDir();
    const worktreeDir = join(
      worktreeParentDir,
      `${repoName}-${sanitizedTicket}`
    );

    // Check if worktree exists
    if (!existsSync(worktreeDir)) {
      return NextResponse.json({
        title: `Work on ${ticketId}`,
        description: "",
        source: "default",
      });
    }

    // Read .gitmessage template if it exists
    const template = await readGitMessageTemplate(worktreeDir);

    // Get git diff upfront (faster than letting Claude run git commands)
    const diff = getGitDiff(worktreeDir);
    if (!diff) {
      return NextResponse.json({
        title: `Work on ${ticketId}`,
        description: "",
        source: "default",
      });
    }

    // Generate commit message with Claude using pre-computed diff (fast, no tools)
    console.log(
      "[Commit Message API] Generating with Claude (diff length:",
      diff.length,
      ")"
    );
    try {
      const generated = await generateWithClaude(
        worktreeDir,
        ticketId,
        template,
        diff
      );
      return NextResponse.json({
        ...generated,
        source: "claude",
      });
    } catch (err) {
      console.error("[Commit Message API] Claude generation failed:", err);
      // Final fallback
      return NextResponse.json({
        title: `Work on ${ticketId}`,
        description: "",
        source: "default",
      });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to generate commit message: ${errorMessage}` },
      { status: 500 }
    );
  }
}
