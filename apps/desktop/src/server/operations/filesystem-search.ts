import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { glob } from "glob";
import {
  pathsEqualIgnoreCase,
  TCC_PROTECTED_HOME_SUBDIRS,
} from "../../shared/sandbox-policy.js";
import type {
  OperationDispatcher,
  OperationRequestContext,
} from "../operation-dispatcher.js";
import { isUnderDir } from "../path-containment.js";
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
        searchError(context, 400, "repo query parameter is required");
        return;
      }

      const requestError = findRequestError({ ticketId, query, useBase });
      if (requestError) {
        searchError(context, 400, requestError);
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          searchError(context, 403, "directory not allowed");
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
          searchError(context, 403, "directory not allowed");
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
      const matches = await glob(pattern, {
        cwd: searchDir,
        nodir: true,
        ignore: excludePatternsForSearchRoot(searchDir),
        dot: true,
        nocase: true,
        maxDepth: 10,
        // A `{a,b}` run in the query expands into 2^n patterns synchronously on
        // the Electron main thread. The search box offers substring match only.
        nobrace: true,
      });
      const files = containedResults(searchDir, matches);

      const sortedFiles = [...files].sort((a, b) =>
        sortByRelevance(a, b, query)
      );
      const maxResults = 10;
      const truncated = sortedFiles.length > maxResults;
      const limitedFiles = sortedFiles.slice(0, maxResults);

      json(context, 200, { files: limitedFiles, truncated });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      searchError(context, 500, `Failed to search files: ${message}`);
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

const PATH_SEGMENT_SEPARATOR = /[\\/]/;

function findRequestError(input: {
  ticketId: string | null;
  query: string;
  useBase: boolean;
}): string | null {
  if (!(input.useBase || input.ticketId)) {
    return "ticket query parameter is required";
  }
  if (isEscapingQuery(input.query)) {
    return "invalid query";
  }
  return null;
}

/**
 * A `<segment>/..` collapse is what walks a relative glob above `cwd`; `..` and
 * `/` are not glob metacharacters, so `escape()` cannot stop it. NUL is refused
 * because no filesystem name can contain it.
 */
function isEscapingQuery(query: string): boolean {
  if (query.includes("\0")) {
    return true;
  }
  return query
    .split(PATH_SEGMENT_SEPARATOR)
    .some((segment) => segment === "..");
}

/**
 * Postcondition on the glob output, independent of the pattern check above: a
 * brace alternation such as `{..,y}` expands to a `..` segment only inside
 * glob, so the query check never sees it. The route's `nobrace` stops that
 * expansion; this is the layer behind it. Escaped matches come back as
 * relative `../…` paths, which resolve outside the search root.
 */
export function containedResults(
  searchDir: string,
  matches: string[]
): string[] {
  const searchRoot = path.resolve(searchDir);
  return matches.filter((match) =>
    isUnderDir(path.resolve(searchRoot, match), searchRoot)
  );
}

/**
 * Every response from this route carries the full `{ files, truncated }` shape,
 * both non-optional. The web client (removed by ISS-12435, still live in older
 * bundles) pipes `response.json()` straight into that type without checking
 * `response.ok`, so a bare `{ error }` body would reach a consumer as a resolved
 * value whose `files` is `undefined`.
 * A `..` typed into a file-search box now reaches the 400, so that shape is
 * user-reachable rather than only a malformed-client case.
 */
function searchError(
  context: OperationRequestContext,
  status: number,
  error: string
): void {
  json(context, status, { files: [], truncated: false, error });
}
