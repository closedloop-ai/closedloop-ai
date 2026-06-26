import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { DirectoryNotAllowedError } from "../security.js";
import { json } from "./response-utils.js";
import { assertRepoAllowed, resolveWorktreeDir } from "./symphony-utils.js";

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

export function registerSymphonyPlanRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register(
    "GET",
    "/api/gateway/symphony/plan/:ticketId",
    async (context) => {
      try {
        const ticketId = context.params.ticketId;
        const repoPath = context.query.get("repo");

        if (!ticketId) {
          json(context, 400, { error: "ticketId is required" });
          return;
        }

        if (!repoPath) {
          json(context, 400, { error: "repo query parameter is required" });
          return;
        }

        let expandedRepoPath: string;
        try {
          expandedRepoPath = assertRepoAllowed(
            repoPath,
            getAllowedDirectories()
          );
        } catch (error) {
          if (error instanceof DirectoryNotAllowedError) {
            json(context, 403, { error: "directory not allowed" });
            return;
          }
          throw error;
        }

        const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
        const planPath = path.join(
          worktreeDir,
          ".closedloop-ai",
          "work",
          "plan.json"
        );

        if (!existsSync(worktreeDir)) {
          json(context, 404, { error: "Worktree not found", exists: false });
          return;
        }

        if (!existsSync(planPath)) {
          json(context, 404, {
            error: "Plan not found yet",
            exists: false,
            planExists: false,
          });
          return;
        }

        const planContent = (await readFile(planPath, "utf-8")).replaceAll(
          /,\s*([\]}])/g,
          "$1"
        );
        const plan = JSON.parse(planContent) as Record<string, unknown>;

        let markdownContent = (plan.content as string) || "";
        if (typeof markdownContent === "string" && markdownContent) {
          markdownContent = markdownContent
            .replaceAll(String.raw`\n`, "\n")
            .replaceAll(String.raw`\t`, "\t");
        }

        if (!markdownContent) {
          const planMdPath = path.join(
            worktreeDir,
            ".closedloop-ai",
            "work",
            "plan.md"
          );
          if (existsSync(planMdPath)) {
            const planMd = await readFile(planMdPath, "utf-8");
            const planTitle = String(plan.title ?? "");
            const firstLines = planMd.slice(0, 500);
            if (planTitle && firstLines.includes(planTitle)) {
              markdownContent = planMd;
            }
          }
        }

        if (!markdownContent && plan.tasks) {
          markdownContent = generateMarkdownFromPlan(plan);
        }

        json(context, 200, {
          exists: true,
          planExists: true,
          content: markdownContent,
          raw: plan,
          worktreeDir,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        json(context, 500, { error: `Failed to read plan: ${message}` });
      }
    }
  );
}

function generateMarkdownFromPlan(plan: Record<string, unknown>): string {
  const parts: string[] = [];

  parts.push(
    `# Implementation Plan: ${plan.title ?? "Untitled"}`,
    "",
    "## Summary",
    "",
    String(plan.description ?? ""),
    ""
  );

  const decisions = plan.architectureDecisions as PlanDecision[] | undefined;
  if (decisions?.length) {
    parts.push("## Architecture Decisions", "");
    for (const decision of decisions) {
      parts.push(`### ${decision.decision}`, "", decision.reasoning, "");
    }
  }

  const tasks = plan.tasks as PlanTask[] | undefined;
  if (tasks?.length) {
    parts.push("## Tasks", "");
    for (const task of tasks) {
      parts.push(`### ${task.id}: ${task.title}`, "", task.description, "");

      if (task.subtasks?.length) {
        parts.push("**Subtasks:**", "");
        for (const subtask of task.subtasks) {
          parts.push(subtask);
        }
        parts.push("");
      }

      if (task.acceptanceCriteria?.length) {
        parts.push("**Acceptance Criteria:**", "");
        for (const criterion of task.acceptanceCriteria) {
          parts.push(`- ${criterion}`);
        }
        parts.push("");
      }

      if (task.files?.length) {
        parts.push(`**Files:** ${task.files.join(", ")}`, "");
      }

      if (task.dependencies?.length) {
        parts.push(`**Dependencies:** ${task.dependencies.join(", ")}`, "");
      }
    }
  }

  const openQuestions = plan.openQuestions as string[] | undefined;
  if (openQuestions?.length) {
    parts.push("## Open Questions", "");
    for (const question of openQuestions) {
      parts.push(question);
    }
    parts.push("");
  }

  return parts.join("\n");
}
