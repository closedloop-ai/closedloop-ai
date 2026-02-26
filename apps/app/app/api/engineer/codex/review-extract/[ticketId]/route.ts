import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import { withMcpTools } from "@/lib/engineer/allowed-tools";
import { extractClaudeText } from "@/lib/engineer/claude-stream-utils";
import type { ReviewFinding } from "@/lib/engineer/codex-review-parser";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // 2 minutes

const CODE_BLOCK_REGEX = /```json\s*\n([\s\S]*?)\n\s*```/;
const JSON_ARRAY_REGEX = /\[[\s\S]*\]/;

type ExtractRequest = {
  repoPath: string;
  sessionId: string;
};

type StructuredFinding = {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number | null;
  title: string;
  description: string;
  suggestion: string | null;
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

const EXTRACTION_PROMPT = `Now please provide your review findings as structured JSON. For each finding, look up the actual file to determine the correct full path and starting line number. Return ONLY a JSON array inside a \`\`\`json code block. Each element must have:
- "severity": "critical" | "high" | "medium" | "low"
- "file": full repository-relative path (e.g., "src/components/Button.tsx") — use Glob to find the exact path if needed
- "line": starting line number of the relevant code — use Read/Grep to find it, or null if not applicable
- "title": one-line summary
- "description": detailed explanation
- "suggestion": suggested fix or null
Use the FULL repository-relative file paths, not abbreviated names. If a finding spans multiple files, create separate entries for each file.`;

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

  if (!(repoPath && sessionId)) {
    return Response.json(
      { error: "repoPath and sessionId are required" },
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

  console.log(
    `[review-extract] Starting extraction for ${ticketId}, session ${sessionId}`
  );

  try {
    const collected = await runClaudeExtraction(worktreeDir, sessionId);
    console.log(`[review-extract] Collected ${collected.length} chars of text`);

    const findings = parseStructuredFindings(collected);
    console.log(`[review-extract] Parsed ${findings.length} findings`);

    return Response.json({ findings });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[review-extract] Extraction failed:", msg);
    return Response.json({ findings: [], error: msg });
  }
}

function runClaudeExtraction(
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
        withMcpTools("Read,Glob,Grep"),
      ],
      {
        cwd: worktreeDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
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
      console.log(
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
      console.log(`[review-extract] Claude exited with code ${code}`);
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
      console.warn("[review-extract] No JSON array found in response");
      return [];
    }
    try {
      parsed = JSON.parse(arrayMatch[0]);
    } catch {
      console.warn("[review-extract] Failed to parse JSON array from response");
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
  }));
}
