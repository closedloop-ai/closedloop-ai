import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import { withMcpTools } from "@/lib/engineer/allowed-tools";
import { extractClaudeText } from "@/lib/engineer/claude-stream-utils";
import type { ReviewFinding } from "@/lib/engineer/codex-review-parser";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";
import { getShellPath } from "@/lib/engineer/shell-path";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // 2 minutes

const CODE_BLOCK_REGEX = /```json\s*\n([\s\S]*?)\n\s*```/;
const JSON_ARRAY_REGEX = /\[[\s\S]*\]/;

type ExtractRequest = {
  repoPath: string;
  sessionId: string;
  provider?: "codex" | "claude";
};

type StructuredFinding = {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number | null;
  title: string;
  description: string;
  suggestion: string | null;
  humanizedBody: string;
};

function getWorktreeDir(repoPath: string, ticketId: string): string {
  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  return join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
}

function mapSeverity(severity: string): ReviewFinding["severity"] {
  const lower = severity.toLowerCase();
  if (lower === "critical" || lower === "high") {
    return "critical";
  }
  if (lower === "medium") {
    return "warning";
  }
  return "info";
}

function mapPriority(severity: string): ReviewFinding["priority"] {
  const lower = severity.toLowerCase();
  if (lower === "critical") {
    return "P0";
  }
  if (lower === "high") {
    return "P1";
  }
  if (lower === "medium") {
    return "P2";
  }
  return "P3";
}

const EXTRACTION_PROMPT = `Now please provide your review findings as structured JSON. For each finding, look up the actual file to determine the correct full path and starting line number. Return ONLY a JSON array inside a \`\`\`json code block.

Every element MUST have ALL of these fields. None may be omitted. None except "line" and "suggestion" may be null.
- "severity": "critical" | "high" | "medium" | "low"
- "file": full repository-relative path (e.g., "src/components/Button.tsx") — use Glob to find the exact path if needed
- "line": starting line number of the relevant code — use Read/Grep to find it, or null if not applicable
- "title": one-line summary of the issue (REQUIRED, always a string)
- "description": detailed explanation of the issue — this is the analytical body the reviewer would put in a formal report (REQUIRED, always a non-empty string, even when humanizedBody is also provided)
- "suggestion": suggested fix, or null if none applies
- "humanizedBody": a SEPARATE natural-voice rewording of the same finding for a PR comment. 2-4 sentences in the voice of a senior engineer leaving a note for a colleague. Casual and collegial, with mild hedging where appropriate ("I think", "might want to", "not sure if this is intentional but", "feels like"). No headings, no severity tags like [P2], no bold, no lists, no title prefix. Do not include the file path or line number (GitHub shows those in the diff gutter). Fold the suggestion in naturally as a follow-up sentence. Do not invent facts beyond this finding. This is IN ADDITION to "description" — it does not replace it. REQUIRED, always a non-empty string.

Use the FULL repository-relative file paths, not abbreviated names. If a finding spans multiple files, create separate entries for each file. Include every finding from the review — do not drop any.`;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;

  let body: ExtractRequest;
  try {
    body = (await request.json()) as ExtractRequest;
  } catch {
    return Response.json(
      { error: "Invalid or empty JSON body" },
      { status: 400 }
    );
  }

  const { repoPath, sessionId } = body;
  const provider = body.provider ?? "claude";

  if (!(repoPath && sessionId)) {
    return Response.json(
      { error: "repoPath and sessionId are required" },
      { status: 400 }
    );
  }
  if (provider !== "codex" && provider !== "claude") {
    return Response.json(
      { error: "provider must be 'codex' or 'claude'" },
      { status: 400 }
    );
  }

  if (!isRepoAllowed(repoPath)) {
    return Response.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  const worktreeDir = getWorktreeDir(repoPath, ticketId);

  log.info(
    `[review-extract] Starting extraction for ${ticketId}, provider=${provider}, session ${sessionId}`
  );

  const workDir = join(worktreeDir, ".closedloop-ai", "work");

  try {
    const collected =
      provider === "codex"
        ? await runCodexExtraction(worktreeDir, sessionId)
        : await runClaudeExtraction(worktreeDir, sessionId);
    log.info(`[review-extract] Collected ${collected.length} chars of text`);

    // Persist the raw model response so we can diagnose model incompleteness
    // (missing fields, dropped findings, etc.) without re-running the review.
    try {
      await writeFile(
        join(workDir, `review-extract-raw-${provider}.txt`),
        collected
      );
      log.info(
        `[review-extract] Wrote raw response to review-extract-raw-${provider}.txt (${collected.length} chars)`
      );
    } catch (err) {
      log.warn(
        "[review-extract] Failed to persist raw response:",
        err instanceof Error ? err.message : String(err)
      );
    }

    const findings = parseStructuredFindings(collected);
    const humanizedCount = findings.filter((f) => f.humanizedBody).length;
    log.info(
      `[review-extract] Parsed ${findings.length} findings (with humanizedBody: ${humanizedCount})`
    );

    return Response.json({ findings });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("[review-extract] Extraction failed:", msg);
    return Response.json({ findings: [], error: msg });
  }
}

function runCodexExtraction(
  worktreeDir: string,
  sessionId: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      ["exec", "resume", sessionId, EXTRACTION_PROMPT, "--full-auto", "--json"],
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
            item?.type === "agent_message" &&
            item.text
          ) {
            collected += item.text;
          }
        } catch {
          collected += trimmed;
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      log.info(
        `[review-extract] codex stderr: ${data.toString().trim().slice(0, 300)}`
      );
    });

    child.on("close", (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as Record<string, unknown>;
          const item = event.item as
            | { type?: string; text?: string }
            | undefined;
          if (
            event.type === "item.completed" &&
            item?.type === "agent_message" &&
            item.text
          ) {
            collected += item.text;
          }
        } catch {
          collected += buffer.trim();
        }
      }
      log.info(`[review-extract] Codex exited with code ${code}`);
      if (code === 0) {
        resolve(collected);
      } else {
        reject(new Error(`Codex process exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

async function runClaudeExtraction(
  worktreeDir: string,
  sessionId: string
): Promise<string> {
  const shellPath = await getShellPath();
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
        withMcpTools("Read,Glob,Grep"),
      ],
      {
        cwd: worktreeDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: shellPath,
        },
      }
    );

    child.stdin?.write(EXTRACTION_PROMPT);
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
      log.info(
        `[review-extract] stderr: ${data.toString().trim().slice(0, 300)}`
      );
    });

    child.on("close", (code) => {
      // Flush remaining buffer
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
      log.info(`[review-extract] Claude exited with code ${code}`);
      if (code === 0) {
        resolve(collected);
      } else {
        reject(new Error(`Claude process exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

function parseStructuredFindings(text: string): ReviewFinding[] {
  // Extract JSON from ```json code block
  const codeBlockMatch = CODE_BLOCK_REGEX.exec(text);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1] : text.trim();

  let parsed: StructuredFinding[];
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to find any JSON array in the text
    const arrayMatch = JSON_ARRAY_REGEX.exec(text);
    if (!arrayMatch) {
      log.warn("[review-extract] No JSON array found in response");
      return [];
    }
    try {
      parsed = JSON.parse(arrayMatch[0]);
    } catch {
      log.warn("[review-extract] Failed to parse JSON array from response");
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.map((item) => ({
    severity: mapSeverity(item.severity ?? "low"),
    priority: mapPriority(item.severity ?? "low"),
    file: item.file ?? undefined,
    line: item.line ?? undefined,
    message: item.description
      ? `${item.title}\n${item.description}`
      : (item.title ?? ""),
    suggestion: item.suggestion ?? undefined,
    humanizedBody:
      typeof item.humanizedBody === "string" && item.humanizedBody.trim()
        ? item.humanizedBody.trim()
        : undefined,
  }));
}
