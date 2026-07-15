import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  BranchCommentsBudget,
  BranchCommentsFailureReason,
  BranchCommentsState,
  type BranchPrComment,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
  encodeBranchId,
  fitBranchPrCommentsResponseBudget,
  trimBranchPrCommentBody,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { z } from "zod";
import { isNetworkError } from "../../main/gateway-logger.js";
import {
  fetchBundledPullRequestsWithGh,
  runGhGraphql,
} from "../../main/github/gh-graphql-transport.js";
import { branchIdMatchesRepo } from "../../shared/branch-pr-scope.js";
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
const PR_FILES_JQ =
  ".[] | {filename, additions, deletions, status} + (if .previous_filename then {previous_filename} else {} end)";
const PR_FILE_DIFF_CONTENT_LIMIT_BYTES = 1024 * 1024;
const PR_FILE_DIFF_PROVIDER_BUFFER_BYTES = 3 * 1024 * 1024;
const PR_COMMENTS_MAX_COMMENTS = BranchCommentsBudget.MaxComments;
const PR_COMMENTS_PAGE_SIZE = BranchCommentsBudget.PageSize;
const PR_COMMENTS_MAX_BODY_BYTES = BranchCommentsBudget.MaxBodyBytes;
const PR_COMMENTS_MAX_RESPONSE_BYTES = BranchCommentsBudget.MaxResponseBytes;
const GH_API_READ_TIMEOUT_MS = 15_000;
const PR_REF_JQ = "{base: .base.sha, head: .head.sha}";
const PR_COMPARE_MERGE_BASE_JQ = "{mergeBase: .merge_base_commit.sha}";
const DOT_ONLY_SEGMENT_REGEX = /^\.+$/;
export const RETIRED_GITHUB_DATA_ROUTE_ERROR = "github_data_route_retired";
export const RETIRED_GITHUB_DATA_ROUTE_MESSAGE =
  "Desktop GitHub data is synced from cloud. This local gh-backed route has been retired.";
const RETIRED_GITHUB_DATA_ROUTES = [
  { method: "GET", path: "/api/gateway/git/pr/list" },
  { method: "GET", path: "/api/gateway/git/pr/comments" },
  { method: "GET", path: "/api/gateway/git/pr/reviews" },
  { method: "POST", path: "/api/gateway/git/pr/reply" },
  { method: "GET", path: "/api/gateway/git/pr/files" },
  { method: "GET", path: "/api/gateway/git/pr/file-diff" },
  { method: "GET", path: "/api/gateway/git/pr/head-sha" },
  { method: "POST", path: "/api/gateway/git/pr/inline-comment" },
] as const;

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
  status: z.string().optional(),
  previous_filename: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional()
  ),
});

type GatewayPrFile = z.infer<typeof gatewayPrFileSchema>;

export type BranchPrIdentity = {
  repoFullName: string | null;
  prNumber: number | null;
  prUrl: string | null;
};

export type BranchPrIdentityResolver = (
  branchId: string
) => Promise<BranchPrIdentity | null> | BranchPrIdentity | null;

export type RegisterGitPrRoutesOptions = {
  /**
   * Keep legacy local-gh PR data/comment routes available by default for
   * version-skewed renderers. Passing false explicitly exercises the retired
   * HTTP 410 path once callers no longer depend on these routes.
   */
  enableGithubDataRoutes?: boolean;
};

const gatewayPrRefsSchema = z.object({
  base: z.string().min(1),
  head: z.string().min(1),
});

const gatewayPrCompareSchema = z.object({
  mergeBase: z.string().min(1),
});

const gatewayFileContentSchema = z.object({
  content: z.string(),
  encoding: z.string(),
});
const BINARY_CONTENT_REGEX = /\0/;
const providerProcessErrorSchema = z.object({
  stderr: z.string().optional(),
  stdout: z.string().optional(),
  message: z.string().optional(),
});
const providerTimeoutErrorSchema = z.object({
  killed: z.literal(true),
});

/** Parse the NDJSON `gh api --jq` output into validated per-file LOC records. */
function parsePrFilesOutput(output: string): GatewayPrFile[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => gatewayPrFileSchema.parse(JSON.parse(line)));
}

function registerRetiredGithubDataRoutes(
  dispatcher: OperationDispatcher
): void {
  for (const route of RETIRED_GITHUB_DATA_ROUTES) {
    dispatcher.register(route.method, route.path, (context) => {
      json(context, 410, {
        error: RETIRED_GITHUB_DATA_ROUTE_ERROR,
        message: RETIRED_GITHUB_DATA_ROUTE_MESSAGE,
      });
    });
  }
}

export function registerGitPrRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  resolveBranchPrIdentity?: BranchPrIdentityResolver,
  options: RegisterGitPrRoutesOptions = {}
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

  if (options.enableGithubDataRoutes === false) {
    registerRetiredGithubDataRoutes(dispatcher);
    return;
  }

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
      const repoSlug = await getRepoSlug(cwd);
      if (!repoSlug) {
        json(context, 500, { error: "Repository not found or no access." });
        return;
      }
      const [owner, repo] = repoSlug.split("/");
      if (!(owner && repo)) {
        json(context, 500, { error: "Repository not found or no access." });
        return;
      }
      const result = await fetchBundledPullRequestsWithGh(
        ghBin,
        owner,
        repo,
        []
      );
      if (!result.ok) {
        json(context, 500, { error: formatGhGraphqlError(result.reason) });
        return;
      }

      json(context, 200, {
        prs: result.value.pullRequests
          .filter((row) => gatewayPrMatchesState(row.state, state))
          .slice(0, 50)
          .map((row) => ({
            number: row.number,
            title: row.title,
            url: row.htmlUrl,
            author: row.author ?? "unknown",
            state: row.state,
            createdAt: row.openedAt ?? row.updatedAt ?? "",
            headRefName: row.headBranch,
          })),
        hasMore: result.value.hasMore === true,
        truncated: result.value.truncated === true,
        pageInfo: result.value.pageInfo ?? {
          hasNextPage: false,
          endCursor: null,
        },
      });
    } catch (error) {
      json(context, 500, { error: parseGhError(error) });
    }
  });

  dispatcher.register(
    "GET",
    "/api/gateway/git/pr/comments",
    async (context) => {
      const request = await resolveGatewayPrCommentsRequest(
        context,
        getAllowedDirectories,
        resolveBranchPrIdentity
      );
      if (!request.ok) {
        json(context, request.status, request.error);
        return;
      }

      const ghBin = (
        await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
      ).path;

      try {
        const providerResult = await fetchGatewayPrComments(
          ghBin,
          request.owner,
          request.repo,
          request.prNumber
        );
        if (!providerResult.ok) {
          const status = providerResult.reason === "auth_required" ? 401 : 503;
          json(context, status, {
            error: formatGhGraphqlError(providerResult.reason),
            reason: mapGhGraphqlFailureToBranchCommentsReason(
              providerResult.reason
            ),
          });
          return;
        }
        const prData = providerResult.value.prData;
        if (!prData) {
          json(context, 404, {
            error: `PR #${request.prNumber} not found`,
            reason: BranchCommentsFailureReason.NotFound,
          });
          return;
        }

        const comments: BranchPrComment[] = [];
        const seenIds = new Set<string>();

        for (const comment of prData.comments?.nodes ?? []) {
          appendGatewayComment(comments, seenIds, comment, {
            kind: BranchPrCommentKind.Issue,
            threadId: null,
            inReplyToId: null,
          });
          seenIds.add(comment.id);
        }

        for (const review of prData.reviews?.nodes ?? []) {
          if (review.body?.trim()) {
            appendGatewayReviewBody(comments, seenIds, review);
            seenIds.add(review.id);
          }

          for (const rc of review.comments?.nodes ?? []) {
            appendGatewayReviewComment(comments, seenIds, rc);
          }
        }

        appendGatewayReviewThreadComments(
          comments,
          seenIds,
          prData.reviewThreads?.nodes ?? []
        );

        comments.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        json(
          context,
          200,
          buildGatewayPrCommentsResponse(
            request.branchId,
            prData.number,
            prData.url,
            comments,
            { providerTruncated: providerResult.value.providerTruncated }
          )
        );
      } catch (error) {
        const message = String(error);
        if (message.includes("Could not resolve to a PullRequest")) {
          json(context, 404, {
            error: `PR #${request.prNumber} not found`,
            reason: BranchCommentsFailureReason.NotFound,
          });
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
      const result = await runGhGraphql<GatewayPrReviewsGraphqlResponse>(
        ghBin,
        GATEWAY_PR_REVIEWS_QUERY,
        { owner, repo, number: Number.parseInt(number, 10) }
      );
      if (!result.ok) {
        json(context, 500, { error: formatGhGraphqlError(result.reason) });
        return;
      }
      const data = result.value.repository?.pullRequest;
      if (!data) {
        json(context, 404, { error: `PR #${number} not found` });
        return;
      }

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

      for (const review of data.reviews?.nodes ?? []) {
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
    "/api/gateway/git/pr/file-diff",
    async (context) => {
      const owner = context.query.get("owner");
      const repoName = context.query.get("repo");
      const prNumber = context.query.get("number");
      const filePath = context.query.get("path");
      const branchId = context.query.get("branchId");
      const previousPath = context.query.get("previousPath") ?? undefined;

      if (!(owner && repoName && prNumber && filePath && branchId)) {
        json(context, 400, {
          error: "owner, repo, number, path, and branchId are required",
        });
        return;
      }
      if (
        !isValidPrFileDiffRequestShape(
          owner,
          repoName,
          prNumber,
          filePath,
          previousPath
        )
      ) {
        json(context, 400, { error: "Invalid owner, repo, number, or path" });
        return;
      }
      if (!branchIdMatchesRepo(branchId, owner, repoName)) {
        json(context, 403, {
          error: "branch scope does not match pull request",
        });
        return;
      }
      const branchPrIdentity = await resolveBranchPrIdentity?.(branchId);
      if (
        !branchPrIdentityMatchesRequest(
          branchPrIdentity ?? null,
          owner,
          repoName,
          prNumber
        )
      ) {
        json(context, 403, {
          error: "branch scope does not match pull request",
        });
        return;
      }

      await handlePrFileDiffBySlug(
        context,
        owner,
        repoName,
        prNumber,
        filePath,
        previousPath
      );
    }
  );

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

/**
 * Read a single PR file diff through the desktop gateway boundary. The PR file
 * list is fetched first and used as the membership allowlist before any content
 * endpoint is queried, including exact previousPath validation for renames.
 */
async function handlePrFileDiffBySlug(
  context: OperationRequestContext,
  owner: string,
  repo: string,
  prNumber: string,
  filePath: string,
  previousPath: string | undefined
): Promise<void> {
  if (
    !(
      SAFE_SLUG_SEGMENT.test(owner) &&
      SAFE_SLUG_SEGMENT.test(repo) &&
      DIGITS_ONLY.test(prNumber) &&
      isSafePrFilePath(filePath) &&
      (previousPath === undefined || isSafePrFilePath(previousPath))
    )
  ) {
    json(context, 400, { error: "Invalid owner, repo, number, or path" });
    return;
  }

  const ghBin = (
    await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
  ).path;

  try {
    const filesOutput = await runReadWithTimeout(undefined, ghBin, [
      "api",
      `repos/${owner}/${repo}/pulls/${prNumber}/files`,
      "--paginate",
      "--jq",
      PR_FILES_JQ,
    ]);
    const files = parsePrFilesOutput(filesOutput);
    const file = files.find((candidate) => candidate.filename === filePath);
    if (!file) {
      json(context, 404, { error: "File is not part of this pull request" });
      return;
    }
    if ((file.previous_filename ?? undefined) !== previousPath) {
      json(context, 400, { error: "previousPath does not match pull request" });
      return;
    }

    const refs = await readPrRefs(ghBin, owner, repo, prNumber);
    const oldSideRef = await resolvePrOldSideRef(
      ghBin,
      owner,
      repo,
      refs.base,
      refs.head
    );
    const oldFile =
      file.status === "added"
        ? EMPTY_FILE_CONTENT
        : await readPrFileContent(
            ghBin,
            owner,
            repo,
            previousPath ?? file.filename,
            oldSideRef
          );
    const newFile =
      file.status === "removed"
        ? EMPTY_FILE_CONTENT
        : await readPrFileContent(ghBin, owner, repo, file.filename, refs.head);
    const isBinary = oldFile.isBinary || newFile.isBinary;

    json(context, 200, {
      path: file.filename,
      oldContent: isBinary ? "" : oldFile.content,
      newContent: isBinary ? "" : newFile.content,
      isNew: file.status === "added",
      isDeleted: file.status === "removed",
      isBinary,
    });
  } catch (error) {
    if (isProviderTimeout(error)) {
      json(context, 504, { error: "GitHub provider timed out" });
      return;
    }
    if (error instanceof PrFileTooLargeError) {
      json(context, 413, { error: "PR file content is too large" });
      return;
    }
    const providerError = classifyPrFileDiffProviderError(error);
    json(context, providerError.status, { error: providerError.message });
  }
}

async function readPrRefs(
  ghBin: string,
  owner: string,
  repo: string,
  prNumber: string
): Promise<z.infer<typeof gatewayPrRefsSchema>> {
  const output = await runReadWithTimeout(undefined, ghBin, [
    "api",
    `repos/${owner}/${repo}/pulls/${prNumber}`,
    "--jq",
    PR_REF_JQ,
  ]);
  return gatewayPrRefsSchema.parse(JSON.parse(output));
}

async function resolvePrOldSideRef(
  ghBin: string,
  owner: string,
  repo: string,
  baseRef: string,
  headRef: string
): Promise<string> {
  try {
    const output = await runReadWithTimeout(undefined, ghBin, [
      "api",
      `repos/${owner}/${repo}/compare/${encodeURIComponent(
        baseRef
      )}...${encodeURIComponent(headRef)}`,
      "--jq",
      PR_COMPARE_MERGE_BASE_JQ,
    ]);
    return gatewayPrCompareSchema.parse(JSON.parse(output)).mergeBase;
  } catch {
    return baseRef;
  }
}

async function readPrFileContent(
  ghBin: string,
  owner: string,
  repo: string,
  filePath: string,
  ref: string
): Promise<PrFileContent> {
  const encodedPath = encodeProviderPath(filePath);
  const output = await runReadWithTimeout(undefined, ghBin, [
    "api",
    `repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(
      ref
    )}`,
    "--jq",
    "{content, encoding}",
  ]);
  const parsed = gatewayFileContentSchema.parse(JSON.parse(output));
  if (parsed.encoding !== "base64") {
    return { content: "", isBinary: true };
  }
  const compactBase64 = parsed.content.replaceAll(/\s/g, "");
  const content = Buffer.from(compactBase64, "base64");
  if (content.length > PR_FILE_DIFF_CONTENT_LIMIT_BYTES) {
    throw new PrFileTooLargeError();
  }
  const text = content.toString("utf8");
  return { content: text, isBinary: BINARY_CONTENT_REGEX.test(text) };
}

function encodeProviderPath(filePath: string): string {
  return filePath.split("/").map(encodeProviderPathSegment).join("/");
}

function isSafePrFilePath(filePath: string): boolean {
  return filePath.length > 0 && !filePath.includes("\0");
}

function isProviderTimeout(error: unknown): boolean {
  return providerTimeoutErrorSchema.safeParse(error).success;
}

function classifyPrFileDiffProviderError(
  error: unknown
): ProviderErrorResponse {
  if (error instanceof SyntaxError || error instanceof z.ZodError) {
    return {
      status: 502,
      message: "GitHub provider returned an invalid PR file-diff response",
    };
  }

  const message = readProviderErrorMessage(error);
  if (message.includes("rate limit")) {
    return {
      status: 429,
      message: "GitHub rate limit exceeded. Try again later.",
    };
  }
  if (isNetworkError(message)) {
    return { status: 503, message: "Network error. Check your connection." };
  }

  return { status: 500, message: "Failed to get PR file diff" };
}

function readProviderErrorMessage(error: unknown): string {
  const parsed = providerProcessErrorSchema.safeParse(error);
  if (!parsed.success) {
    return String(error).toLowerCase();
  }
  return [
    parsed.data.stderr ?? "",
    parsed.data.stdout ?? "",
    parsed.data.message ?? "",
  ]
    .join("\n")
    .toLowerCase();
}

function encodeProviderPathSegment(segment: string): string {
  if (DOT_ONLY_SEGMENT_REGEX.test(segment)) {
    return segment.replaceAll(".", "%2E");
  }
  return encodeURIComponent(segment);
}

async function runReadWithTimeout(
  cwd: string | undefined,
  command: string,
  args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf-8",
    env: await withPathEnv(),
    maxBuffer: PR_FILE_DIFF_PROVIDER_BUFFER_BYTES,
    timeout: GH_API_READ_TIMEOUT_MS,
  });
  return stdout.trim();
}

class PrFileTooLargeError extends Error {}

type PrFileContent = {
  content: string;
  isBinary: boolean;
};

type ProviderErrorResponse = {
  status: number;
  message: string;
};

const EMPTY_FILE_CONTENT: PrFileContent = {
  content: "",
  isBinary: false,
};

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

type GatewayReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "PENDING"
  | "DISMISSED";

type GatewayGhGraphqlFailureReason =
  | "gh_unavailable"
  | "auth_required"
  | "rate_limited"
  | "secondary_limited"
  | "timeout"
  | "invalid_response";

type GatewayPrCommentNode = {
  id: string;
  databaseId: number;
  author?: { login?: string | null } | null;
  body: string;
  createdAt: string;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  url: string;
  replyTo?: { databaseId?: number | null } | null;
};

type GatewayPageInfo = {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
};

type GatewayPrCommentsGraphqlResponse = {
  repository?: {
    pullRequest?: {
      number: number;
      url: string;
      comments?: {
        nodes?: GatewayPrCommentNode[] | null;
        pageInfo?: GatewayPageInfo | null;
      } | null;
      reviews?: {
        nodes?: GatewayPrReviewNode[] | null;
        pageInfo?: GatewayPageInfo | null;
      } | null;
      reviewThreads?: {
        nodes?: GatewayPrReviewThreadNode[] | null;
        pageInfo?: GatewayPageInfo | null;
      } | null;
    } | null;
  } | null;
};

type GatewayPrCommentsData = NonNullable<
  NonNullable<GatewayPrCommentsGraphqlResponse["repository"]>["pullRequest"]
>;

type GatewayPrCommentsConnectionSelection = {
  comments: boolean;
  reviews: boolean;
  reviewThreads: boolean;
};

type GatewayPrCommentConnection = {
  nodes?: GatewayPrCommentNode[] | null;
  pageInfo?: GatewayPageInfo | null;
};

type GatewayPrReviewNode = {
  id: string;
  author?: { login?: string | null } | null;
  body?: string | null;
  createdAt: string;
  comments?: GatewayPrCommentConnection | null;
};

type GatewayPrReviewThreadNode = {
  id: string;
  comments?: GatewayPrCommentConnection | null;
};

type GatewayNestedPrCommentsGraphqlResponse = {
  node?: {
    comments?: GatewayPrCommentConnection | null;
  } | null;
};

type GatewayPrReviewsGraphqlResponse = {
  repository?: {
    pullRequest?: {
      reviewDecision?: string | null;
      reviews?: {
        nodes?: Array<{
          state: GatewayReviewState;
          submittedAt: string;
          author?: { login?: string | null } | null;
        }> | null;
      } | null;
    } | null;
  } | null;
};

const GATEWAY_PR_COMMENTS_QUERY = `
  query GatewayPullRequestComments(
    $owner: String!
    $repo: String!
    $number: Int!
    $pageSize: Int!
    $issueAfter: String
    $reviewsAfter: String
    $threadsAfter: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        url
        comments(first: $pageSize, after: $issueAfter) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            databaseId
            author { login }
            body
            createdAt
            url
          }
        }
        reviews(first: $pageSize, after: $reviewsAfter) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            author { login }
            body
            createdAt
          }
        }
        reviewThreads(first: $pageSize, after: $threadsAfter) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
          }
        }
      }
    }
	  }
	`;

const GATEWAY_PR_REVIEW_COMMENTS_QUERY = `
  query GatewayPullRequestReviewComments(
    $id: ID!
    $pageSize: Int!
    $commentsAfter: String
  ) {
    node(id: $id) {
      ... on PullRequestReview {
        comments(first: $pageSize, after: $commentsAfter) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            databaseId
            author { login }
            body
            createdAt
            path
            line
            originalLine
            url
          }
        }
      }
    }
  }
`;

const GATEWAY_PR_REVIEW_THREAD_COMMENTS_QUERY = `
  query GatewayPullRequestReviewThreadComments(
    $id: ID!
    $pageSize: Int!
    $commentsAfter: String
  ) {
    node(id: $id) {
      ... on PullRequestReviewThread {
        comments(first: $pageSize, after: $commentsAfter) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            databaseId
            author { login }
            body
            createdAt
            path
            line
            originalLine
            url
            replyTo { databaseId }
          }
        }
      }
    }
  }
`;

const GATEWAY_PR_REVIEWS_QUERY = `
  query GatewayPullRequestReviews($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewDecision
        reviews(first: 100) {
          nodes {
            state
            submittedAt
            author { login }
          }
        }
      }
    }
  }
`;

function gatewayPrMatchesState(
  state: GitHubPRState,
  filter: "open" | "merged"
): boolean {
  if (filter === "open") {
    return state === GitHubPRState.Open;
  }
  return state === GitHubPRState.Merged;
}

async function fetchGatewayPrComments(
  ghBin: string,
  owner: string,
  repo: string,
  number: number
): Promise<
  | {
      ok: true;
      value: {
        prData: GatewayPrCommentsData | null;
        providerTruncated: boolean;
      };
    }
  | { ok: false; reason: GatewayGhGraphqlFailureReason }
> {
  let issueAfter: string | null = null;
  let reviewsAfter: string | null = null;
  let threadsAfter: string | null = null;
  let prData: GatewayPrCommentsData | null = null;
  const providerTruncated = false;
  let reachedTopLevelPageLimit = true;
  let requestedConnections: GatewayPrCommentsConnectionSelection = {
    comments: true,
    reviews: true,
    reviewThreads: true,
  };

  for (let page = 0; page < maxGatewayCommentPages(); page++) {
    const result:
      | { ok: true; value: GatewayPrCommentsGraphqlResponse }
      | { ok: false; reason: GatewayGhGraphqlFailureReason } =
      await runGhGraphql<GatewayPrCommentsGraphqlResponse>(
        ghBin,
        GATEWAY_PR_COMMENTS_QUERY,
        buildGatewayPrCommentsVariables({
          owner,
          repo,
          number,
          issueAfter,
          reviewsAfter,
          threadsAfter,
        })
      );
    if (!result.ok) {
      return result;
    }
    const current: GatewayPrCommentsData | null =
      result.value.repository?.pullRequest ?? null;
    if (!current) {
      return { ok: true, value: { prData: null, providerTruncated: false } };
    }
    prData = mergeGatewayPrCommentsData(prData, current, requestedConnections);

    const nextIssueAfter: string | null = requestedConnections.comments
      ? nextGatewayCursor(current.comments?.pageInfo)
      : null;
    const nextReviewsAfter: string | null = requestedConnections.reviews
      ? nextGatewayCursor(current.reviews?.pageInfo)
      : null;
    const nextThreadsAfter: string | null = requestedConnections.reviewThreads
      ? nextGatewayCursor(current.reviewThreads?.pageInfo)
      : null;
    if (!(nextIssueAfter || nextReviewsAfter || nextThreadsAfter)) {
      reachedTopLevelPageLimit = false;
      break;
    }
    if (countGatewayPrCommentNodes(prData) >= PR_COMMENTS_MAX_COMMENTS) {
      break;
    }
    issueAfter = nextIssueAfter ?? issueAfter;
    reviewsAfter = nextReviewsAfter ?? reviewsAfter;
    threadsAfter = nextThreadsAfter ?? threadsAfter;
    requestedConnections = {
      comments: nextIssueAfter !== null,
      reviews: nextReviewsAfter !== null,
      reviewThreads: nextThreadsAfter !== null,
    };
  }

  if (!prData) {
    return { ok: true, value: { prData, providerTruncated: false } };
  }

  const nestedResult = await fetchNestedGatewayPrCommentPages(ghBin, prData);
  if (!nestedResult.ok) {
    return nestedResult;
  }

  return {
    ok: true,
    value: {
      prData,
      providerTruncated:
        providerTruncated ||
        reachedTopLevelPageLimit ||
        nestedResult.value.providerTruncated,
    },
  };
}

function mergeGatewayPrCommentsData(
  previous: GatewayPrCommentsData | null,
  current: GatewayPrCommentsData,
  requestedConnections: GatewayPrCommentsConnectionSelection
): GatewayPrCommentsData {
  if (!previous) {
    return current;
  }
  return {
    ...previous,
    comments: requestedConnections.comments
      ? mergeGatewayTopLevelCommentConnection(
          previous.comments,
          current.comments
        )
      : previous.comments,
    reviews: requestedConnections.reviews
      ? mergeGatewayTopLevelReviewConnection(previous.reviews, current.reviews)
      : previous.reviews,
    reviewThreads: requestedConnections.reviewThreads
      ? mergeGatewayTopLevelReviewThreadConnection(
          previous.reviewThreads,
          current.reviewThreads
        )
      : previous.reviewThreads,
  };
}

function mergeGatewayTopLevelCommentConnection(
  previous: GatewayPrCommentsData["comments"],
  current: GatewayPrCommentsData["comments"]
): NonNullable<GatewayPrCommentsData["comments"]> {
  return {
    ...current,
    nodes: [...(previous?.nodes ?? []), ...(current?.nodes ?? [])],
  };
}

function mergeGatewayTopLevelReviewConnection(
  previous: GatewayPrCommentsData["reviews"],
  current: GatewayPrCommentsData["reviews"]
): NonNullable<GatewayPrCommentsData["reviews"]> {
  return {
    ...current,
    nodes: [...(previous?.nodes ?? []), ...(current?.nodes ?? [])],
  };
}

function mergeGatewayTopLevelReviewThreadConnection(
  previous: GatewayPrCommentsData["reviewThreads"],
  current: GatewayPrCommentsData["reviewThreads"]
): NonNullable<GatewayPrCommentsData["reviewThreads"]> {
  return {
    ...current,
    nodes: [...(previous?.nodes ?? []), ...(current?.nodes ?? [])],
  };
}

function nextGatewayCursor(pageInfo: GatewayPageInfo | null | undefined) {
  return pageInfo?.hasNextPage && pageInfo.endCursor
    ? pageInfo.endCursor
    : null;
}

function maxGatewayCommentPages(): number {
  return Math.ceil((PR_COMMENTS_MAX_COMMENTS + 1) / PR_COMMENTS_PAGE_SIZE);
}

function buildGatewayPrCommentsVariables({
  owner,
  repo,
  number,
  issueAfter,
  reviewsAfter,
  threadsAfter,
}: {
  owner: string;
  repo: string;
  number: number;
  issueAfter: string | null;
  reviewsAfter: string | null;
  threadsAfter: string | null;
}): Record<string, unknown> {
  const variables: Record<string, unknown> = {
    owner,
    repo,
    number,
    pageSize: PR_COMMENTS_PAGE_SIZE,
  };
  if (issueAfter) {
    variables.issueAfter = issueAfter;
  }
  if (reviewsAfter) {
    variables.reviewsAfter = reviewsAfter;
  }
  if (threadsAfter) {
    variables.threadsAfter = threadsAfter;
  }
  return variables;
}

async function fetchNestedGatewayPrCommentPages(
  ghBin: string,
  data: GatewayPrCommentsData
): Promise<
  | { ok: true; value: { providerTruncated: boolean } }
  | { ok: false; reason: GatewayGhGraphqlFailureReason }
> {
  let providerTruncated = false;

  for (const review of data.reviews?.nodes ?? []) {
    const result = await fetchNestedGatewayPrCommentConnectionPages(
      ghBin,
      GATEWAY_PR_REVIEW_COMMENTS_QUERY,
      review.id,
      review.comments ?? null,
      data
    );
    if (!result.ok) {
      return result;
    }
    if (result.value.providerTruncated) {
      providerTruncated = true;
    }
    review.comments = result.value.connection;
  }

  for (const thread of data.reviewThreads?.nodes ?? []) {
    const result = await fetchNestedGatewayPrCommentConnectionPages(
      ghBin,
      GATEWAY_PR_REVIEW_THREAD_COMMENTS_QUERY,
      thread.id,
      thread.comments ?? null,
      data
    );
    if (!result.ok) {
      return result;
    }
    if (result.value.providerTruncated) {
      providerTruncated = true;
    }
    thread.comments = result.value.connection;
  }

  return { ok: true, value: { providerTruncated } };
}

async function fetchNestedGatewayPrCommentConnectionPages(
  ghBin: string,
  query: string,
  nodeId: string,
  connection: GatewayPrCommentConnection | null,
  prData: GatewayPrCommentsData
): Promise<
  | {
      ok: true;
      value: {
        providerTruncated: boolean;
        connection: GatewayPrCommentConnection | null;
      };
    }
  | { ok: false; reason: GatewayGhGraphqlFailureReason }
> {
  let currentConnection = connection;
  let commentsAfter = nextGatewayCursor(currentConnection?.pageInfo);
  let shouldFetchFirstPage = !currentConnection;
  let providerTruncated = false;

  for (
    let page = 0;
    (shouldFetchFirstPage || commentsAfter) && page < maxGatewayCommentPages();
    page += 1
  ) {
    if (countGatewayPrCommentNodes(prData) >= PR_COMMENTS_MAX_COMMENTS) {
      providerTruncated = true;
      break;
    }

    const result = await runGhGraphql<GatewayNestedPrCommentsGraphqlResponse>(
      ghBin,
      query,
      buildGatewayNestedPrCommentsVariables(nodeId, commentsAfter)
    );
    if (!result.ok) {
      return result;
    }

    const nextConnection = result.value.node?.comments ?? null;
    if (!nextConnection) {
      providerTruncated = true;
      break;
    }

    currentConnection = mergeGatewayCommentConnection(
      currentConnection,
      nextConnection
    );
    shouldFetchFirstPage = false;
    commentsAfter = nextGatewayCursor(nextConnection.pageInfo);
  }

  if (commentsAfter) {
    providerTruncated = true;
  }

  return {
    ok: true,
    value: { providerTruncated, connection: currentConnection },
  };
}

function buildGatewayNestedPrCommentsVariables(
  nodeId: string,
  commentsAfter: string | null
): Record<string, unknown> {
  const variables: Record<string, unknown> = {
    id: nodeId,
    pageSize: PR_COMMENTS_PAGE_SIZE,
  };
  if (commentsAfter) {
    variables.commentsAfter = commentsAfter;
  }
  return variables;
}

function mergeGatewayCommentConnection(
  target: GatewayPrCommentConnection | null,
  current: GatewayPrCommentConnection
): GatewayPrCommentConnection {
  if (!target) {
    return {
      ...current,
      nodes: [...(current.nodes ?? [])],
    };
  }
  target.nodes = [...(target.nodes ?? []), ...(current.nodes ?? [])];
  target.pageInfo = current.pageInfo ?? target.pageInfo;
  return target;
}

function countGatewayPrCommentNodes(data: GatewayPrCommentsData): number {
  const seenIds = new Set<string>();
  let count = 0;
  for (const row of data.comments?.nodes ?? []) {
    if (seenIds.has(row.id)) {
      continue;
    }
    seenIds.add(row.id);
    count += 1;
  }
  for (const review of data.reviews?.nodes ?? []) {
    if (review.body?.trim() && !seenIds.has(review.id)) {
      seenIds.add(review.id);
      count += 1;
    }
    for (const row of review.comments?.nodes ?? []) {
      if (seenIds.has(row.id)) {
        continue;
      }
      seenIds.add(row.id);
      count += 1;
    }
  }
  for (const thread of data.reviewThreads?.nodes ?? []) {
    for (const row of thread.comments?.nodes ?? []) {
      if (seenIds.has(row.id)) {
        continue;
      }
      seenIds.add(row.id);
      count += 1;
    }
  }
  return count;
}

function appendGatewayReviewThreadComments(
  comments: BranchPrComment[],
  seenIds: Set<string>,
  threads: NonNullable<
    NonNullable<
      NonNullable<GatewayPrCommentsGraphqlResponse["repository"]>["pullRequest"]
    >["reviewThreads"]
  >["nodes"]
): void {
  for (const thread of threads ?? []) {
    for (const row of thread.comments?.nodes ?? []) {
      appendGatewayReviewComment(comments, seenIds, row);
    }
  }
}

function appendGatewayReviewComment(
  comments: BranchPrComment[],
  seenIds: Set<string>,
  row: GatewayPrCommentNode
): void {
  appendGatewayComment(comments, seenIds, row, {
    kind: row.replyTo?.databaseId
      ? BranchPrCommentKind.ReviewReply
      : BranchPrCommentKind.Review,
    threadId: null,
    inReplyToId:
      row.replyTo?.databaseId === null || row.replyTo?.databaseId === undefined
        ? null
        : String(row.replyTo.databaseId),
  });
}

function appendGatewayReviewBody(
  comments: BranchPrComment[],
  seenIds: Set<string>,
  review: {
    id: string;
    author?: { login?: string | null } | null;
    body?: string | null;
    createdAt: string;
  }
): void {
  appendGatewayComment(
    comments,
    seenIds,
    {
      id: review.id,
      databaseId: 0,
      author: review.author,
      body: review.body ?? "",
      createdAt: review.createdAt,
      url: "",
    },
    {
      kind: BranchPrCommentKind.Review,
      threadId: null,
      inReplyToId: null,
    }
  );
}

function appendGatewayComment(
  comments: BranchPrComment[],
  seenIds: Set<string>,
  row: GatewayPrCommentNode,
  options: {
    kind: BranchPrCommentKind;
    threadId: string | null;
    inReplyToId: string | null;
  }
): void {
  if (seenIds.has(row.id)) {
    return;
  }
  const trimmed = trimBranchPrCommentBody(row.body);
  comments.push({
    id: row.id,
    providerNodeId: row.id,
    providerCommentId: row.databaseId ? String(row.databaseId) : null,
    kind: options.kind,
    threadId: options.threadId,
    inReplyToId: options.inReplyToId,
    path: row.path ?? null,
    line: row.originalLine ?? row.line ?? null,
    resolved: null,
    author: {
      login: row.author?.login ?? "unknown",
      displayName: null,
      avatarUrl: null,
      profileUrl: null,
    },
    body: trimmed.body,
    createdAt: row.createdAt,
    updatedAt: null,
    providerUrl: row.url || null,
    stale: false,
    bodyTruncated: trimmed.truncated,
  });
  seenIds.add(row.id);
}

function buildGatewayPrCommentsResponse(
  branchId: string,
  prNumber: number,
  prUrl: string | null,
  comments: BranchPrComment[],
  options: {
    providerTruncated?: boolean;
    state?: BranchCommentsState;
    providerProofedAt?: string | null;
  } = {}
): BranchPrCommentsResponse {
  const sliced = comments.slice(0, PR_COMMENTS_MAX_COMMENTS);
  const providerTruncated =
    options.providerTruncated === true ||
    comments.length > PR_COMMENTS_MAX_COMMENTS;
  const response: BranchPrCommentsResponse = {
    branchId,
    state:
      options.state ?? gatewayCommentsState(comments.length, providerTruncated),
    comments: sliced,
    budget: {
      maxComments: PR_COMMENTS_MAX_COMMENTS,
      pageSize: PR_COMMENTS_PAGE_SIZE,
      maxBodyBytes: PR_COMMENTS_MAX_BODY_BYTES,
      maxResponseBytes: PR_COMMENTS_MAX_RESPONSE_BYTES,
      providerTruncated,
      responseTruncated: false,
      omittedComments:
        Math.max(0, comments.length - sliced.length) +
        (providerTruncated && comments.length <= PR_COMMENTS_MAX_COMMENTS
          ? 1
          : 0),
      bodyTruncatedCount: sliced.filter((comment) => comment.bodyTruncated)
        .length,
    },
    providerProofedAt:
      "providerProofedAt" in options
        ? (options.providerProofedAt ?? null)
        : new Date().toISOString(),
    stale: false,
    mixedProjection: false,
    prNumber,
    prUrl,
  };
  return fitBranchPrCommentsResponseBudget(response);
}

function gatewayCommentsState(
  commentCount: number,
  providerTruncated: boolean
): BranchCommentsState {
  if (providerTruncated || commentCount > PR_COMMENTS_MAX_COMMENTS) {
    return BranchCommentsState.OverLimitTruncated;
  }
  if (commentCount > 0) {
    return BranchCommentsState.Populated;
  }
  return BranchCommentsState.SyncedEmpty;
}

function formatGhGraphqlError(reason: GatewayGhGraphqlFailureReason): string {
  switch (reason) {
    case "auth_required":
      return "GitHub CLI not authenticated. Run 'gh auth login' in terminal.";
    case "rate_limited":
      return "GitHub rate limit reached. Try again later.";
    case "secondary_limited":
      return "GitHub secondary rate limit reached. Try again later.";
    case "timeout":
      return "GitHub request timed out. Try again.";
    case "invalid_response":
      return "GitHub returned an invalid response.";
    case "gh_unavailable":
      return "GitHub CLI unavailable. Ensure gh is installed and authenticated.";
    default:
      return "GitHub CLI unavailable. Ensure gh is installed and authenticated.";
  }
}

function mapGhGraphqlFailureToBranchCommentsReason(
  reason: GatewayGhGraphqlFailureReason
): BranchCommentsFailureReason {
  if (reason === "auth_required") {
    return BranchCommentsFailureReason.Auth;
  }
  if (reason === "rate_limited") {
    return BranchCommentsFailureReason.RateLimit;
  }
  if (reason === "secondary_limited") {
    return BranchCommentsFailureReason.SecondaryLimit;
  }
  if (reason === "timeout") {
    return BranchCommentsFailureReason.Timeout;
  }
  return BranchCommentsFailureReason.ProviderUnavailable;
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

type GatewayPrCommentsRequest =
  | {
      ok: true;
      branchId: string;
      owner: string;
      repo: string;
      prNumber: number;
    }
  | {
      ok: false;
      status: number;
      error: {
        error: string;
        reason?: BranchCommentsFailureReason;
      };
    };

async function resolveGatewayPrCommentsRequest(
  context: OperationRequestContext,
  getAllowedDirectories: () => string[],
  resolveBranchPrIdentity?: BranchPrIdentityResolver
): Promise<GatewayPrCommentsRequest> {
  const owner = context.query.get("owner");
  const repoName = context.query.get("repo");
  const prNumber = context.query.get("number");
  const branchId = context.query.get("branchId");

  if (owner || prNumber || branchId) {
    return resolveScopedGatewayPrCommentsRequest(
      owner,
      repoName,
      prNumber,
      branchId,
      resolveBranchPrIdentity
    );
  }

  return resolveLegacyGatewayPrCommentsRequest(context, getAllowedDirectories);
}

async function resolveScopedGatewayPrCommentsRequest(
  owner: string | null,
  repoName: string | null,
  prNumber: string | null,
  branchId: string | null,
  resolveBranchPrIdentity?: BranchPrIdentityResolver
): Promise<GatewayPrCommentsRequest> {
  if (!(owner && repoName && prNumber && branchId)) {
    return {
      ok: false,
      status: 400,
      error: { error: "owner, repo, number, and branchId are required" },
    };
  }
  if (!isValidPrIdentityRequestShape(owner, repoName, prNumber)) {
    return {
      ok: false,
      status: 400,
      error: { error: "Invalid owner, repo, or number" },
    };
  }
  if (!branchIdMatchesRepo(branchId, owner, repoName)) {
    return {
      ok: false,
      status: 403,
      error: branchPrCommentsForbiddenMismatchError(),
    };
  }
  const branchPrIdentity = await resolveBranchPrIdentity?.(branchId);
  if (
    !branchPrIdentityMatchesRequest(
      branchPrIdentity ?? null,
      owner,
      repoName,
      prNumber
    )
  ) {
    return {
      ok: false,
      status: 403,
      error: branchPrCommentsForbiddenMismatchError(),
    };
  }

  return {
    ok: true,
    branchId,
    owner,
    repo: repoName,
    prNumber: Number.parseInt(prNumber, 10),
  };
}

async function resolveLegacyGatewayPrCommentsRequest(
  context: OperationRequestContext,
  getAllowedDirectories: () => string[]
): Promise<GatewayPrCommentsRequest> {
  const repoPath = context.query.get("repo");
  const prNumber = context.query.get("pr");
  if (!(repoPath && prNumber)) {
    return {
      ok: false,
      status: 400,
      error: { error: "owner, repo, number, and branchId are required" },
    };
  }
  if (!DIGITS_ONLY.test(prNumber)) {
    return {
      ok: false,
      status: 400,
      error: { error: "Invalid repo or pr" },
    };
  }

  let cwd: string;
  try {
    cwd = assertRepoAllowed(repoPath, getAllowedDirectories());
  } catch (error) {
    if (error instanceof DirectoryNotAllowedError) {
      return {
        ok: false,
        status: 403,
        error: { error: "directory not allowed" },
      };
    }
    throw error;
  }

  const repoSlug = await getRepoSlug(cwd);
  const [owner, repo] = repoSlug.split("/");
  if (!(owner && repo)) {
    return {
      ok: false,
      status: 500,
      error: { error: "Repository not found or no access." },
    };
  }

  const branchName = await getCurrentBranchName(cwd);
  return {
    ok: true,
    branchId: encodeBranchId({
      repoFullName: repoSlug,
      branchName: branchName ?? `pr-${prNumber}`,
    }),
    owner,
    repo,
    prNumber: Number.parseInt(prNumber, 10),
  };
}

function branchPrCommentsForbiddenMismatchError(): {
  error: string;
  reason: BranchCommentsFailureReason;
} {
  return {
    error: "branch scope does not match pull request",
    reason: BranchCommentsFailureReason.ForbiddenMismatch,
  };
}

async function getCurrentBranchName(cwd: string): Promise<string | null> {
  try {
    const branchName = await runRead(cwd, getResolvedGitPath(), [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    return branchName.trim() || null;
  } catch {
    return null;
  }
}

function branchPrIdentityMatchesRequest(
  identity: BranchPrIdentity | null,
  owner: string,
  repo: string,
  prNumber: string
): boolean {
  const expected = resolveBranchPrIdentityParts(identity);
  return (
    expected !== null &&
    expected.owner === owner &&
    expected.repo === repo &&
    expected.prNumber === Number.parseInt(prNumber, 10)
  );
}

function resolveBranchPrIdentityParts(
  identity: BranchPrIdentity | null
): { owner: string; repo: string; prNumber: number } | null {
  if (!identity) {
    return null;
  }
  if (identity.repoFullName && identity.prNumber != null) {
    const parts = identity.repoFullName.split("/");
    if (parts.length === 2) {
      const [owner, repo] = parts;
      if (!(owner && repo)) {
        return null;
      }
      return {
        owner,
        repo,
        prNumber: identity.prNumber,
      };
    }
  }
  return parseGithubPrUrl(identity.prUrl);
}

function parseGithubPrUrl(
  prUrl: string | null
): { owner: string; repo: string; prNumber: number } | null {
  if (!prUrl) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull") {
    return null;
  }
  const [owner, repo, , prNumberPart] = parts;
  if (!(owner && repo && prNumberPart && DIGITS_ONLY.test(prNumberPart))) {
    return null;
  }
  const prNumber = Number.parseInt(prNumberPart, 10);
  if (!Number.isSafeInteger(prNumber)) {
    return null;
  }
  return { owner, repo, prNumber };
}

function isValidPrFileDiffRequestShape(
  owner: string,
  repo: string,
  prNumber: string,
  filePath: string,
  previousPath: string | undefined
): boolean {
  return (
    SAFE_SLUG_SEGMENT.test(owner) &&
    SAFE_SLUG_SEGMENT.test(repo) &&
    DIGITS_ONLY.test(prNumber) &&
    isSafePrFilePath(filePath) &&
    (previousPath === undefined || isSafePrFilePath(previousPath))
  );
}

function isValidPrIdentityRequestShape(
  owner: string,
  repo: string,
  prNumber: string
): boolean {
  return (
    SAFE_SLUG_SEGMENT.test(owner) &&
    SAFE_SLUG_SEGMENT.test(repo) &&
    DIGITS_ONLY.test(prNumber)
  );
}
