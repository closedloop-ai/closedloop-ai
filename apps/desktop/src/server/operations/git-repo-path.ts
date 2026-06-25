import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { resolveRepoFullName } from "./git-helpers.js";
import { loadReposConfig } from "./repos-config-utils.js";
import { json } from "./response-utils.js";
import { expandHome, SymphonyDirNotConfiguredError } from "./symphony-utils.js";

export function registerGitRepoPathRoutes(
  dispatcher: OperationDispatcher,
  getSymphonyDir: () => string
): void {
  const configDir = () => path.join(getSymphonyDir(), "config");

  dispatcher.register("GET", "/api/gateway/git/repo-path", async (context) => {
    try {
      const repoFullName = context.query.get("repoFullName");

      if (!repoFullName) {
        json(context, 400, {
          error: "repoFullName is required",
        });
        return;
      }

      const config = await loadReposConfig(configDir());

      for (const repo of config.repos) {
        const expandedRepoPath = expandHome(repo.path);
        const fullName = resolveRepoFullName(expandedRepoPath);
        if (fullName !== repoFullName) {
          continue;
        }
        json(context, 200, { path: expandedRepoPath });
        return;
      }

      json(context, 200, { path: null });
    } catch (error) {
      if (error instanceof SymphonyDirNotConfiguredError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, {
        error: `Failed to resolve repo path: ${message}`,
      });
    }
  });
}
