import { LoopCommand } from "./commands";

/**
 * Whether peer worktrees mounted alongside the primary repo can be written to
 * by the agent. Read-only is enforced at the commit/push/PR layer (the runtime
 * never invokes commit-and-push against read-only peers). Filesystem-level
 * writes inside an agent worktree are scratch and discarded on cleanup.
 */
export const PeerWriteMode = {
  ReadOnly: "read-only",
  ReadWrite: "read-write",
} as const;
export type PeerWriteMode = (typeof PeerWriteMode)[keyof typeof PeerWriteMode];

/**
 * Whether peer worktrees can reuse a previously cloned/checked-out copy
 * (`reuse-stale`) or must be re-provisioned each loop run (`always-fresh`).
 *
 * Currently consumed only by the desktop gateway (`closedloop-electron`),
 * where peer worktrees persist across loop runs and the freshness contract
 * decides whether to reap a leftover branch on entry. The ECS harness
 * provisions a fresh container per run, so all peers are effectively
 * `always-fresh` regardless of this field — it is informational on that
 * runtime. The value belongs in the shared substrate so both runtimes read
 * the same source of truth and a future ECS retry policy can light up
 * without refactoring the table.
 */
export const WorktreeFreshness = {
  AlwaysFresh: "always-fresh",
  ReuseStale: "reuse-stale",
} as const;
export type WorktreeFreshness =
  (typeof WorktreeFreshness)[keyof typeof WorktreeFreshness];

export type MultiRepoCommandPolicy = {
  supportsAdditionalRepos: boolean;
  peerWriteMode: PeerWriteMode;
  worktreeFreshness: WorktreeFreshness;
};

const NO_PEERS: MultiRepoCommandPolicy = Object.freeze({
  supportsAdditionalRepos: false,
  peerWriteMode: PeerWriteMode.ReadOnly,
  worktreeFreshness: WorktreeFreshness.AlwaysFresh,
});

/**
 * Single source of truth for whether a command receives peer repos at runtime
 * and what its peer-write contract is. Both ECS and Electron consume this
 * table; adding a new multi-repo command is a one-line table edit.
 */
export const MULTI_REPO_POLICY: Readonly<
  Record<LoopCommand, MultiRepoCommandPolicy>
> = Object.freeze({
  [LoopCommand.Plan]: Object.freeze({
    supportsAdditionalRepos: true,
    peerWriteMode: PeerWriteMode.ReadOnly,
    worktreeFreshness: WorktreeFreshness.AlwaysFresh,
  }),
  [LoopCommand.Execute]: Object.freeze({
    supportsAdditionalRepos: true,
    peerWriteMode: PeerWriteMode.ReadWrite,
    worktreeFreshness: WorktreeFreshness.ReuseStale,
  }),
  [LoopCommand.GeneratePrd]: Object.freeze({
    supportsAdditionalRepos: true,
    peerWriteMode: PeerWriteMode.ReadOnly,
    worktreeFreshness: WorktreeFreshness.AlwaysFresh,
  }),
  [LoopCommand.RequestPrdChanges]: Object.freeze({
    supportsAdditionalRepos: true,
    peerWriteMode: PeerWriteMode.ReadOnly,
    worktreeFreshness: WorktreeFreshness.AlwaysFresh,
  }),
  [LoopCommand.RequestChanges]: NO_PEERS,
  [LoopCommand.Chat]: NO_PEERS,
  [LoopCommand.Explore]: NO_PEERS,
  [LoopCommand.Decompose]: NO_PEERS,
  [LoopCommand.EvaluatePrd]: NO_PEERS,
  [LoopCommand.EvaluatePlan]: NO_PEERS,
  [LoopCommand.EvaluateCode]: NO_PEERS,
  [LoopCommand.EvaluateFeature]: NO_PEERS,
  [LoopCommand.Bootstrap]: NO_PEERS,
  [LoopCommand.Manual]: NO_PEERS,
});

export function getMultiRepoPolicy(command: string): MultiRepoCommandPolicy {
  return MULTI_REPO_POLICY[command as LoopCommand] ?? NO_PEERS;
}
