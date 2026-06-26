import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { DirectoryNotAllowedError } from "../security.js";
import { json } from "./response-utils.js";
import { assertRepoAllowed, resolveWorktreeDir } from "./symphony-utils.js";

export function registerSymphonyJudgesRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register(
    "GET",
    "/api/gateway/symphony/judges/:ticketId",
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
        const judgesPath = path.join(
          worktreeDir,
          ".closedloop-ai",
          "work",
          "judges.json"
        );

        if (!existsSync(worktreeDir)) {
          json(context, 404, {
            error: "Worktree not found",
            exists: false,
            isMock: false,
          });
          return;
        }

        if (existsSync(judgesPath)) {
          try {
            const judgesContent = await fs.readFile(judgesPath, "utf-8");
            let data: unknown;
            try {
              data = JSON.parse(judgesContent);
            } catch {
              const fixedContent = judgesContent.replaceAll(
                /,\s*([\]}])/g,
                "$1"
              );
              data = JSON.parse(fixedContent);
            }

            json(context, 200, {
              exists: true,
              isMock: false,
              data,
              worktreeDir,
            });
            return;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            json(context, 500, {
              error: `Judges feedback is corrupted: ${message}`,
              exists: true,
              isMock: false,
            });
            return;
          }
        }

        json(context, 200, {
          exists: false,
          isMock: false,
          message: "Awaiting LLM judges feedback",
          worktreeDir,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        json(context, 500, { error: `Failed to read judges data: ${message}` });
      }
    }
  );
}
