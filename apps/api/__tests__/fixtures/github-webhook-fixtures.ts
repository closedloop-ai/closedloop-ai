/**
 * Shared fixture builders for GitHub webhook payloads used in unit tests.
 *
 * Every builder returns a complete `@octokit/webhooks-types` value shaped like
 * GitHub's documented example payloads; pass overrides for the fields a test
 * cares about. The event builders check the action-specific refinements the
 * Octokit event types carry (a `closed` event's PR is closed, a `dismissed`
 * review is dismissed, ...) and throw on a fixture that breaks them, so a
 * mis-built fixture fails loudly instead of being cast into shape.
 */

import type {
  InstallationLite,
  PullRequest,
  PullRequestClosedEvent,
  PullRequestConvertedToDraftEvent,
  PullRequestEditedEvent,
  PullRequestOpenedEvent,
  PullRequestReadyForReviewEvent,
  PullRequestReopenedEvent,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestReviewCommentCreatedEvent,
  PullRequestReviewCommentDeletedEvent,
  PullRequestReviewCommentEditedEvent,
  PullRequestReviewDismissedEvent,
  PullRequestReviewEditedEvent,
  PullRequestReviewSubmittedEvent,
  PullRequestSynchronizeEvent,
  Reactions,
  Repository,
  SimplePullRequest,
  User,
} from "@octokit/webhooks-types";
import type { HandledPullRequestEvent } from "@/app/webhooks/github/handlers/pull-request-action-application";

export function createUser(overrides: Partial<User> = {}): User {
  const login = overrides.login ?? "test-user";
  const id = overrides.id ?? 1;
  const apiUrl = `${GITHUB_API_URL}/users/${login}`;
  return {
    login,
    id,
    node_id: `U_${id}`,
    avatar_url: "",
    gravatar_id: "",
    url: apiUrl,
    html_url: `${GITHUB_URL}/${login}`,
    followers_url: `${apiUrl}/followers`,
    following_url: `${apiUrl}/following{/other_user}`,
    gists_url: `${apiUrl}/gists{/gist_id}`,
    starred_url: `${apiUrl}/starred{/owner}{/repo}`,
    subscriptions_url: `${apiUrl}/subscriptions`,
    organizations_url: `${apiUrl}/orgs`,
    repos_url: `${apiUrl}/repos`,
    events_url: `${apiUrl}/events{/privacy}`,
    received_events_url: `${apiUrl}/received_events`,
    type: "User",
    site_admin: false,
    ...overrides,
  };
}

export function createSender(overrides: Partial<User> = {}): User {
  return createUser(overrides);
}

export function createRepository(
  githubId: number,
  overrides: Partial<Repository> = {}
): Repository {
  const fullName = overrides.full_name ?? DEFAULT_REPOSITORY_FULL_NAME;
  const apiUrl = `${GITHUB_API_URL}/repos/${fullName}`;
  return {
    id: githubId,
    node_id: `R_${githubId}`,
    name: fullName.slice(fullName.indexOf("/") + 1),
    full_name: fullName,
    private: false,
    owner: createUser({ login: "owner", id: 12_345 }),
    html_url: `${GITHUB_URL}/${fullName}`,
    description: null,
    fork: false,
    url: apiUrl,
    forks_url: `${apiUrl}/forks`,
    keys_url: `${apiUrl}/keys{/key_id}`,
    collaborators_url: `${apiUrl}/collaborators{/collaborator}`,
    teams_url: `${apiUrl}/teams`,
    hooks_url: `${apiUrl}/hooks`,
    issue_events_url: `${apiUrl}/issues/events{/number}`,
    events_url: `${apiUrl}/events`,
    assignees_url: `${apiUrl}/assignees{/user}`,
    branches_url: `${apiUrl}/branches{/branch}`,
    tags_url: `${apiUrl}/tags`,
    blobs_url: `${apiUrl}/git/blobs{/sha}`,
    git_tags_url: `${apiUrl}/git/tags{/sha}`,
    git_refs_url: `${apiUrl}/git/refs{/sha}`,
    trees_url: `${apiUrl}/git/trees{/sha}`,
    statuses_url: `${apiUrl}/statuses/{sha}`,
    languages_url: `${apiUrl}/languages`,
    stargazers_url: `${apiUrl}/stargazers`,
    contributors_url: `${apiUrl}/contributors`,
    subscribers_url: `${apiUrl}/subscribers`,
    subscription_url: `${apiUrl}/subscription`,
    commits_url: `${apiUrl}/commits{/sha}`,
    git_commits_url: `${apiUrl}/git/commits{/sha}`,
    comments_url: `${apiUrl}/comments{/number}`,
    issue_comment_url: `${apiUrl}/issues/comments{/number}`,
    contents_url: `${apiUrl}/contents/{+path}`,
    compare_url: `${apiUrl}/compare/{base}...{head}`,
    merges_url: `${apiUrl}/merges`,
    archive_url: `${apiUrl}/{archive_format}{/ref}`,
    downloads_url: `${apiUrl}/downloads`,
    issues_url: `${apiUrl}/issues{/number}`,
    pulls_url: `${apiUrl}/pulls{/number}`,
    milestones_url: `${apiUrl}/milestones{/number}`,
    notifications_url: `${apiUrl}/notifications{?since,all,participating}`,
    labels_url: `${apiUrl}/labels{/name}`,
    releases_url: `${apiUrl}/releases{/id}`,
    deployments_url: `${apiUrl}/deployments`,
    created_at: "2026-01-05T09:00:00Z",
    updated_at: "2026-02-09T18:00:00Z",
    pushed_at: "2026-02-10T00:00:00Z",
    git_url: `git://github.com/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    clone_url: `${GITHUB_URL}/${fullName}.git`,
    svn_url: `${GITHUB_URL}/${fullName}`,
    homepage: null,
    size: 128,
    stargazers_count: 0,
    watchers_count: 0,
    language: "TypeScript",
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: 1,
    license: null,
    forks: 0,
    open_issues: 1,
    watchers: 0,
    default_branch: "main",
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: "public",
    custom_properties: {},
    ...overrides,
  };
}

/** The `installation` block GitHub stamps on every GitHub App delivery. */
export function createInstallationLite(
  id = DEFAULT_INSTALLATION_ID
): InstallationLite {
  return {
    id,
    node_id: Buffer.from(`023:IntegrationInstallation${id}`).toString("base64"),
  };
}

export function createReactions(url: string): Reactions {
  return {
    url: `${url}/reactions`,
    total_count: 0,
    "+1": 0,
    "-1": 0,
    laugh: 0,
    hooray: 0,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
  };
}

export type PullRequestOverrides = Partial<
  Omit<PullRequest, "head" | "base">
> & {
  head?: Partial<PullRequest["head"]>;
  base?: Partial<PullRequest["base"]>;
};

export function createPullRequest(
  overrides: PullRequestOverrides = {}
): PullRequest {
  const { head, base, ...fields } = overrides;
  const id = fields.id ?? 1;
  const number = fields.number ?? 1;
  const merged = fields.merged ?? false;
  const apiUrl = `${GITHUB_API_URL}/repos/${DEFAULT_REPOSITORY_FULL_NAME}`;
  const htmlUrl = `${GITHUB_URL}/${DEFAULT_REPOSITORY_FULL_NAME}/pull/${number}`;
  const pullUrl = `${apiUrl}/pulls/${number}`;
  const issueUrl = `${apiUrl}/issues/${number}`;
  const headSha = head?.sha ?? DEFAULT_HEAD_SHA;
  const repoOwner = createUser({ login: "owner", id: 12_345 });
  return {
    url: pullUrl,
    id,
    node_id: `PR_${id}`,
    html_url: htmlUrl,
    diff_url: `${htmlUrl}.diff`,
    patch_url: `${htmlUrl}.patch`,
    issue_url: issueUrl,
    number,
    state: "open",
    locked: false,
    title: "Test PR",
    user: createUser(),
    body: null,
    created_at: "2026-02-10T00:00:00Z",
    updated_at: "2026-02-10T00:00:00Z",
    closed_at: null,
    merged_at: null,
    merge_commit_sha: null,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    commits_url: `${pullUrl}/commits`,
    review_comments_url: `${pullUrl}/comments`,
    review_comment_url: `${apiUrl}/pulls/comments{/number}`,
    comments_url: `${issueUrl}/comments`,
    statuses_url: `${apiUrl}/statuses/${headSha}`,
    head: {
      label: "owner:feature-branch",
      ref: "feature-branch",
      sha: headSha,
      user: repoOwner,
      repo: createRepository(DEFAULT_PULL_REQUEST_REPOSITORY_ID),
      ...head,
    },
    base: {
      label: "owner:main",
      ref: "main",
      sha: DEFAULT_BASE_SHA,
      user: repoOwner,
      repo: createRepository(DEFAULT_PULL_REQUEST_REPOSITORY_ID),
      ...base,
    },
    _links: {
      self: { href: pullUrl },
      html: { href: htmlUrl },
      issue: { href: issueUrl },
      comments: { href: `${issueUrl}/comments` },
      review_comments: { href: `${pullUrl}/comments` },
      review_comment: { href: `${apiUrl}/pulls/comments{/number}` },
      commits: { href: `${pullUrl}/commits` },
      statuses: { href: `${apiUrl}/statuses/${headSha}` },
    },
    author_association: "MEMBER",
    auto_merge: null,
    active_lock_reason: null,
    draft: false,
    merged,
    mergeable: null,
    rebaseable: null,
    mergeable_state: "unknown",
    merged_by: merged ? createUser({ login: "merger", id: 2 }) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 12,
    deletions: 3,
    changed_files: 2,
    ...fields,
  };
}

export type ReviewOverrides = Partial<PullRequestReview> &
  Pick<PullRequestReview, "id" | "state">;

export function createReview(overrides: ReviewOverrides): PullRequestReview {
  const htmlUrl = `${GITHUB_URL}/${DEFAULT_REPOSITORY_FULL_NAME}/pull/1#pullrequestreview-${overrides.id}`;
  const pullRequestUrl = `${GITHUB_API_URL}/repos/${DEFAULT_REPOSITORY_FULL_NAME}/pulls/1`;
  return {
    node_id: `PRR_${overrides.id}`,
    user: createUser({ login: "reviewer", id: 999 }),
    body: "Review comment",
    commit_id: DEFAULT_HEAD_SHA,
    submitted_at: "2026-02-10T12:00:00Z",
    html_url: htmlUrl,
    pull_request_url: pullRequestUrl,
    author_association: "MEMBER",
    _links: {
      html: { href: htmlUrl },
      pull_request: { href: pullRequestUrl },
    },
    ...overrides,
  };
}

export type ReviewCommentOverrides = Partial<PullRequestReviewComment> &
  Pick<PullRequestReviewComment, "id" | "body">;

export function createReviewComment(
  overrides: ReviewCommentOverrides
): PullRequestReviewComment {
  const line = overrides.line ?? 42;
  const apiUrl = `${GITHUB_API_URL}/repos/${DEFAULT_REPOSITORY_FULL_NAME}/pulls/comments/${overrides.id}`;
  const htmlUrl = `${GITHUB_URL}/${DEFAULT_REPOSITORY_FULL_NAME}/pull/1#discussion_r${overrides.id}`;
  const pullRequestUrl = `${GITHUB_API_URL}/repos/${DEFAULT_REPOSITORY_FULL_NAME}/pulls/1`;
  return {
    url: apiUrl,
    pull_request_review_id: DEFAULT_REVIEW_ID,
    node_id: `PRRC_${overrides.id}`,
    diff_hunk: "@@ -1,1 +1,1 @@",
    path: "src/file.ts",
    position: line,
    original_position: line,
    commit_id: DEFAULT_HEAD_SHA,
    original_commit_id: DEFAULT_HEAD_SHA,
    user: createUser({
      login: "reviewer",
      id: 99_999,
      avatar_url: "https://example.com/avatar.png",
    }),
    created_at: "2026-02-10T12:00:00Z",
    updated_at: "2026-02-10T12:00:00Z",
    html_url: htmlUrl,
    pull_request_url: pullRequestUrl,
    author_association: "CONTRIBUTOR",
    _links: {
      self: { href: apiUrl },
      html: { href: htmlUrl },
      pull_request: { href: pullRequestUrl },
    },
    reactions: createReactions(apiUrl),
    start_line: null,
    original_start_line: null,
    start_side: null,
    line,
    original_line: line,
    side: "RIGHT",
    subject_type: "line",
    ...overrides,
  };
}

/**
 * The parts every delivery shares. `installation: null` omits the block, the
 * shape of a delivery that carries no installation.
 */
export type WebhookEnvelopeOverrides = {
  repository?: Repository;
  sender?: User;
  installation?: InstallationLite | null;
};

export function createPullRequestOpenedEvent(
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {}
): PullRequestOpenedEvent {
  const pr = pullRequest;
  if (
    pr.state !== "open" ||
    pr.closed_at !== null ||
    pr.merged_at !== null ||
    pr.active_lock_reason !== null ||
    pr.merged_by !== null
  ) {
    throw new Error("An opened event needs an open, unmerged pull request");
  }
  return {
    action: "opened",
    number: pr.number,
    pull_request: {
      ...pr,
      state: pr.state,
      closed_at: pr.closed_at,
      merged_at: pr.merged_at,
      active_lock_reason: pr.active_lock_reason,
      merged_by: pr.merged_by,
    },
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestEditedEvent(
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {},
  changes: PullRequestEditedEvent["changes"] = {}
): PullRequestEditedEvent {
  return {
    action: "edited",
    number: pullRequest.number,
    changes,
    pull_request: pullRequest,
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestClosedEvent(
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {}
): PullRequestClosedEvent {
  const pr = pullRequest;
  if (pr.state !== "closed" || pr.closed_at === null || pr.merged === null) {
    throw new Error("A closed event needs a closed pull request");
  }
  return {
    action: "closed",
    number: pr.number,
    pull_request: {
      ...pr,
      state: pr.state,
      closed_at: pr.closed_at,
      merged: pr.merged,
    },
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestReopenedEvent(
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {}
): PullRequestReopenedEvent {
  const pr = pullRequest;
  if (
    pr.state !== "open" ||
    pr.closed_at !== null ||
    pr.merged_at !== null ||
    pr.merged === null ||
    pr.merged_by !== null
  ) {
    throw new Error("A reopened event needs an open, unmerged pull request");
  }
  return {
    action: "reopened",
    number: pr.number,
    pull_request: {
      ...pr,
      state: pr.state,
      closed_at: pr.closed_at,
      merged_at: pr.merged_at,
      merged: pr.merged,
      merged_by: pr.merged_by,
    },
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestSynchronizeEvent(
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {},
  before = DEFAULT_PREVIOUS_HEAD_SHA
): PullRequestSynchronizeEvent {
  return {
    action: "synchronize",
    number: pullRequest.number,
    before,
    after: pullRequest.head.sha,
    pull_request: pullRequest,
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestConvertedToDraftEvent(
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {}
): PullRequestConvertedToDraftEvent {
  const pr = pullRequest;
  if (
    pr.closed_at !== null ||
    pr.merged_at !== null ||
    pr.draft !== true ||
    pr.merged !== false ||
    pr.merged_by !== null
  ) {
    throw new Error(
      "A converted_to_draft event needs an unmerged draft pull request"
    );
  }
  return {
    action: "converted_to_draft",
    number: pr.number,
    pull_request: {
      ...pr,
      closed_at: pr.closed_at,
      merged_at: pr.merged_at,
      draft: pr.draft,
      merged: pr.merged,
      merged_by: pr.merged_by,
    },
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestReadyForReviewEvent(
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {}
): PullRequestReadyForReviewEvent {
  const pr = pullRequest;
  if (
    pr.state !== "open" ||
    pr.closed_at !== null ||
    pr.merged_at !== null ||
    pr.draft !== false ||
    pr.merged === null ||
    pr.merged_by !== null
  ) {
    throw new Error(
      "A ready_for_review event needs an open, unmerged, non-draft pull request"
    );
  }
  return {
    action: "ready_for_review",
    number: pr.number,
    pull_request: {
      ...pr,
      state: pr.state,
      closed_at: pr.closed_at,
      merged_at: pr.merged_at,
      draft: pr.draft,
      merged: pr.merged,
      merged_by: pr.merged_by,
    },
    ...createWebhookEnvelope(envelope),
  };
}

/** A pull request in the state GitHub reports it in for `action`. */
export function createPullRequestForAction(
  action: HandledPullRequestEvent["action"],
  overrides: PullRequestOverrides = {}
): PullRequest {
  switch (action) {
    case "closed":
      return createPullRequest({
        state: "closed",
        closed_at: "2026-02-10T12:00:00Z",
        ...overrides,
      });
    case "converted_to_draft":
      return createPullRequest({ draft: true, ...overrides });
    default:
      return createPullRequest(overrides);
  }
}

/** One handled `pull_request` action, for tests parameterized over actions. */
export function createHandledPullRequestEvent(
  action: HandledPullRequestEvent["action"],
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {}
): HandledPullRequestEvent {
  switch (action) {
    case "opened":
      return createPullRequestOpenedEvent(pullRequest, envelope);
    case "edited":
      return createPullRequestEditedEvent(pullRequest, envelope);
    case "closed":
      return createPullRequestClosedEvent(pullRequest, envelope);
    case "reopened":
      return createPullRequestReopenedEvent(pullRequest, envelope);
    case "synchronize":
      return createPullRequestSynchronizeEvent(pullRequest, envelope);
    case "converted_to_draft":
      return createPullRequestConvertedToDraftEvent(pullRequest, envelope);
    case "ready_for_review":
      return createPullRequestReadyForReviewEvent(pullRequest, envelope);
    default:
      return assertNeverAction(action);
  }
}

export function createPullRequestReviewSubmittedEvent(
  review: PullRequestReview,
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {}
): PullRequestReviewSubmittedEvent {
  return {
    action: "submitted",
    review,
    pull_request: toSimplePullRequest(pullRequest),
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestReviewEditedEvent(
  review: PullRequestReview,
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {},
  changes: PullRequestReviewEditedEvent["changes"] = {}
): PullRequestReviewEditedEvent {
  return {
    action: "edited",
    changes,
    review,
    pull_request: toSimplePullRequest(pullRequest),
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestReviewDismissedEvent(
  review: PullRequestReview,
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {}
): PullRequestReviewDismissedEvent {
  if (review.state !== "dismissed") {
    throw new Error("A dismissed event needs a dismissed review");
  }
  return {
    action: "dismissed",
    review: { ...review, state: review.state },
    pull_request: toSimplePullRequest(pullRequest),
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestReviewCommentCreatedEvent(
  comment: PullRequestReviewComment,
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {}
): PullRequestReviewCommentCreatedEvent {
  return {
    action: "created",
    comment,
    pull_request: toSimplePullRequest(pullRequest),
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestReviewCommentEditedEvent(
  comment: PullRequestReviewComment,
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {},
  changes: PullRequestReviewCommentEditedEvent["changes"] = {}
): PullRequestReviewCommentEditedEvent {
  return {
    action: "edited",
    changes,
    comment,
    pull_request: toSimplePullRequest(pullRequest),
    ...createWebhookEnvelope(envelope),
  };
}

export function createPullRequestReviewCommentDeletedEvent(
  comment: PullRequestReviewComment,
  pullRequest: PullRequest,
  envelope: WebhookEnvelopeOverrides = {}
): PullRequestReviewCommentDeletedEvent {
  return {
    action: "deleted",
    comment,
    pull_request: toSimplePullRequest(pullRequest),
    ...createWebhookEnvelope(envelope),
  };
}

function createWebhookEnvelope(overrides: WebhookEnvelopeOverrides): {
  repository: Repository;
  sender: User;
  installation?: InstallationLite;
} {
  const {
    repository = createRepository(DEFAULT_PULL_REQUEST_REPOSITORY_ID),
    sender = createSender(),
    installation = createInstallationLite(),
  } = overrides;
  return installation
    ? { repository, sender, installation }
    : { repository, sender };
}

/**
 * Review and review-comment deliveries carry the PR without its merge and diff
 * stats, and always with a head repository.
 */
function toSimplePullRequest(pullRequest: PullRequest): SimplePullRequest {
  const headRepo = pullRequest.head.repo;
  if (headRepo === null) {
    throw new Error("A review delivery's pull request needs a head repository");
  }
  return {
    ...pullRequest,
    head: { ...pullRequest.head, repo: headRepo },
  };
}

function assertNeverAction(action: never): never {
  throw new Error(`Unhandled pull_request action: ${String(action)}`);
}

const GITHUB_URL = "https://github.com";
const GITHUB_API_URL = "https://api.github.com";
const DEFAULT_REPOSITORY_FULL_NAME = "owner/test-repo";
const DEFAULT_PULL_REQUEST_REPOSITORY_ID = 789;
const DEFAULT_INSTALLATION_ID = 99;
const DEFAULT_HEAD_SHA = "abc123";
const DEFAULT_BASE_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const DEFAULT_PREVIOUS_HEAD_SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5";
const DEFAULT_REVIEW_ID = 2_000_001;
