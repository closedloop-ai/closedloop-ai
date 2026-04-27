/**
 * Shared fixture builders for GitHub webhook payloads used in unit tests.
 *
 * Each builder returns a fully-populated object cast to `any` so callers can
 * pass the result anywhere the matching `@octokit/webhooks-types` shape is
 * expected. Pass a partial to override any field; the rest fall back to
 * defaults that satisfy the webhook type's required fields.
 */

type UserOverrides = Partial<{
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
}>;

export function createUser(overrides: UserOverrides = {}) {
  const id = overrides.id ?? 1;
  return {
    login: overrides.login ?? "test-user",
    id,
    node_id: overrides.node_id ?? `U_${id}`,
    avatar_url: overrides.avatar_url ?? "",
    gravatar_id: "",
    url: "",
    html_url: "",
    followers_url: "",
    following_url: "",
    gists_url: "",
    starred_url: "",
    subscriptions_url: "",
    organizations_url: "",
    repos_url: "",
    events_url: "",
    received_events_url: "",
    type: "User" as const,
    site_admin: false,
  };
}

export function createSender(overrides: UserOverrides = {}) {
  return createUser(overrides);
}

export function createRepository(githubId: number) {
  return {
    id: githubId,
    node_id: `R_${githubId}`,
    name: "test-repo",
    full_name: "owner/test-repo",
    private: false,
    owner: createUser({ login: "owner", id: 12_345 }),
    html_url: "",
    description: null,
    fork: false,
    url: "",
  };
}

type PullRequestOverrides = Partial<{
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  merged: boolean;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  html_url: string;
  head: { sha: string; ref?: string };
}>;

export function createPullRequest(overrides: PullRequestOverrides = {}) {
  return {
    id: overrides.id ?? 1,
    node_id: "PR_1",
    number: overrides.number ?? 1,
    title: overrides.title ?? "Test PR",
    body: overrides.body ?? null,
    user: createUser(),
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
    merged: overrides.merged ?? false,
    closed_at: overrides.closed_at ?? null,
    merged_at: overrides.merged_at ?? null,
    merge_commit_sha: overrides.merge_commit_sha ?? null,
    head: { sha: "abc123", ref: "feature-branch", ...overrides.head },
    base: { ref: "main" },
    url: "",
    html_url: overrides.html_url ?? "https://github.com/owner/test-repo/pull/1",
    diff_url: "",
    patch_url: "",
    issue_url: "",
    commits_url: "",
    review_comments_url: "",
    review_comment_url: "",
    comments_url: "",
    statuses_url: "",
    created_at: "2026-02-10T00:00:00Z",
    updated_at: "2026-02-10T00:00:00Z",
  } as any;
}

type ReviewOverrides = {
  id: number;
  state: string;
  body?: string;
  user?: { login: string; id: number };
};

export function createReview(partial: ReviewOverrides) {
  return {
    id: partial.id,
    node_id: `PRR_${partial.id}`,
    user: partial.user ?? createUser({ login: "reviewer", id: 999 }),
    body: partial.body ?? "Review comment",
    state: partial.state,
    html_url: `https://github.com/owner/test-repo/pull/1#pullrequestreview-${partial.id}`,
    submitted_at: "2026-02-10T12:00:00Z",
    commit_id: "abc123",
    author_association: "MEMBER" as const,
  } as any;
}

type ReviewCommentOverrides = {
  id: number;
  body: string;
  path?: string;
  line?: number;
  pull_request_review_id?: number;
};

export function createReviewComment(partial: ReviewCommentOverrides) {
  return {
    id: partial.id,
    node_id: `PRRC_${partial.id}`,
    diff_hunk: "@@ -1,1 +1,1 @@",
    path: partial.path ?? "src/file.ts",
    line: partial.line ?? 42,
    body: partial.body,
    pull_request_review_id: partial.pull_request_review_id ?? null,
    user: createUser({
      login: "reviewer",
      id: 99_999,
      avatar_url: "https://example.com/avatar.png",
    }),
    created_at: "2026-02-10T12:00:00Z",
    updated_at: "2026-02-10T12:00:00Z",
    html_url: `https://github.com/owner/test-repo/pull/1#discussion_r${partial.id}`,
    pull_request_url: "",
    author_association: "CONTRIBUTOR" as const,
    url: "",
    _links: {
      self: { href: "" },
      html: { href: "" },
      pull_request: { href: "" },
    },
  } as any;
}
