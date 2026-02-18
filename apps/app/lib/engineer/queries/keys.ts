/**
 * Centralized query key factory.
 * Every key used by useQuery / invalidateQueries should reference this object
 * so that typos are caught at compile time and keys stay consistent.
 */
export const queryKeys = {
  // Symphony domain
  symphonyStatus: (ticketId: string, repoPath: string | null) =>
    ["symphony-status", ticketId, repoPath] as const,
  symphonyPlan: (ticketId: string, repoPath: string) =>
    ["symphony-plan", ticketId, repoPath] as const,
  symphonyChatHistory: (ticketId: string, repoPath: string) =>
    ["symphony-chat-history", ticketId, repoPath] as const,
  symphonyLogs: (ticketId: string, repoPath: string) =>
    ["symphony-logs", ticketId, repoPath] as const,
  symphonyJudges: (ticketId: string, repoPath: string) =>
    ["symphony-judges", ticketId, repoPath] as const,
  commentChatHistory: (ticketId: string, commentId: string) =>
    ["comment-chat-history", ticketId, commentId] as const,
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
  healthCheck: () => ["health-check"] as const,
};
