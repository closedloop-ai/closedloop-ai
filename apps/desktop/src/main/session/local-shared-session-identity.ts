import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import type { CanonicalAgentSessionListItem } from "@repo/api/src/types/agent-session-list-contract";
import type { DisplayedSessionStatus } from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import { resolveLocalSessionBranch } from "./local-session-pull-requests.js";

const LOCAL_AGENT_SESSION_ORIGIN = "DESKTOP_SYNC" satisfies NonNullable<
  AgentSessionListItem["origin"]
>;

/**
 * Projects the stable identity fields for a Desktop-backed shared session.
 * Raw lifecycle evidence is retained separately from its served display status
 * so version-skewed values can reach the universal status fallback honestly.
 */
export function buildLocalSessionIdentity(
  session: SyncedAgentSession,
  attribution: SyncedAgentSession["attribution"] | null,
  status: DisplayedSessionStatus,
  primaryModel: string | null,
  prs: NonNullable<SyncedAgentSession["prs"]>
): Pick<
  CanonicalAgentSessionListItem,
  | "branch"
  | "cwd"
  | "externalSessionId"
  | "harness"
  | "id"
  | "model"
  | "models"
  | "name"
  | "origin"
  | "primaryModel"
  | "priority"
  | "prs"
  | "rawStatus"
  | "repo"
  | "repositoryFullName"
  | "slug"
  | "status"
  | "worktreePath"
> {
  return {
    id: session.externalSessionId,
    slug: null,
    externalSessionId: session.externalSessionId,
    name: session.name ?? null,
    rawStatus: session.status,
    status,
    // ISS-10332: omitted only for a session built without the column, which
    // must not read as "no priority".
    ...(session.priority === undefined ? {} : { priority: session.priority }),
    origin: LOCAL_AGENT_SESSION_ORIGIN,
    harness: session.harness ?? "unknown",
    cwd: session.cwd ?? null,
    repositoryFullName: attribution?.repositoryFullName ?? null,
    repo: attribution?.repositoryFullName ?? null,
    worktreePath: attribution?.worktreePath ?? null,
    model: primaryModel,
    primaryModel,
    branch: resolveLocalSessionBranch(session),
    prs,
  };
}
