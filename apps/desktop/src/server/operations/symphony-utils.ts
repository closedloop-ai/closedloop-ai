import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expandHomePath } from "../../shared/path-utils.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";

export class SymphonyDirNotConfiguredError extends Error {
  constructor() {
    super("Symphony directory not configured — complete onboarding");
    this.name = "SymphonyDirNotConfiguredError";
  }
}

export function computeSymphonyDir(sandboxBaseDirectory: string): string {
  return path.join(sandboxBaseDirectory, ".closedloop-ai");
}

export function expandHome(inputPath: string): string {
  return expandHomePath(inputPath);
}

export function resolveWorktreeParentDir(expandedRepoPath: string): string {
  const configuredParent = process.env.SYMPHONY_WORKTREE_PARENT_DIR;
  if (configuredParent?.trim()) {
    return expandHome(configuredParent);
  }

  return path.dirname(expandedRepoPath);
}

export function sanitizeTicketId(ticketId: string): string {
  return ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
}

export function resolveWorktreeDir(
  expandedRepoPath: string,
  ticketId: string
): string {
  const sanitizedTicket = sanitizeTicketId(ticketId);
  const repoName = path.basename(expandedRepoPath);
  return path.join(
    resolveWorktreeParentDir(expandedRepoPath),
    `${repoName}-${sanitizedTicket}`
  );
}

export function assertRepoAllowed(
  repoPath: string,
  allowedDirectories: string[]
): string {
  const expandedRepoPath = expandHome(repoPath);
  try {
    assertPathAllowed(expandedRepoPath, allowedDirectories);
    return expandedRepoPath;
  } catch (error) {
    if (error instanceof DirectoryNotAllowedError) {
      throw error;
    }
    throw error;
  }
}

export type LaunchMetadata = {
  issueId?: string;
  ticketTitle?: string;
  artifactId?: string;
  baseBranch?: string;
  parentTicketId?: string;
};

/**
 * Read launch metadata from {worktreeDir}/.closedloop-ai/work/launch-metadata.json.
 */
export function readLaunchMetadata(worktreeDir: string): LaunchMetadata | null {
  const metaPath = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "launch-metadata.json"
  );

  try {
    const content = readFileSync(metaPath, "utf-8");
    return parseLaunchMetadataContent(content);
  } catch {
    return null;
  }
}

/**
 * Async launch metadata reader for UI-sensitive paths. It mirrors
 * `readLaunchMetadata` while avoiding a blocking file read on Electron's main
 * thread.
 */
export async function readLaunchMetadataAsync(
  worktreeDir: string
): Promise<LaunchMetadata | null> {
  const metaPath = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "launch-metadata.json"
  );

  try {
    const content = await readFile(metaPath, "utf-8");
    return parseLaunchMetadataContent(content);
  } catch {
    return null;
  }
}

function parseLaunchMetadataContent(content: string): LaunchMetadata {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    issueId: typeof parsed.issueId === "string" ? parsed.issueId : undefined,
    ticketTitle:
      typeof parsed.ticketTitle === "string" ? parsed.ticketTitle : undefined,
    artifactId:
      typeof parsed.artifactId === "string" ? parsed.artifactId : undefined,
    baseBranch:
      typeof parsed.baseBranch === "string" ? parsed.baseBranch : undefined,
    parentTicketId:
      typeof parsed.parentTicketId === "string"
        ? parsed.parentTicketId
        : undefined,
  };
}
