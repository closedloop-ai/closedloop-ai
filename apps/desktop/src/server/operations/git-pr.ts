import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { isNetworkError } from "../../main/gateway-logger.js";
import type {
  OperationDispatcher,
  OperationRequestContext,
} from "../operation-dispatcher.js";
import { DirectoryNotAllowedError } from "../security.js";
import { getShellEnv, resolveBinaryFromLoginShell } from "../shell-path.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import { getOverrideBinaryPaths, getResolvedGitPath } from "./symphony-loop.js";
import { assertRepoAllowed } from "./symphony-utils.js";

const execFileAsync = promisify(execFile);
const PR_NUMBER_REGEX = /\/pull\/(\d+)/;
const GITHUB_REMOTE_REGEX = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/;
const GIT_SUFFIX_REGEX = /\.git$/;

/**
 * jq projection for `pulls/{n}/files`: one compact JSON object per file (NDJSON
 * across `--paginate` pages). The PR's `additions`/`deletions` come from the same
 * GitHub response as the filename — authoritative per-file LOC, so we keep them
 * instead of `.[].filename`. `changes` (= additions + deletions) is derived
 * downstream and not carried on the wire.
 */
const PR_FILES_JQ = ".[] | {filename, additions, deletions}";

/**
 * A changed file as returned by the `/pr/files` route (both slug + local modes).
 * Validated at the boundary because `gh` output can shape-drift: a missing or
 * non-numeric field must FAIL (not silently emit 200 with bad data), so the
 * caller's try/catch converts it to a 500.
 */
const gatewayPrFileSchema = z.object({
  filename: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

type GatewayPrFile = z.infer<typeof gatewayPrFileSchema>;

/** Parse the NDJSON `gh api --jq` output into validated per-file LOC records. */
function parsePrFilesOutput(output: string): GatewayPrFile[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => gatewayPrFileSchema.parse(JSON.parse(line)));
}

type PRComment = {
  id: string;
  databaseId: number;
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  isReview: boolean;
  url: string;
  inReplyToId?: number;
};

export function registerGitPrRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register("POST", "/api/gateway/git/pr", async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }

    const repoPath = asString(body.repoPath);
    const title = asString(body.title);
    const description = asString(body.body) ?? "";
    const ticketUrl = asString(body.ticketUrl);

    if (!repoPath) {
      json(context, 400, { error: "repoPath is required" });
      return;
    }
    if (!title) {
      json(context, 400, { error: "title is required" });
      return;
    }

    let cwd: string;
    try {
      cwd = assertRepoAllowed(repoPath, getAllowedDirectories());
    } catch (error) {
      if (error instanceof DirectoryNotAllowedError) {
        json(context, 403, { error: "directory not allowed" });
        return;
      }
      throw error;
    }

    const ghBin = (
      await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
    ).path;

    const fullBody = ticketUrl
      ? `${description}\n\n---\nLinear: ${ticketUrl}`.trim()
      : description;

    try {
      const currentBranch = await runRead(cwd, getResolvedGitPath(), [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      await run(cwd, getResolvedGitPath(), [
        "push",
        "-u",
        "origin",
        currentBranch,
      ]);

      const createOutput = await runRead(cwd, ghBin, [
        "pr",
        "create",
        "--head",
        currentBranch,
        "--title",
        title,
        "--body",
        fullBody,
      ]);

      const parsedFromUrl = parsePrNumber(createOutput);
      if (parsedFromUrl) {
        json(context, 200, {
          success: true,
          url: createOutput,
          number: parsedFromUrl,
          message: `Created PR #${parsedFromUrl}`,
        });
        return;
      }

      const view = await runRead(cwd, ghBin, [
        "pr",
        "view",
        "--json",
        "url,number",
      ]);
      const parsedView = JSON.parse(view) as { url?: string; number?: number };
      json(context, 200, {
        success: true,
        url: parsedView.url,
        number: parsedView.number,
        message: `Created PR #${parsedView.number ?? "unknown"}`,
      });
    } catch (error) {
      const message = String(error);
      if (message.includes("already exists")) {
        try {
          const view = await runRead(cwd, ghBin, [
            "pr",
            "view",
            "--json",
            "url,number",
          ]);
          const parsedView = JSON.parse(view) as {
            url?: string;
            number?: number;
          };
          json(context, 200, {
            success: true,
            url: parsedView.url,
            number: parsedView.number,
            message: `PR #${parsedView.number ?? "unknown"} already exists`,
          });
          return;
        } catch {
          // fall through to mapped error response
        }
      }

      json(context, 500, { error: parseGhError(error) });
    }
  });

  dispatcher.register("GET", "/api/gateway/git/pr/list", async (context) => {
    const repoPath = context.query.get("repo");
    const state = context.query.get("state") ?? "open";

    if (!repoPath) {
      json(context, 400, { error: "Missing 'repo' query parameter" });
      return;
    }
    if (state !== "open" && state !== "merged") {
      json(context, 400, { error: "state must be 'open' or 'merged'" });
      return;
    }

    let cwd: string;
    try {
      cwd = assertRepoAllowed(repoPath, getAllowedDirectories());
    } catch (error) {
      if (error instanceof DirectoryNotAllowedError) {
        json(context, 403, { error: "directory not allowed" });
        return;
      }
      throw error;
    }

    const ghBin = (
      await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
    ).path;

    try {
      const output = await runRead(cwd, ghBin, [
        "pr",
        "list",
        "--state",
        state,
        "--limit",
        "50",
        "--json",
        "number,title,url,author,state,createdAt,headRefName",
      ]);
      const rows = JSON.parse(output) as Array<{
        number: number;
        title: string;
        url: string;
        author?: { login?: string };
        state: string;
        createdAt: string;
        headRefName: string;
      }>;

      json(context, 200, {
        prs: rows.map((row) => ({
          number: row.number,
          title: row.title,
          url: row.url,
          author: row.author?.login ?? "unknown",
          state: row.state,
          createdAt: row.createdAt,
          headRefName: row.headRefName,
        })),
      });
    } catch (error) {
      json(context, 500, { error: parseGhError(error) });
    }
  });

  dispatcher.register(
    "GET",
    "/api/gateway/git/pr/comments",
    async (context) => {
      const repoPath = context.query.get("repo");
      const prNumber = context.query.get("pr");

      if (!repoPath) {
        json(context, 400, { error: "Missing 'repo' query parameter" });
        return;
      }
      if (!prNumber) {
        json(context, 400, { error: "Missing 'pr' query parameter" });
        return;
      }
      if (!/^\d+$/.test(prNumber)) {
        json(context, 400, { error: "Invalid PR number" });
        return;
      }

      let cwd: string;
      try {
        cwd = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const ghBin = (
        await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
      ).path;

      try {
        const prDataOutput = await runRead(cwd, ghBin, [
          "pr",
          "view",
          prNumber,
          "--json",
          "number,url,comments,reviews",
        ]);
        const prData = JSON.parse(prDataOutput) as {
          number: number;
          url: string;
          comments?: Array<{
            id: string;
            databaseId: number;
            author?: { login?: string };
            body: string;
            createdAt: string;
            url: string;
          }>;
          reviews?: Array<{
            id: string;
            author?: { login?: string };
            body: string;
            createdAt: string;
            comments?: Array<{
              id: string;
              databaseId: number;
              author?: { login?: string };
              body: string;
              createdAt: string;
              path?: string;
              line?: number;
              url: string;
            }>;
          }>;
        };

        const comments: PRComment[] = [];
        const seenIds = new Set<string>();

        for (const comment of prData.comments ?? []) {
          comments.push({
            id: comment.id,
            databaseId: comment.databaseId,
            author: comment.author?.login ?? "unknown",
            body: comment.body,
            createdAt: comment.createdAt,
            isReview: false,
            url: comment.url,
          });
          seenIds.add(comment.id);
        }

        for (const review of prData.reviews ?? []) {
          if (review.body?.trim()) {
            comments.push({
              id: review.id,
              databaseId: 0,
              author: review.author?.login ?? "unknown",
              body: review.body,
              createdAt: review.createdAt,
              isReview: true,
              url: "",
            });
            seenIds.add(review.id);
          }

          for (const rc of review.comments ?? []) {
            comments.push({
              id: rc.id,
              databaseId: rc.databaseId,
              author: rc.author?.login ?? "unknown",
              body: rc.body,
              createdAt: rc.createdAt,
              path: rc.path,
              line: rc.line,
              isReview: true,
              url: rc.url,
            });
            seenIds.add(rc.id);
          }
        }

        const repoSlug = await getRepoSlug(cwd);
        if (repoSlug) {
          const inlineResult = spawnSync(
            ghBin,
            [
              "api",
              `repos/${repoSlug}/pulls/${prNumber}/comments`,
              "--paginate",
            ],
            {
              cwd,
              encoding: "utf-8",
              env: await withPathEnv(),
            }
          );

          if (inlineResult.status === 0) {
            const inlineRows = JSON.parse(inlineResult.stdout) as Array<{
              id: number;
              user?: { login?: string };
              body: string;
              created_at: string;
              path: string;
              original_line?: number;
              line?: number;
              html_url: string;
              in_reply_to_id?: number;
            }>;

            for (const row of inlineRows) {
              const id = `IC_${row.id}`;
              if (seenIds.has(id)) {
                continue;
              }
              comments.push({
                id,
                databaseId: row.id,
                author: row.user?.login ?? "unknown",
                body: row.body,
                createdAt: row.created_at,
                path: row.path,
                line: row.original_line ?? row.line,
                isReview: true,
                url: row.html_url,
                inReplyToId: row.in_reply_to_id,
              });
              seenIds.add(id);
            }
          }
        }

        comments.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        json(context, 200, {
          comments,
          prNumber: prData.number,
          prUrl: prData.url,
        });
      } catch (error) {
        const message = String(error);
        if (message.includes("Could not resolve to a PullRequest")) {
          json(context, 404, { error: `PR #${prNumber} not found` });
          return;
        }
        json(context, 500, { error: parseGhError(error) });
      }
    }
  );

  dispatcher.register("GET", "/api/gateway/git/pr/reviews", async (context) => {
    const owner = context.query.get("owner");
    const repo = context.query.get("repo");
    const number = context.query.get("number");

    if (!(owner && repo && number)) {
      json(context, 400, { error: "owner, repo, and number are required" });
      return;
    }

    const ghBin = (
      await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
    ).path;

    try {
      const output = await runRead(undefined, ghBin, [
        "pr",
        "view",
        number,
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "reviewDecision,reviews",
      ]);

      const data = JSON.parse(output) as {
        reviewDecision?: string | null;
        reviews?: Array<{
          state:
            | "APPROVED"
            | "CHANGES_REQUESTED"
            | "COMMENTED"
            | "PENDING"
            | "DISMISSED";
          submittedAt: string;
          author?: { login?: string };
        }>;
      };

      const latestByAuthor = new Map<
        string,
        {
          author: string;
          state:
            | "APPROVED"
            | "CHANGES_REQUESTED"
            | "COMMENTED"
            | "PENDING"
            | "DISMISSED";
          submittedAt: string;
        }
      >();

      for (const review of data.reviews ?? []) {
        const author = review.author?.login ?? "unknown";
        const existing = latestByAuthor.get(author);
        if (
          !existing ||
          new Date(review.submittedAt) > new Date(existing.submittedAt)
        ) {
          latestByAuthor.set(author, {
            author,
            state: review.state,
            submittedAt: review.submittedAt,
          });
        }
      }

      const reviews = [...latestByAuthor.values()];
      const approvalCount = reviews.filter(
        (review) => review.state === "APPROVED"
      ).length;
      const changesRequestedCount = reviews.filter(
        (review) => review.state === "CHANGES_REQUESTED"
      ).length;

      json(context, 200, {
        reviewDecision: data.reviewDecision ?? null,
        reviews,
        approvalCount,
        changesRequestedCount,
      });
    } catch {
      json(context, 500, { error: "Failed to fetch PR reviews" });
    }
  });

  dispatcher.register("POST", "/api/gateway/git/pr/reply", async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }

    const repoPath = asString(body.repoPath);
    const replyBody = asString(body.body);
    const prNumber = asNumber(body.prNumber);
    const commentId = asNumber(body.commentId);
    const requestChanges = body.requestChanges === true;

    if (!repoPath) {
      json(context, 400, { error: "Missing 'repoPath' in request body" });
      return;
    }
    if (!replyBody) {
      json(context, 400, { error: "Missing 'body' in request body" });
      return;
    }
    if (!prNumber) {
      json(context, 400, { error: "prNumber is required" });
      return;
    }

    let cwd: string;
    try {
      cwd = assertRepoAllowed(repoPath, getAllowedDirectories());
    } catch (error) {
      if (error instanceof DirectoryNotAllowedError) {
        json(context, 403, { error: "directory not allowed" });
        return;
      }
      throw error;
    }

    const ghBin = (
      await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
    ).path;

    try {
      const repoSlug = await getRepoSlug(cwd);

      // Submit as a "Request Changes" PR review
      if (requestChanges) {
        const args = ["pr", "review", String(prNumber), "--request-changes"];
        if (repoSlug) {
          args.push("-R", repoSlug);
        }
        const result = await ghPrCommentViaStdin(args, replyBody, cwd, ghBin);
        json(context, 200, {
          success: true,
          message: "Changes requested",
          output: result.stdout.trim(),
        });
        return;
      }

      if (commentId && commentId > 0 && repoSlug) {
        const result = await ghApiViaStdin(
          `repos/${repoSlug}/pulls/${prNumber}/comments/${commentId}/replies`,
          { body: replyBody },
          cwd,
          ghBin
        );

        json(context, 200, {
          success: true,
          message: "Reply posted successfully",
          output: result.stdout.trim(),
        });
        return;
      }

      const args = ["pr", "comment", String(prNumber)];
      if (repoSlug) {
        args.push("-R", repoSlug);
      }
      const result = await ghPrCommentViaStdin(args, replyBody, cwd, ghBin);

      json(context, 200, {
        success: true,
        message: "Comment posted successfully",
        output: result.stdout.trim(),
      });
    } catch (error) {
      json(context, 500, { error: parseGhError(error) });
    }
  });

  dispatcher.register("GET", "/api/gateway/git/pr/files", async (context) => {
    // Slug mode (owner + repo NAME + number): list a PR's changed files via the
    // GitHub API directly — no local checkout required. Mirrors /pr/reviews
    // (`runRead(undefined, …)`), so the desktop Branches detail can list files
    // for any PR the authed `gh` user can read, even when the repo isn't
    // registered/cloned locally. Read-only and slug-scoped (no filesystem access).
    const owner = context.query.get("owner");
    const repoName = context.query.get("repo");
    const slugNumber = context.query.get("number");
    if (owner && repoName && slugNumber) {
      await handlePrFilesBySlug(context, owner, repoName, slugNumber);
      return;
    }

    const repoPath = context.query.get("repo");
    const prNumber = context.query.get("pr");

    if (!(repoPath && prNumber)) {
      json(context, 400, { error: "repo and pr are required" });
      return;
    }

    let cwd: string;
    try {
      cwd = assertRepoAllowed(repoPath, getAllowedDirectories());
    } catch (error) {
      if (error instanceof DirectoryNotAllowedError) {
        json(context, 403, { error: "directory not allowed" });
        return;
      }
      throw error;
    }

    const ghBin = (
      await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
    ).path;

    try {
      const repoSlug = await getRepoSlug(cwd);
      if (!repoSlug) {
        json(context, 500, { error: "Could not determine repository" });
        return;
      }

      const output = await runRead(cwd, ghBin, [
        "api",
        `repos/${repoSlug}/pulls/${prNumber}/files`,
        "--paginate",
        "--jq",
        PR_FILES_JQ,
      ]);

      json(context, 200, { files: parsePrFilesOutput(output) });
    } catch {
      json(context, 500, { error: "Failed to get PR files" });
    }
  });

  dispatcher.register(
    "GET",
    "/api/gateway/git/pr/head-sha",
    async (context) => {
      const repoPath = context.query.get("repo");
      const prNumber = context.query.get("pr");

      if (!(repoPath && prNumber)) {
        json(context, 400, { error: "repo and pr are required" });
        return;
      }

      let cwd: string;
      try {
        cwd = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const ghBin = (
        await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
      ).path;

      try {
        const repoSlug = await getRepoSlug(cwd);
        if (!repoSlug) {
          json(context, 500, { error: "Could not determine repository" });
          return;
        }

        const sha = await runRead(cwd, ghBin, [
          "api",
          `repos/${repoSlug}/pulls/${prNumber}`,
          "--jq",
          ".head.sha",
        ]);

        if (!sha) {
          json(context, 500, { error: "Could not get head SHA" });
          return;
        }

        json(context, 200, { sha });
      } catch {
        json(context, 500, { error: "Failed to get PR head SHA" });
      }
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/git/pr/inline-comment",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoPath = asString(body.repoPath);
      const prNumber = asNumber(body.prNumber);
      const commentBody = asString(body.body);
      const filePath = asString(body.path);
      const line = asNumber(body.line);
      const commitSha = asString(body.commitSha);

      if (!repoPath) {
        json(context, 400, { error: "repoPath is required" });
        return;
      }
      if (!prNumber) {
        json(context, 400, { error: "prNumber is required" });
        return;
      }
      if (!commentBody) {
        json(context, 400, { error: "body is required" });
        return;
      }

      let cwd: string;
      try {
        cwd = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const ghBin = (
        await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
      ).path;

      try {
        const repoSlug = await getRepoSlug(cwd);
        if (!repoSlug) {
          json(context, 500, { error: "Could not determine repository" });
          return;
        }

        if (filePath && line && commitSha) {
          try {
            const result = await ghApiViaStdin(
              `repos/${repoSlug}/pulls/${prNumber}/comments`,
              {
                body: commentBody,
                path: filePath,
                line,
                commit_id: commitSha,
                side: "RIGHT",
              },
              cwd,
              ghBin
            );
            json(context, 200, { success: true, output: result.stdout.trim() });
            return;
          } catch {
            // Fall through to file-level comment.
          }
        }

        if (filePath && commitSha) {
          try {
            const result = await ghApiViaStdin(
              `repos/${repoSlug}/pulls/${prNumber}/comments`,
              {
                body: commentBody,
                path: filePath,
                commit_id: commitSha,
                subject_type: "file",
              },
              cwd,
              ghBin
            );
            json(context, 200, { success: true, output: result.stdout.trim() });
            return;
          } catch {
            // Fall through to general PR comment.
          }
        }

        const result = await ghPrCommentViaStdin(
          ["pr", "comment", String(prNumber), "-R", repoSlug],
          commentBody,
          cwd,
          ghBin
        );
        json(context, 200, { success: true, output: result.stdout.trim() });
      } catch (error) {
        const execError = error as { stderr?: string; message?: string };
        json(context, 500, {
          error:
            execError.stderr || execError.message || "Failed to post comment",
        });
      }
    }
  );

  dispatcher.register("GET", "/api/gateway/git/user", async (context) => {
    try {
      const ghBin = (
        await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
      ).path;
      const login = await runRead(undefined, ghBin, [
        "api",
        "user",
        "--jq",
        ".login",
      ]);
      if (!login) {
        json(context, 500, { error: "Could not determine GitHub user" });
        return;
      }
      json(context, 200, { login });
    } catch {
      json(context, 500, {
        error:
          "Failed to get GitHub user. Ensure gh is installed and authenticated.",
      });
    }
  });
}

async function getRepoSlug(cwd: string): Promise<string> {
  try {
    const remoteUrl = await runRead(cwd, getResolvedGitPath(), [
      "remote",
      "get-url",
      "origin",
    ]);
    const match = GITHUB_REMOTE_REGEX.exec(remoteUrl);
    return match ? match[1].replace(GIT_SUFFIX_REGEX, "") : "";
  } catch {
    return "";
  }
}

function parsePrNumber(url: string): number | null {
  const match = PR_NUMBER_REGEX.exec(url.trim());
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseGhError(error: unknown): string {
  const message = String(error);

  if (message.includes("not logged in") || message.includes("authentication")) {
    return "GitHub CLI not authenticated. Run 'gh auth login' in terminal.";
  }
  if (message.includes("already exists")) {
    return "A pull request already exists for this branch.";
  }
  if (
    message.includes("No commits between") ||
    message.includes("no commits")
  ) {
    return "No commits to create a PR. Make sure changes are committed first.";
  }
  if (message.includes("uncommitted changes")) {
    return "You have uncommitted changes. Commit them first.";
  }
  if (message.includes("not a git repository")) {
    return "Not a git repository.";
  }
  if (message.includes("permission denied") || message.includes("403")) {
    return "Permission denied. Check your GitHub access.";
  }
  if (message.includes("not found") || message.includes("404")) {
    return "Repository not found or no access.";
  }
  if (message.includes("network") || isNetworkError(message)) {
    return "Network error. Check your connection.";
  }

  return "Failed to complete GitHub operation. Check logs for details.";
}

const SAFE_SLUG_SEGMENT = /^[A-Za-z0-9._-]+$/;
const DIGITS_ONLY = /^\d+$/;

/**
 * List a PR's changed files by `owner`/`repo`/`number` via `gh api` directly —
 * no local checkout (mirrors the /pr/reviews slug path). Read-only and
 * slug-scoped: `owner`/`repo` are validated to safe slug segments and `number`
 * to digits before interpolation, and the call accesses no local filesystem.
 */
async function handlePrFilesBySlug(
  context: OperationRequestContext,
  owner: string,
  repo: string,
  prNumber: string
): Promise<void> {
  if (
    !(
      SAFE_SLUG_SEGMENT.test(owner) &&
      SAFE_SLUG_SEGMENT.test(repo) &&
      DIGITS_ONLY.test(prNumber)
    )
  ) {
    json(context, 400, { error: "Invalid owner, repo, or number" });
    return;
  }

  const ghBin = (
    await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
  ).path;

  try {
    const output = await runRead(undefined, ghBin, [
      "api",
      `repos/${owner}/${repo}/pulls/${prNumber}/files`,
      "--paginate",
      "--jq",
      PR_FILES_JQ,
    ]);
    json(context, 200, { files: parsePrFilesOutput(output) });
  } catch {
    json(context, 500, { error: "Failed to get PR files" });
  }
}

async function runRead(
  cwd: string | undefined,
  command: string,
  args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf-8",
    env: await withPathEnv(),
  });
  return stdout.trim();
}

async function run(
  cwd: string | undefined,
  command: string,
  args: string[]
): Promise<void> {
  await execFileAsync(command, args, {
    cwd,
    encoding: "utf-8",
    env: await withPathEnv(),
  });
}

async function withPathEnv(): Promise<NodeJS.ProcessEnv> {
  return getShellEnv();
}

async function ghApiViaStdin(
  apiPath: string,
  payload: Record<string, unknown>,
  cwd: string,
  ghBin: string
): Promise<{ stdout: string; stderr: string }> {
  const env = await withPathEnv();
  return new Promise((resolve, reject) => {
    const process = spawn(
      ghBin,
      ["api", apiPath, "--method", "POST", "--input", "-"],
      {
        cwd,
        env,
      }
    );

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    process.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`gh api exited with code ${code}: ${stderr}`));
    });

    process.on("error", reject);

    process.stdin.write(JSON.stringify(payload));
    process.stdin.end();
  });
}

async function ghPrCommentViaStdin(
  args: string[],
  body: string,
  cwd: string,
  ghBin: string
): Promise<{ stdout: string; stderr: string }> {
  const env = await withPathEnv();
  return new Promise((resolve, reject) => {
    const process = spawn(ghBin, [...args, "--body-file", "-"], {
      cwd,
      env,
    });

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    process.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`gh pr comment exited with code ${code}: ${stderr}`));
    });

    process.on("error", reject);

    process.stdin.write(body);
    process.stdin.end();
  });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
