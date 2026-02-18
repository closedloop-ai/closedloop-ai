import { spawn } from "node:child_process";
import type { NextRequest } from "next/server";
import { extractClaudeText } from "@/lib/engineer/claude-stream-utils";
import { isRepoAllowed } from "@/lib/engineer/repos";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEDUP_CODE_BLOCK_REGEX = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/;
const DEDUP_JSON_ARRAY_REGEX = /\[[\s\S]*\]/;

type FindingSummary = {
  file?: string;
  line?: number;
  message: string;
  severity: string;
};

type DedupRequest = {
  repoPath: string;
  providerA: string;
  providerB: string;
  findingsA: FindingSummary[];
  findingsB: FindingSummary[];
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  await params; // consume route param

  let body: DedupRequest;
  try {
    body = (await request.json()) as DedupRequest;
  } catch {
    return Response.json(
      { error: "Invalid or empty JSON body" },
      { status: 400 }
    );
  }

  const { repoPath, providerA, providerB, findingsA, findingsB } = body;

  if (!(repoPath && providerA && providerB)) {
    return Response.json(
      { error: "repoPath, providerA, and providerB are required" },
      { status: 400 }
    );
  }

  if (!isRepoAllowed(repoPath)) {
    return Response.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  if (!(findingsA?.length && findingsB?.length)) {
    return Response.json({ duplicates: [] });
  }

  const prompt = buildDedupPrompt(providerA, providerB, findingsA, findingsB);

  try {
    const raw = await runHaikuClassification(prompt);
    const duplicates = parseDedupResponse(raw);
    console.log(
      `[review-dedup] Found ${duplicates.length} duplicate pairs between ${providerA} and ${providerB}`
    );
    return Response.json({ duplicates });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[review-dedup] Classification failed:", msg);
    return Response.json({ duplicates: [], error: msg });
  }
}

function formatFinding(index: number, f: FindingSummary): string {
  const firstLine = f.message.split("\n")[0].slice(0, 120);
  const location = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "N/A";
  return `  ${index}. [${f.severity}] ${location} — ${firstLine}`;
}

function buildDedupPrompt(
  providerA: string,
  providerB: string,
  findingsA: FindingSummary[],
  findingsB: FindingSummary[]
): string {
  const listA = findingsA.map((f, i) => formatFinding(i, f)).join("\n");
  const listB = findingsB.map((f, i) => formatFinding(i, f)).join("\n");

  return `Given two sets of code review findings from different reviewers for the same PR, identify which findings are duplicates (same issue, same or overlapping file/location, same core concern — even if worded differently).

Return ONLY a JSON array of pairs: [[indexA, indexB], ...] where indexA is the 0-based index from Set A and indexB is the 0-based index from Set B. If a finding has no duplicate in the other set, omit it. Return [] if no duplicates.

Set A (${providerA}):
${listA}

Set B (${providerB}):
${listB}`;
}

function runHaikuClassification(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--model",
        "claude-haiku-4-5-20251001",
        "--output-format",
        "stream-json",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
        },
      }
    );

    child.stdin?.write(prompt);
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
        `[review-dedup] stderr: ${data.toString().trim().slice(0, 300)}`
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
      if (code === 0) {
        resolve(collected);
      } else {
        reject(new Error(`Claude process exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

function parseDedupResponse(raw: string): [number, number][] {
  // Extract JSON array from response — may be in a code block or bare
  const codeBlockMatch = DEDUP_CODE_BLOCK_REGEX.exec(raw);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1] : raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to find any JSON array in the text
    const arrayMatch = DEDUP_JSON_ARRAY_REGEX.exec(raw);
    if (!arrayMatch) {
      return [];
    }
    try {
      parsed = JSON.parse(arrayMatch[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  // Validate each pair is [number, number]
  return parsed.filter(
    (pair): pair is [number, number] =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === "number" &&
      typeof pair[1] === "number"
  );
}
