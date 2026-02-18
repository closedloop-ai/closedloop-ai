import { exec } from "node:child_process";
import { promisify } from "node:util";
import { type NextRequest, NextResponse } from "next/server";

const execAsync = promisify(exec);

type GitHubComment = {
  id: string;
  databaseId: number;
  author: {
    login: string;
  };
  body: string;
  createdAt: string;
  url: string;
};

type GitHubReviewComment = {
  id: string;
  databaseId: number;
  author: {
    login: string;
  };
  body: string;
  createdAt: string;
  path: string;
  line?: number;
  url: string;
};

type GitHubReview = {
  id: string;
  author: {
    login: string;
  };
  body: string;
  state: string;
  createdAt: string;
  comments: GitHubReviewComment[];
};

type GitHubPRResponse = {
  number: number;
  url: string;
  comments: GitHubComment[];
  reviews: GitHubReview[];
};

export type PRComment = {
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

export type PRCommentsResponse = {
  comments: PRComment[];
  prNumber: number;
  prUrl: string;
};

function expandPath(repoPath: string): string {
  return repoPath.startsWith("~/")
    ? repoPath.replace("~", process.env.HOME || "")
    : repoPath;
}

async function getRepoNwo(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `gh repo view --json nameWithOwner --jq '.nameWithOwner'`,
      {
        cwd,
      }
    );
    return stdout.trim();
  } catch {
    console.log(
      "[PR Comments API] Could not get repo name, skipping inline comments"
    );
    return "";
  }
}

function collectGraphQLComments(prData: GitHubPRResponse): {
  comments: PRComment[];
  seenIds: Set<string>;
} {
  const comments: PRComment[] = [];
  const seenIds = new Set<string>();

  for (const comment of prData.comments || []) {
    comments.push({
      id: comment.id,
      databaseId: comment.databaseId,
      author: comment.author?.login || "unknown",
      body: comment.body,
      createdAt: comment.createdAt,
      isReview: false,
      url: comment.url,
    });
    seenIds.add(comment.id);
  }

  for (const review of prData.reviews || []) {
    if (review.body?.trim()) {
      comments.push({
        id: review.id,
        databaseId: 0,
        author: review.author?.login || "unknown",
        body: review.body,
        createdAt: review.createdAt,
        isReview: true,
        url: "",
      });
      seenIds.add(review.id);
    }

    for (const rc of review.comments || []) {
      comments.push({
        id: rc.id,
        databaseId: rc.databaseId,
        author: rc.author?.login || "unknown",
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

  return { comments, seenIds };
}

type GitHubInlineCommentRaw = {
  id: number;
  user?: { login: string };
  body: string;
  created_at: string;
  path: string;
  original_line?: number;
  line?: number;
  html_url: string;
  in_reply_to_id?: number;
};

function mapInlineComment(ic: GitHubInlineCommentRaw): PRComment {
  return {
    id: `IC_${ic.id}`,
    databaseId: ic.id,
    author: ic.user?.login || "unknown",
    body: ic.body,
    createdAt: ic.created_at,
    path: ic.path,
    line: ic.original_line || ic.line,
    isReview: true,
    url: ic.html_url,
    inReplyToId: ic.in_reply_to_id || undefined,
  };
}

async function fetchInlineComments(
  repoNwo: string,
  prNumber: string,
  cwd: string,
  seenIds: Set<string>
): Promise<PRComment[]> {
  if (!repoNwo) {
    return [];
  }
  try {
    const { stdout } = await execAsync(
      `gh api repos/${repoNwo}/pulls/${prNumber}/comments --paginate`,
      { cwd }
    );
    const inlineComments = JSON.parse(stdout);
    return inlineComments
      .map(mapInlineComment)
      .filter((c: PRComment) => !seenIds.has(c.id));
  } catch (e) {
    console.log("[PR Comments API] Could not fetch inline review comments:", e);
    return [];
  }
}

const ERROR_MAP: Array<{ match: string; error: string; status: number }> = [
  {
    match: "gh: command not found",
    error: "GitHub CLI (gh) is not installed",
    status: 500,
  },
  {
    match: "not logged in",
    error: "GitHub CLI is not authenticated. Run 'gh auth login'",
    status: 401,
  },
  {
    match: "Could not resolve to a PullRequest",
    error: "PR not found",
    status: 404,
  },
];

function handleGhError(error: unknown, prNumber: string): NextResponse {
  console.error("Error fetching PR comments:", error);
  if (error instanceof Error) {
    const mapped = ERROR_MAP.find((e) => error.message.includes(e.match));
    if (mapped) {
      const msg =
        mapped.status === 404 ? `PR #${prNumber} not found` : mapped.error;
      return NextResponse.json({ error: msg }, { status: mapped.status });
    }
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unknown error" },
    { status: 500 }
  );
}

/**
 * GET /api/git/pr/comments
 * Fetches all comments on a PR (both general comments and review comments)
 *
 * Query params:
 * - repo: Path to the git repository
 * - pr: PR number
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const repoPath = searchParams.get("repo");
  const prNumber = searchParams.get("pr");

  if (!repoPath) {
    return NextResponse.json(
      { error: "Missing 'repo' query parameter" },
      { status: 400 }
    );
  }
  if (!prNumber) {
    return NextResponse.json(
      { error: "Missing 'pr' query parameter" },
      { status: 400 }
    );
  }

  const cwd = expandPath(repoPath);

  try {
    const repoNwo = await getRepoNwo(cwd);

    const { stdout } = await execAsync(
      `gh pr view ${prNumber} --json number,url,comments,reviews`,
      { cwd }
    );
    const prData: GitHubPRResponse = JSON.parse(stdout);

    const { comments, seenIds } = collectGraphQLComments(prData);
    const inlineComments = await fetchInlineComments(
      repoNwo,
      prNumber,
      cwd,
      seenIds
    );
    comments.push(...inlineComments);

    comments.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return NextResponse.json({
      comments,
      prNumber: prData.number,
      prUrl: prData.url,
    } satisfies PRCommentsResponse);
  } catch (error) {
    return handleGhError(error, prNumber);
  }
}
