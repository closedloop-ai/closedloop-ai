import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { glob } from "glob";
import {
  pathsEqualIgnoreCase,
  TCC_PROTECTED_HOME_SUBDIRS,
} from "../../shared/sandbox-policy.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { json } from "./response-utils.js";
import { assertRepoAllowed, resolveWorktreeDir } from "./symphony-utils.js";

const EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/*.pyc",
  "**/.DS_Store",
  "**/coverage/**",
  "**/.turbo/**",
  // FEA-3641: never descend into TCC-protected user folders. The sandbox base
  // can no longer be home (risky-dir guard), but this is defense-in-depth so a
  // search rooted near home never triggers a macOS permission prompt.
  "**/*.photoslibrary/**",
];

function excludePatternsForSearchRoot(searchDir: string): string[] {
  const home = path.resolve(os.homedir());
  const root = path.resolve(searchDir);
  const protectedRoots = TCC_PROTECTED_HOME_SUBDIRS.map((dir) =>
    path.join(home, dir)
  );
  // Compare case-insensitively: on the case-insensitive macOS filesystem this
  // targets, `${home}/music` and `${home}/Music` are the same folder, so a
  // case-sensitive `===` here would let a differently-cased search root descend
  // into a TCC-protected folder and trigger the permission prompt (FEA-3641).
  const rootIsHome = pathsEqualIgnoreCase(root, home);
  const protectedPatterns = protectedRoots
    .filter(
      (protectedRoot) => rootIsHome || pathsEqualIgnoreCase(root, protectedRoot)
    )
    .map((protectedRoot) =>
      rootIsHome ? `${path.basename(protectedRoot)}/**` : "**/*"
    );
  return [...EXCLUDE_PATTERNS, ...protectedPatterns];
}

export function registerFilesystemSearchRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register("GET", "/api/gateway/files/search", async (context) => {
    try {
      const repoPath = context.query.get("repo");
      const ticketId = context.query.get("ticket");
      const query = context.query.get("query") ?? "";
      const useBase = context.query.get("base") === "true";

      if (!repoPath) {
        json(context, 400, { error: "repo query parameter is required" });
        return;
      }

      if (!(useBase || ticketId)) {
        json(context, 400, { error: "ticket query parameter is required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const searchDir = useBase
        ? expandedRepoPath
        : resolveWorktreeDir(expandedRepoPath, ticketId!);

      try {
        assertPathAllowed(searchDir, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      if (!existsSync(searchDir)) {
        json(context, 200, {
          files: [],
          truncated: false,
          error: useBase ? "Repository not found" : "Worktree not found",
        });
        return;
      }

      const pattern = query ? `**/*${query}*` : "**/*";
      const files = await glob(pattern, {
        cwd: searchDir,
        nodir: true,
        ignore: excludePatternsForSearchRoot(searchDir),
        dot: true,
        nocase: true,
        maxDepth: 10,
      });

      const sortedFiles = [...files].sort((a, b) =>
        sortByRelevance(a, b, query)
      );
      const maxResults = 10;
      const truncated = sortedFiles.length > maxResults;
      const limitedFiles = sortedFiles.slice(0, maxResults);

      json(context, 200, { files: limitedFiles, truncated });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: `Failed to search files: ${message}` });
    }
  });
}

function sortByRelevance(a: string, b: string, query: string): number {
  const queryLower = query.toLowerCase();
  const aName = path.basename(a).toLowerCase();
  const bName = path.basename(b).toLowerCase();

  const aExact =
    aName === queryLower ||
    aName === `${queryLower}.ts` ||
    aName === `${queryLower}.tsx`;
  const bExact =
    bName === queryLower ||
    bName === `${queryLower}.ts` ||
    bName === `${queryLower}.tsx`;

  if (aExact && !bExact) {
    return -1;
  }
  if (bExact && !aExact) {
    return 1;
  }

  const aStarts = aName.startsWith(queryLower);
  const bStarts = bName.startsWith(queryLower);
  if (aStarts && !bStarts) {
    return -1;
  }
  if (bStarts && !aStarts) {
    return 1;
  }

  if (a.length !== b.length) {
    return a.length - b.length;
  }

  return a.localeCompare(b);
}
