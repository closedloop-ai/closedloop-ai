/** Suppressed keys for one served URL template. */
export type EndpointStringOnlyDateKeys = {
  /** URL template mirroring the App Router directory, e.g. `/branches/[id]`. */
  route: string;
  /** Allowlisted keys this endpoint declares only as `string`. */
  keys: readonly string[];
};

/**
 * Derived from the payload types the `apps/api` routes declare they serialize,
 * and maintained BY HAND against that derivation — there is no generator.
 * `endpoint-date-revival-covered.test.ts` recomputes the table from the route
 * sources and fails on any difference, printing the expected array; reconcile
 * this list to what it prints rather than to what a change felt like it needed.
 *
 * An entry with NO keys is a SHADOW. A request path is matched segment by
 * segment, so a dynamic entry such as `/agent-sessions/[id]` would otherwise
 * also capture its literal siblings (`/agent-sessions/usage`) and suppress keys
 * on a route whose payload was never examined for them. Listing those siblings
 * with an empty key set makes them win the match instead — the same
 * literal-over-dynamic precedence the App Router applies.
 */
export const ENDPOINT_STRING_ONLY_DATE_KEYS: readonly EndpointStringOnlyDateKeys[] =
  [
    {
      keys: ["lastSeenAt"],
      route: "/agent-components",
    },
    {
      keys: ["closedAt", "createdAt", "dueDate", "mergedAt"],
      route: "/agent-components/[slug]",
    },
    {
      keys: ["lastSeenAt"],
      route: "/agent-components/[slug]/invocations",
    },
    {
      keys: ["createdAt", "dueDate"],
      route: "/agent-components/[slug]/sessions",
    },
    {
      keys: [],
      route: "/agent-components/compliance",
    },
    {
      keys: [],
      route: "/agent-components/pack/[packId]",
    },
    {
      keys: ["lastSeenAt"],
      route: "/agent-components/page-data",
    },
    {
      keys: [],
      route: "/agent-components/promote",
    },
    {
      keys: [],
      route: "/agent-components/ranking",
    },
    {
      keys: ["lastSeenAt"],
      route: "/agent-components/source-occurrences",
    },
    {
      keys: ["createdAt", "dueDate"],
      route: "/agent-sessions",
    },
    {
      keys: ["createdAt", "dueDate"],
      route: "/agent-sessions/[id]",
    },
    {
      keys: ["createdAt"],
      route: "/agent-sessions/[id]/events",
    },
    {
      // `AgentComponentInvocationReadRow.sourceOccurrence` is a
      // `SourceOccurrence`, whose `lastSeenAt` is an ISO timestamp DECLARED AS
      // `string` — the same contract every `/agent-components*` route above
      // suppresses it under. Without this entry the global allowlist revives it
      // into a `Date` on this route alone, so one payload's `lastSeenAt` would
      // be a different runtime type from every sibling's.
      keys: ["lastSeenAt"],
      route: "/agent-sessions/[id]/invocation-tree",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/agent-sessions/[id]/trace-comments",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/agent-sessions/[id]/trace-comments/[commentId]",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/agent-sessions/[id]/trace-comments/[commentId]/replies",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/agent-sessions/[id]/trace-comments/[commentId]/retry-sync",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/agent-sessions/[id]/trace-comments/[commentId]/sync-abandoned",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/agent-sessions/[id]/trace-comments/by-client-id/[clientId]",
    },
    {
      keys: [],
      route: "/agent-sessions/analytics",
    },
    {
      keys: [],
      route: "/agent-sessions/bulk-assign",
    },
    {
      keys: [],
      route: "/agent-sessions/export",
    },
    {
      keys: [],
      route: "/agent-sessions/status-counts",
    },
    {
      keys: [],
      route: "/agent-sessions/usage",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/artifacts/[id]/comments",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/artifacts/[id]/comments/threads",
    },
    {
      keys: [
        "closedAt",
        "createdAt",
        "lastActivityAt",
        "mergedAt",
        "startedAt",
        "updatedAt",
      ],
      route: "/branches",
    },
    {
      keys: [
        "closedAt",
        "createdAt",
        "dueDate",
        "endedAt",
        "lastActivityAt",
        "mergedAt",
        "startedAt",
        "updatedAt",
      ],
      route: "/branches/[id]",
    },
    {
      keys: ["createdAt", "updatedAt"],
      route: "/branches/[id]/comments",
    },
    {
      keys: [
        "closedAt",
        "createdAt",
        "dueDate",
        "endedAt",
        "lastActivityAt",
        "mergedAt",
        "startedAt",
        "updatedAt",
      ],
      route: "/branches/[id]/refresh",
    },
    {
      keys: [
        "closedAt",
        "createdAt",
        "dueDate",
        "endedAt",
        "lastActivityAt",
        "mergedAt",
        "startedAt",
        "updatedAt",
      ],
      route: "/branches/[id]/selected-pull-request",
    },
    {
      keys: ["createdAt", "startedAt"],
      route: "/branches/[id]/selected-pull-request/checks",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/branches/[id]/trace-comments",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/branches/[id]/trace-comments/[commentId]",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/branches/[id]/trace-comments/[commentId]/replies",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/branches/[id]/trace-comments/[commentId]/retry-sync",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/branches/[id]/trace-comments/[commentId]/sync-abandoned",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/branches/[id]/trace-comments/by-client-id/[clientId]",
    },
    {
      keys: [],
      route: "/branches/analytics",
    },
    {
      keys: [],
      route: "/branches/evaluation-clock",
    },
    {
      keys: [],
      route: "/branches/list-status-ordering",
    },
    {
      keys: [],
      route: "/branches/usage",
    },
    {
      keys: ["createdAt", "updatedAt"],
      route: "/catalog",
    },
    {
      keys: ["createdAt", "updatedAt"],
      route: "/catalog/[id]",
    },
    {
      keys: ["createdAt", "updatedAt"],
      route: "/catalog/confirm",
    },
    {
      keys: [],
      route: "/catalog/upload-intent",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/comments/[commentId]",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/comments/[commentId]/attachments",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/comments/[commentId]/reactions/[emoji]",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/comments/attachments/[attachmentId]",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/comments/attachments/[attachmentId]/complete",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/comments/threads/[threadId]",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/comments/threads/[threadId]/reopen",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/comments/threads/[threadId]/replies",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/comments/threads/[threadId]/resolve",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/comments/threads/[threadId]/retry-sync",
    },
    {
      keys: ["createdAt", "startedAt"],
      route: "/compute-targets/[id]/commands/[commandId]",
    },
    {
      keys: ["createdAt", "updatedAt"],
      route: "/desktop/distributions/assigned",
    },
    {
      keys: ["expiresAt"],
      route: "/desktop/provisioning-attempt",
    },
    {
      keys: ["expiresAt"],
      route: "/desktop/provisioning-attempt/[attemptId]",
    },
    {
      keys: ["createdAt", "updatedAt"],
      route: "/distributions",
    },
    {
      keys: ["createdAt", "updatedAt"],
      route: "/distributions/[id]",
    },
    {
      keys: ["createdAt", "expiresAt"],
      route: "/documents/[id]/attachments",
    },
    {
      keys: [],
      route: "/documents/[id]/attachments/[attachmentId]",
    },
    {
      keys: ["createdAt"],
      route: "/documents/[id]/attachments/images",
    },
    {
      keys: ["expiresAt"],
      route: "/documents/[id]/attachments/resolve",
    },
    {
      keys: [
        "closedAt",
        "createdAt",
        "dueDate",
        "endedAt",
        "lastActivityAt",
        "mergedAt",
        "startedAt",
        "updatedAt",
      ],
      route: "/documents/[id]/sessions",
    },
    {
      keys: [],
      route: "/documents/by-slug/[slug]",
    },
    {
      keys: ["createdAt"],
      route: "/golden-candidates",
    },
    {
      keys: ["checkedAt"],
      route: "/insights/delivery",
    },
    {
      keys: ["checkedAt"],
      route: "/insights/utilization",
    },
    {
      keys: ["createdAt"],
      route: "/integrations/github",
    },
    {
      keys: ["closedAt", "mergedAt", "updatedAt"],
      route: "/integrations/github/repositories/[id]/pull-requests",
    },
    {
      keys: ["createdAt"],
      route: "/judges-analytics/[metricName]",
    },
    {
      keys: [],
      route: "/judges-analytics/artifact-counts",
    },
    {
      keys: [],
      route: "/organizations/[id]",
    },
    {
      keys: ["createdAt", "expiresAt", "updatedAt"],
      route: "/organizations/invitations",
    },
    {
      keys: ["createdAt"],
      route: "/organizations/members",
    },
    {
      keys: ["createdAt"],
      route: "/public-keys",
    },
    {
      keys: ["createdAt", "updatedAt"],
      route: "/settings/grid-preferences",
    },
    {
      keys: ["createdAt", "editedAt", "resolvedAt", "updatedAt"],
      route: "/trace-comments",
    },
  ];
