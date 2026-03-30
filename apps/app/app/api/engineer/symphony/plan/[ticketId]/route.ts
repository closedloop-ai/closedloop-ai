import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";

type PlanTask = {
  id: string;
  title: string;
  description: string;
  subtasks?: string[];
  acceptanceCriteria?: string[];
  files?: string[];
  dependencies?: string[];
  estimatedComplexity?: string;
};

type PlanDecision = {
  decision: string;
  reasoning: string;
};

/** Generate markdown from structured plan.json when the content field is missing */
function generateMarkdownFromPlan(plan: Record<string, unknown>): string {
  const parts: string[] = [];

  parts.push(
    `# Plan: ${plan.title ?? "Untitled"}`,
    "",
    "## Summary",
    "",
    String(plan.description ?? ""),
    ""
  );

  const decisions = plan.architectureDecisions as PlanDecision[] | undefined;
  if (decisions?.length) {
    parts.push("## Architecture Decisions", "");
    for (const d of decisions) {
      parts.push(`### ${d.decision}`, "", d.reasoning, "");
    }
  }

  const tasks = plan.tasks as PlanTask[] | undefined;
  if (tasks?.length) {
    parts.push("## Tasks", "");
    for (const t of tasks) {
      parts.push(`### ${t.id}: ${t.title}`, "", t.description, "");
      if (t.subtasks?.length) {
        parts.push("**Subtasks:**", "");
        for (const s of t.subtasks) {
          parts.push(s);
        }
        parts.push("");
      }
      if (t.acceptanceCriteria?.length) {
        parts.push("**Acceptance Criteria:**", "");
        for (const ac of t.acceptanceCriteria) {
          parts.push(`- ${ac}`);
        }
        parts.push("");
      }
      if (t.files?.length) {
        parts.push(`**Files:** ${t.files.join(", ")}`, "");
      }
      if (t.dependencies?.length) {
        parts.push(`**Dependencies:** ${t.dependencies.join(", ")}`, "");
      }
    }
  }

  const questions = plan.openQuestions as string[] | undefined;
  if (questions?.length) {
    parts.push("## Open Questions", "");
    for (const q of questions) {
      parts.push(q);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * API route to read plan.json from a Symphony worktree
 *
 * GET /api/symphony/plan/[ticketId]?repo=~/Source/claude_code
 *
 * Returns the plan content with newlines properly formatted
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
    const workDir = join(worktreeDir, ".closedloop-ai", "work");
    const planPath = join(workDir, "plan.json");

    // Check if worktree exists
    if (!existsSync(worktreeDir)) {
      return NextResponse.json(
        { error: "Worktree not found", exists: false },
        { status: 404 }
      );
    }

    // Check if plan.json exists
    if (!existsSync(planPath)) {
      return NextResponse.json(
        { error: "Plan not found yet", exists: false, planExists: false },
        { status: 404 }
      );
    }

    // Read and parse plan.json
    // Strip trailing commas before ] or } — Claude edits can introduce them
    const planContent = (await readFile(planPath, "utf-8")).replaceAll(
      /,\s*([\]}])/g,
      "$1"
    );
    const plan = JSON.parse(planContent);

    // Extract markdown content with fallback chain:
    // 1. plan.json "content" field (primary)
    // 2. plan.md file (if it matches the current plan title)
    // 3. Generate from structured plan.json data
    let markdownContent = plan.content || "";

    // Fix escaped newlines (\\n -> \n)
    if (typeof markdownContent === "string" && markdownContent) {
      markdownContent = markdownContent
        .replaceAll(String.raw`\n`, "\n")
        .replaceAll(String.raw`\t`, "\t");
    }

    // Fallback: try plan.md if content field is empty
    if (!markdownContent) {
      const planMdPath = join(workDir, "plan.md");
      if (existsSync(planMdPath)) {
        const planMd = await readFile(planMdPath, "utf-8");
        // Only use plan.md if it looks related to the same plan (title appears in first few lines)
        const planTitle = String(plan.title ?? "");
        const firstLines = planMd.slice(0, 500);
        if (planTitle && firstLines.includes(planTitle)) {
          markdownContent = planMd;
        }
      }
    }

    // Last resort: generate markdown from structured plan.json fields
    if (!markdownContent && plan.tasks) {
      markdownContent = generateMarkdownFromPlan(plan);
    }

    return NextResponse.json({
      exists: true,
      planExists: true,
      content: markdownContent,
      raw: plan,
      worktreeDir,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read plan: ${errorMessage}` },
      { status: 500 }
    );
  }
}
