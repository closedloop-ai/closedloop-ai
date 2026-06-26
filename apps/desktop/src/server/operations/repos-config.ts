import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { parseBody } from "./parse-body.js";
import {
  addRepo,
  loadReposConfig,
  removeRepo,
  updateSettings,
} from "./repos-config-utils.js";
import { json } from "./response-utils.js";
import { SymphonyDirNotConfiguredError } from "./symphony-utils.js";

export function registerReposConfigRoutes(
  dispatcher: OperationDispatcher,
  getSymphonyDir: () => string
): void {
  const configDir = () => path.join(getSymphonyDir(), "config");

  dispatcher.register("GET", "/api/gateway/repos", async (context) => {
    try {
      const config = await loadReposConfig(configDir());
      json(context, 200, { repos: config.repos, settings: config.settings });
    } catch (error) {
      if (error instanceof SymphonyDirNotConfiguredError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: `Failed to list repos: ${message}` });
    }
  });

  dispatcher.register("POST", "/api/gateway/repos", async (context) => {
    try {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoPath = typeof body.path === "string" ? body.path : null;
      const description =
        typeof body.description === "string" ? body.description : undefined;
      if (!repoPath) {
        json(context, 400, { error: "path is required and must be a string" });
        return;
      }

      const result = await addRepo(repoPath, description, configDir());
      if (!result.success) {
        json(context, 400, { error: result.error });
        return;
      }

      json(context, 200, { success: true, repo: result.repo });
    } catch (error) {
      if (error instanceof SymphonyDirNotConfiguredError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: `Failed to add repo: ${message}` });
    }
  });

  dispatcher.register("DELETE", "/api/gateway/repos", async (context) => {
    try {
      const repoPath = context.query.get("path");
      if (!repoPath) {
        json(context, 400, { error: "path query parameter is required" });
        return;
      }

      const result = await removeRepo(repoPath, configDir());
      if (!result.success) {
        json(context, 400, { error: result.error });
        return;
      }

      json(context, 200, { success: true });
    } catch (error) {
      if (error instanceof SymphonyDirNotConfiguredError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: `Failed to remove repo: ${message}` });
    }
  });

  dispatcher.register("PATCH", "/api/gateway/repos", async (context) => {
    try {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const updates: Record<string, string | boolean> = {};
      if (typeof body.worktreeParentDir === "string") {
        updates.worktreeParentDir = body.worktreeParentDir;
      }
      if (typeof body.worktreeParentDirConfirmed === "boolean") {
        updates.worktreeParentDirConfirmed = body.worktreeParentDirConfirmed;
      }

      if (Object.keys(updates).length === 0) {
        json(context, 400, { error: "No settings to update" });
        return;
      }

      const result = await updateSettings(updates, configDir());
      if (!result.success) {
        json(context, 400, { error: result.error });
        return;
      }

      json(context, 200, { success: true });
    } catch (error) {
      if (error instanceof SymphonyDirNotConfiguredError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: `Failed to update settings: ${message}` });
    }
  });
}
