/**
 * The one installed Desktop agent-runtime seam for every Session Mesh feature.
 *
 * Coordination and Claire consume the same provider-normalized lifecycle fact;
 * a Claire rollout must subscribe here rather than adding a second hook,
 * config mutation, or background bridge. `agentId` is deliberately absent:
 * the receiving Mesh runtime resolves canonical live IDs from the provider's
 * durable event data and never routes by human-authored lane/slot aliases.
 */
export type SessionMeshHookEvent = {
  harness: "claude" | "codex";
  hookType: string;
  data: Record<string, unknown>;
  localToken?: string;
};

export type SessionMeshHookSink = (
  event: SessionMeshHookEvent
) =>
  | undefined
  | SessionMeshHookResult
  | Promise<undefined | SessionMeshHookResult>;

export type SessionMeshHookResult = {
  awaitContext?: boolean;
  commandResult?: unknown;
  additionalContext?: string;
  receipt?: string;
};
