import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isGitRepository } from "../../shared/git-utils.js";
import { isTccProtectedBasename } from "../../shared/sandbox-policy.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { json } from "./response-utils.js";
import { expandHome } from "./symphony-utils.js";

type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: true;
  isGitRepo: boolean;
};

export function registerFilesystemDirectoriesRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register("GET", "/api/gateway/directories", async (context) => {
    try {
      const pathParam = context.query.get("path") || "~";
      const expandedPath = expandHome(pathParam);

      try {
        assertPathAllowed(expandedPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      if (!existsSync(expandedPath)) {
        json(context, 200, { directories: [] });
        return;
      }

      const entries = await fs.readdir(expandedPath, { withFileTypes: true });
      const directories: DirectoryEntry[] = [];
      // FEA-3641: when browsing the home directory, skip TCC-protected user
      // folders (Music, Pictures, Documents, …) entirely. Listing them as
      // descendable entries would let the browser stat/probe inside them on a
      // subsequent request, triggering a macOS permission prompt. They are
      // never valid sandbox roots, so hiding them here (in addition to the
      // `.git` probe skip in isGitRepository) keeps them out of reach.
      const parentIsHome = path.resolve(expandedPath) === os.homedir();

      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }

        if (!entry.isDirectory()) {
          continue;
        }

        if (parentIsHome && isTccProtectedBasename(entry.name)) {
          continue;
        }

        const fullPath = path.join(expandedPath, entry.name);
        const isGitRepo = isGitRepository(fullPath);
        const displayPath = pathParam.startsWith("~")
          ? path.join(pathParam, entry.name)
          : fullPath;

        directories.push({
          name: entry.name,
          path: displayPath,
          isDirectory: true,
          isGitRepo,
        });
      }

      directories.sort((a, b) => {
        if (a.isGitRepo && !b.isGitRepo) {
          return -1;
        }
        if (!a.isGitRepo && b.isGitRepo) {
          return 1;
        }
        return a.name.localeCompare(b.name);
      });

      json(context, 200, { directories });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: `Failed to list directories: ${message}` });
    }
  });
}
