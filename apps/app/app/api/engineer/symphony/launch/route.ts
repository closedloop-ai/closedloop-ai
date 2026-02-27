import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import {
  expandHome,
  getSymphonyScriptPath,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";
import { addWorktree, fetchOrigin } from "@/lib/engineer/worktree";

/**
 * Ticket details passed from frontend
 */
type TicketDetails = {
  identifier: string;
  title: string;
  description?: string;
  url: string;
  additionalContext?: string;
  contextRepoPaths?: string[];
  mentionedFiles?: { repoPath: string; filePath: string }[];
};

/**
 * Extract a ticket ID from a branch name.
 * Matches patterns like:
 * - feature/AI-247 -> "AI-247"
 * - AI-247-some-feature -> "AI-247"
 * - bugfix/AI-100-fix -> "AI-100"
 */
function extractTicketIdFromBranch(branchName: string): string | null {
  const match = /([A-Z]+-\d+)/.exec(branchName);
  return match ? match[1] : null;
}

/**
 * Extract image URLs from markdown content
 * Matches: ![alt](url) patterns
 */
function extractImageUrls(markdown: string): { alt: string; url: string }[] {
  const images: { alt: string; url: string }[] = [];

  for (const match of markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    const url = match[2];
    // Only include URLs that look like images
    if (
      url.includes("uploads.linear.app") ||
      /\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.exec(url)
    ) {
      images.push({ alt: match[1], url });
    }
  }

  return images;
}

/**
 * Download an image from a URL and save it locally
 */
async function downloadImage(url: string, destPath: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(
        `Failed to download image: ${response.status} ${response.statusText}`
      );
      return false;
    }

    const buffer = await response.arrayBuffer();
    writeFileSync(destPath, Buffer.from(buffer));
    return true;
  } catch (error) {
    console.error(`Error downloading image from ${url}:`, error);
    return false;
  }
}

/**
 * Create PRD file from ticket details
 * Downloads images and updates markdown to reference local paths
 */
async function createPrdFile(
  workDir: string,
  ticket: TicketDetails,
  primaryRepoPath: string
): Promise<void> {
  const claudeWorkDir = join(workDir, ".claude", "work");
  const attachmentsDir = join(claudeWorkDir, "attachments");

  // Ensure directories exist
  mkdirSync(claudeWorkDir, { recursive: true });
  mkdirSync(attachmentsDir, { recursive: true });

  let description = ticket.description || "";

  // Extract and download images
  const images = extractImageUrls(description);
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    // Generate filename from alt text or index
    const ext = /\.(png|jpg|jpeg|gif|webp|svg)/i.exec(image.url)?.[1] || "png";
    const filename = `image-${i + 1}.${ext}`;
    const localPath = join(attachmentsDir, filename);

    const downloaded = await downloadImage(image.url, localPath);
    if (downloaded) {
      // Replace URL in description with absolute path so agents can find it
      description = description.replace(image.url, localPath);
    }
  }

  // Create PRD content with absolute paths for images
  const additionalContextSection = ticket.additionalContext
    ? `
## Additional Instructions

${ticket.additionalContext}
`
    : "";

  const contextReposSection =
    ticket.contextRepoPaths && ticket.contextRepoPaths.length > 0
      ? `
## Context Repositories

The following repositories are available as read-only reference. Use Read, Grep, and Glob to explore patterns, shared types, or dependencies:

${ticket.contextRepoPaths.map((p) => `- \`${expandHome(p)}\``).join("\n")}
`
      : "";

  // Build "Referenced Files" section from mentioned files
  const primaryRepoName = basename(primaryRepoPath);
  let referencedFilesSection = "";
  if (ticket.mentionedFiles && ticket.mentionedFiles.length > 0) {
    const resolvedPaths = ticket.mentionedFiles.map((file) => {
      const mentionRepoName = basename(expandHome(file.repoPath));
      if (mentionRepoName === primaryRepoName) {
        return join(workDir, file.filePath);
      }
      return join(expandHome(file.repoPath), file.filePath);
    });
    referencedFilesSection = `
## Referenced Files

${resolvedPaths.map((p) => `- \`${p}\``).join("\n")}
`;
  }

  const prdContent = `# ${ticket.title}

**Ticket:** [${ticket.identifier}](${ticket.url})

## Description

${description}
${additionalContextSection}${contextReposSection}${referencedFilesSection}
---

## Visual References

${
  images.length > 0
    ? images
        .map((_, i) => {
          const imgPath = join(attachmentsDir, `image-${i + 1}.png`);
          return `![Image ${i + 1}](${imgPath})`;
        })
        .join("\n\n")
    : "_No visual references attached_"
}
`;

  // Write PRD file
  writeFileSync(join(claudeWorkDir, "prd.md"), prdContent);
}

/**
 * Resolve the remote's default branch ref (e.g. "origin/main" or "origin/develop").
 * Uses `git symbolic-ref refs/remotes/origin/HEAD` which is set on clone.
 * Falls back to HEAD if the ref can't be determined.
 */
function getRemoteDefaultBranch(repoPath: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim(); // e.g. "refs/remotes/origin/main"
    // Strip the refs/remotes/ prefix to get "origin/main"
    return ref.replace("refs/remotes/", "");
  } catch {
    // origin/HEAD not set — try to auto-detect it from the remote
    try {
      execSync("git remote set-head origin --auto", {
        cwd: repoPath,
        stdio: "pipe",
      });
      const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
        cwd: repoPath,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
      return ref.replace("refs/remotes/", "");
    } catch {
      return "HEAD";
    }
  }
}

type LaunchParams = {
  ticketIdentifier: string;
  repoPath: string;
  ticket?: TicketDetails;
  baseBranch?: string;
};

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function getPrdFileIfExists(worktreeDir: string): string | undefined {
  const prdFile = join(worktreeDir, ".claude", "work", "prd.md");
  return existsSync(prdFile) ? prdFile : undefined;
}

function validateLaunchBody(
  body: Record<string, unknown>
): NextResponse | LaunchParams {
  const { ticketIdentifier, repoPath, ticket, baseBranch } =
    body as unknown as LaunchParams;

  if (!ticketIdentifier || typeof ticketIdentifier !== "string") {
    return NextResponse.json(
      { error: "ticketIdentifier is required and must be a string" },
      { status: 400 }
    );
  }
  if (!repoPath || typeof repoPath !== "string") {
    return NextResponse.json(
      { error: "repoPath is required and must be a string" },
      { status: 400 }
    );
  }
  if (!isRepoAllowed(repoPath)) {
    return NextResponse.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }
  if (ticket?.contextRepoPaths) {
    for (const ctxPath of ticket.contextRepoPaths) {
      if (!isRepoAllowed(ctxPath)) {
        return NextResponse.json(
          { error: `Context repository not allowed: ${ctxPath}` },
          { status: 403 }
        );
      }
    }
  }
  return { ticketIdentifier, repoPath, ticket, baseBranch };
}

const SAFE_REF_REGEX = /^[a-zA-Z0-9/_.-]+$/;

type WorktreeResult = {
  resolvedBaseBranch: string;
  parentTicketId: string | null;
};

function createGitWorktree(
  expandedRepoPath: string,
  worktreeDir: string,
  branchName: string,
  baseBranch?: string
): NextResponse | WorktreeResult {
  try {
    fetchOrigin(expandedRepoPath);

    // Determine the base ref: use provided baseBranch or fall back to remote default
    let parentTicketId: string | null = null;
    let resolvedBaseBranch: string;

    if (baseBranch) {
      if (!SAFE_REF_REGEX.test(baseBranch)) {
        return NextResponse.json(
          { error: `Invalid branch name: ${baseBranch}` },
          { status: 400 }
        );
      }
      // Try the ref as-is first (local branch), then fall back to origin/<branch>.
      // This handles freshly cloned repos where only the remote-tracking ref exists.
      const resolved = [baseBranch, `origin/${baseBranch}`].find(
        (ref) =>
          spawnSync("git", ["rev-parse", "--verify", ref], {
            cwd: expandedRepoPath,
            stdio: "pipe",
          }).status === 0
      );
      if (!resolved) {
        return NextResponse.json(
          { error: `Branch not found: ${baseBranch}` },
          { status: 400 }
        );
      }
      resolvedBaseBranch = resolved;
      parentTicketId = extractTicketIdFromBranch(baseBranch);
    } else {
      resolvedBaseBranch = getRemoteDefaultBranch(expandedRepoPath);
    }

    // Create the branch from the base ref (it might already exist)
    spawnSync("git", ["branch", branchName, resolvedBaseBranch], {
      cwd: expandedRepoPath,
      stdio: "pipe",
    });

    addWorktree(expandedRepoPath, worktreeDir, branchName);

    return { resolvedBaseBranch, parentTicketId };
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to create git worktree: ${getErrorMessage(err)}` },
      { status: 500 }
    );
  }
}

/**
 * API route to launch Symphony run-loop.sh script
 *
 * POST /api/engineer/symphony/launch
 * Body: { ticketIdentifier: string, repoPath: string, ticket?: TicketDetails, baseBranch?: string }
 *
 * This route:
 * 1. Validates the ticket identifier and repo path
 * 2. Creates a git worktree at ~/Source/{repoName}-{ticketId}
 * 3. Creates a PRD file from ticket details (if provided)
 * 4. Spawns the run-loop.sh process in the worktree directory
 * 5. Returns the process status
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = validateLaunchBody(body);
    if (validated instanceof NextResponse) {
      return validated;
    }

    const { ticketIdentifier, repoPath, ticket, baseBranch } = validated;
    const sanitizedTicket = ticketIdentifier.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
    const expandedRepoPath = expandHome(repoPath);
    const repoName = basename(expandedRepoPath);
    const worktreeDir = join(
      getWorktreeParentDir(),
      `${repoName}-${sanitizedTicket}`
    );
    const branchName = `feature/${sanitizedTicket}`;

    if (!existsSync(expandedRepoPath)) {
      return NextResponse.json(
        { error: `Repository not found: ${expandedRepoPath}` },
        { status: 404 }
      );
    }

    // Worktrees require at least one commit — reject empty repos with a helpful message
    const isEmptyRepo =
      spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: expandedRepoPath,
        stdio: "pipe",
      }).status !== 0;

    if (isEmptyRepo) {
      return NextResponse.json(
        {
          error:
            'This repository has no commits yet. Create an initial commit first (e.g. `git commit --allow-empty -m "Initial commit"`) and then try again.',
        },
        { status: 400 }
      );
    }

    // Worktree already exists — update PRD and re-launch
    if (existsSync(worktreeDir)) {
      if (ticket) {
        await createPrdFile(worktreeDir, ticket, expandedRepoPath);
      }
      return launchSymphony(
        worktreeDir,
        sanitizedTicket,
        getPrdFileIfExists(worktreeDir),
        baseBranch
      );
    }

    // Create a new git worktree
    const result = createGitWorktree(
      expandedRepoPath,
      worktreeDir,
      branchName,
      baseBranch
    );
    if (result instanceof NextResponse) {
      return result;
    }

    if (ticket) {
      await createPrdFile(worktreeDir, ticket, expandedRepoPath);
    }

    return launchSymphony(
      worktreeDir,
      sanitizedTicket,
      getPrdFileIfExists(worktreeDir),
      result.resolvedBaseBranch,
      result.parentTicketId
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to launch Symphony: ${getErrorMessage(err)}` },
      { status: 500 }
    );
  }
}

/**
 * Launch Symphony run-loop.sh in the given directory
 */
function launchSymphony(
  workDir: string,
  ticketIdentifier: string,
  prdFile?: string,
  baseBranch?: string,
  parentTicketId?: string | null
) {
  const scriptPath = getSymphonyScriptPath();

  if (!scriptPath) {
    return NextResponse.json(
      {
        error: "run-loop.sh not found",
        detail:
          "No closedloop/experimental plugin found in ~/.claude/plugins/cache/. Make sure the plugin is installed.",
      },
      { status: 404 }
    );
  }

  // Symphony workdir is .claude/work within the worktree
  const claudeWorkDir = join(workDir, ".claude", "work");
  mkdirSync(claudeWorkDir, { recursive: true });

  // Build arguments - pass .claude/work as the workdir to run-loop.sh
  const args = [claudeWorkDir];
  if (prdFile) {
    args.push("--prd", prdFile);
  }

  // Create log file for script stdout/stderr (echo statements, progress messages)
  // JSON output from claude CLI is written separately to claude-output.jsonl by run-loop.sh
  const logFile = join(claudeWorkDir, "symphony-launch.log");
  const logFd = openSync(logFile, "a");

  // Spawn the run-loop.sh process
  // Run in detached mode so it continues after the request completes
  // Log stdout/stderr to file for debugging
  const child = spawn(scriptPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: workDir,
    env: {
      ...process.env,
      SYMPHONY_WORKDIR: claudeWorkDir,
      // Ensure PATH includes common tool locations
      PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
    },
  });

  // Unref the child process so the parent doesn't wait for it
  child.unref();

  // Write PID to file for process lifecycle tracking
  if (child.pid) {
    writeFileSync(join(claudeWorkDir, "process.pid"), String(child.pid));
  }

  // Return success response
  return NextResponse.json({
    success: true,
    ticketIdentifier,
    workDir,
    pid: child.pid,
    logFile,
    message: "Symphony loop launched successfully",
    baseBranch,
    parentTicketId: parentTicketId ?? undefined,
  });
}
