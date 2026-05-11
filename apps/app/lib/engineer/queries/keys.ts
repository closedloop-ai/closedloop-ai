/**
 * Centralized query key factory.
 * Every key used by useQuery / invalidateQueries should reference this object
 * so that typos are caught at compile time and keys stay consistent.
 */
export const HEALTH_CHECK_AUTO_UPDATE_QUERY_SEGMENT =
  "plugin-auto-update" as const;
export const HEALTH_CHECK_NO_AUTO_UPDATE_QUERY_SEGMENT =
  "plugin-no-auto-update" as const;

export const queryKeys = {
  // Symphony domain
  closedloopStatus: (ticketId: string, repoPath: string | null) =>
    ["closedloop-status", ticketId, repoPath] as const,
  closedloopPlan: (ticketId: string, repoPath: string) =>
    ["closedloop-plan", ticketId, repoPath] as const,
  closedloopChatHistory: (
    ticketId: string,
    repoPath: string,
    provider?: string
  ) =>
    ["closedloop-chat-history", ticketId, repoPath, provider ?? null] as const,
  closedloopLogs: (ticketId: string, repoPath: string) =>
    ["closedloop-logs", ticketId, repoPath] as const,
  closedloopJudges: (ticketId: string, repoPath: string) =>
    ["closedloop-judges", ticketId, repoPath] as const,
  commentChatHistory: (ticketId: string, commentId: string, repoPath: string) =>
    ["comment-chat-history", ticketId, commentId, repoPath] as const,
  findingChatHistory: (ticketId: string, findingId: string, repoPath: string) =>
    ["finding-chat-history", ticketId, findingId, repoPath] as const,

  // Git domain
  gitStatus: (repoPath: string) => ["git-status", repoPath] as const,
  gitBranches: (repoPath: string) => ["git-branches", repoPath] as const,
  gitBranchDiff: (repoPath: string) => ["git-branch-diff", repoPath] as const,
  gitDiff: (
    repoPath: string,
    filePath: string | null,
    diffMode: string,
    baseBranch: string | undefined
  ) => ["git-diff", repoPath, filePath, diffMode, baseBranch] as const,
  prReviews: (
    owner: string | undefined,
    repo: string | undefined,
    prNumber: number | undefined
  ) => ["pr-reviews", owner, repo, prNumber] as const,
  prComments: (prNumber: number, repoPath: string) =>
    ["pr-comments", prNumber, repoPath] as const,
  prList: (repoPath: string, state: string) =>
    ["pr-list", repoPath, state] as const,

  // Repos domain
  repos: () => ["repos"] as const,
  repoPath: (repoFullName: string, routingKey: string) =>
    ["repo-path", repoFullName, routingKey] as const,

  // Files domain
  fileSearch: (ticketId: string, repoPath: string, query: string) =>
    ["file-search", ticketId, repoPath, query] as const,
  fileSearchBase: (repoPath: string, query: string) =>
    ["file-search-base", repoPath, query] as const,
  directories: (path: string) => ["directories", path] as const,

  // Tickets domain
  ticketChatHistory: (ticketId: string) =>
    ["ticket-chat-history", ticketId] as const,

  // Terminal domain
  terminalChatHistory: () => ["terminal-chat-history"] as const,

  // Deploy domain
  deployStatus: (ticketId: string, repoPath: string | null) =>
    ["deploy-status", ticketId, repoPath] as const,
  deployHealth: (ticketId: string) => ["deploy-health", ticketId] as const,
  deployExisting: (repoPath: string, worktreePath: string) =>
    ["deploy-existing", repoPath, worktreePath] as const,

  // Health check domain
  healthCheck: (
    targetKey: string,
    expectedMcpUrl: string | null,
    latestVersion?: string | null,
    pluginAutoUpdateEnabled = false
  ) =>
    [
      "health-check",
      targetKey,
      expectedMcpUrl,
      latestVersion ?? null,
      pluginAutoUpdateEnabled
        ? HEALTH_CHECK_AUTO_UPDATE_QUERY_SEGMENT
        : HEALTH_CHECK_NO_AUTO_UPDATE_QUERY_SEGMENT,
    ] as const,

  // Chat session domain
  chatSessionHistory: (chatKey: string) =>
    ["chat-session-history", chatKey] as const,
  chatRunnerToken: (chatKey: string) => ["chat-runner-token", chatKey] as const,
  branchWorktree: (
    repoFullName: string,
    headBranch: string,
    prNumber: number,
    routingKey: string
  ) =>
    [
      "branch-worktree",
      repoFullName,
      headBranch,
      prNumber,
      routingKey,
    ] as const,

  // Work directory domain
  workDirectory: (ticketId: string) => ["work-directory", ticketId] as const,
};
