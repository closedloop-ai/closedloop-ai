import {
  type SessionMeshPresenceInput,
  type SessionMeshWorkspace,
  sessionMeshPresenceValidator,
} from "@repo/api/src/types/session-mesh";
import type { SessionMeshTraceSubjects } from "./session-mesh-artifact-trace.js";
import type { SessionMeshHookEvent } from "./session-mesh-hook-contract.js";

/**
 * The routable identity a session accumulates ACROSS its turns, rather than the
 * one hook event that happens to be in flight.
 *
 * Extracted from `session-mesh-runtime.ts` (which owned `retainPaths`) when the
 * same retention became necessary for symbols, the pull request and artifact ids
 * — operator instruction 2026-10-08, "symbols should come from anything
 * extracted from the session in it's trace" / "branch, PR, artifact". Presence is
 * re-upserted on EVERY hook event and the row is a full overwrite, so anything
 * not carried forward here is dropped the moment a session's next event names
 * nothing: that is why the live roster showed `paths: []` and `symbols: []` for
 * sessions that had been working for hours.
 *
 * Retention is scoped to one runtime lifecycle and one repository. A different
 * `sourceKey` is a different signed-in Desktop, and a different repository is a
 * different checkout; carrying either forward would publish one session's
 * interests under another's identity.
 */
const MAX_RETAINED_PATHS = 200;
const MAX_RETAINED_SYMBOLS = 200;
/** `sessionMeshLineageValidator`'s own bound, applied before it can throw. */
const MAX_RETAINED_ARTIFACTS = 100;

/**
 * What a Mesh-aware session can do with a delivery. Declared here with the rest
 * of the presence record rather than at the call site, so the roster cannot
 * advertise a capability the runtime that built the row does not implement.
 */
const PRESENCE_CAPABILITIES = [
  "poll_inbox",
  "native_delivery",
  "context_reply",
] as const;

function carryForward(
  prior: { presence: SessionMeshPresenceInput; sourceKey: string } | undefined,
  sourceKey: string,
  repository: string
): SessionMeshPresenceInput | undefined {
  if (
    prior?.sourceKey === sourceKey &&
    prior.presence.workspace.repository === repository
  ) {
    return prior.presence;
  }
  return undefined;
}

/**
 * The presence record to publish for one hook event, merging what this event
 * observed into what the session already declared.
 *
 * Paths and symbols UNION and keep the most recent on overflow, so a long
 * session's identity is everything it has touched rather than its last tool
 * call. `pullRequest` is a scalar and therefore supersedes rather than unions —
 * sticky only while the trace names none and the branch is unchanged, so a
 * session that moves from one PR to another is routed by the one it is on now.
 */
export function sessionMeshPresenceFor(input: {
  prior?: { presence: SessionMeshPresenceInput; sourceKey: string };
  sourceKey: string;
  agentId: string;
  sessionId: string;
  branch?: string;
  harness: SessionMeshHookEvent["harness"];
  expiresInSeconds: number;
  workspace: SessionMeshWorkspace;
  trace: SessionMeshTraceSubjects;
}): SessionMeshPresenceInput {
  const { prior, sourceKey, sessionId, branch, workspace, trace } = input;
  const carried = carryForward(prior, sourceKey, workspace.repository);
  // Reset on a branch change, so one mention of a PR does not tag the rest of
  // the session's work after it has moved on.
  const pullRequest =
    trace.pullRequest ??
    (carried?.lineage.branch === branch
      ? carried?.lineage.pullRequest
      : undefined);
  return sessionMeshPresenceValidator.parse({
    agentId: input.agentId,
    harness: input.harness,
    capabilities: PRESENCE_CAPABILITIES,
    expiresInSeconds: input.expiresInSeconds,
    workspace: {
      ...workspace,
      paths: [
        ...new Set([...(carried?.workspace.paths ?? []), ...workspace.paths]),
      ].slice(-MAX_RETAINED_PATHS),
      symbols: [
        ...new Set([
          ...(carried?.workspace.symbols ?? []),
          ...workspace.symbols,
          ...trace.symbols,
        ]),
      ].slice(-MAX_RETAINED_SYMBOLS),
    },
    lineage: {
      sessionId,
      artifactIds: [
        ...new Set([
          ...(carried?.lineage.artifactIds ?? []),
          ...trace.artifactIds,
        ]),
      ].slice(-MAX_RETAINED_ARTIFACTS),
      // Never inferred from a trace: an explicit dependency INTERRUPTS peers
      // (`relevanceFor` ranks it `explicit_dependency`, which is queued rather
      // than held), so it stays whatever a deliberate publish declared.
      blocksArtifactIds: carried?.lineage.blocksArtifactIds ?? [],
      ...(branch ? { branch } : {}),
      ...(pullRequest ? { pullRequest } : {}),
    },
  });
}

type RetainedPresence = {
  presence: SessionMeshPresenceInput;
  sourceKey: string;
};
/** The runtime's own live-roster cap, so retention never outgrows the roster. */
const MAX_RETAINED_SESSIONS = 500;

/**
 * The identity each session has accumulated, kept across `Stop`.
 *
 * Claude fires `Stop` at the end of EVERY response, and the runtime drops the
 * live session on it so the roster stops re-upserting a session that is idle.
 * Retention cannot live in that map: the next `UserPromptSubmit` would find no
 * prior and overwrite presence with nothing carried. Only `session_ended`
 * forgets an entry. Bounded by evicting the least recently seen session.
 */
export class SessionMeshRetainedPresence {
  private readonly entries = new Map<string, RetainedPresence>();

  get(agentId: string): RetainedPresence | undefined {
    return this.entries.get(agentId);
  }

  remember(agentId: string, retained: RetainedPresence): void {
    this.entries.delete(agentId);
    this.entries.set(agentId, retained);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_RETAINED_SESSIONS) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  forget(agentId: string): void {
    this.entries.delete(agentId);
  }
}

/**
 * The lineage a PUBLICATION carries: this event's subjects, not the session's
 * retained ones. Presence routes the session as a recipient by everything it
 * has touched; a publication is about this event, and the retained set would
 * send it to every peer on anything the session ever named.
 */
export function sessionMeshEventLineage(
  presence: SessionMeshPresenceInput,
  trace: SessionMeshTraceSubjects
): SessionMeshPresenceInput["lineage"] {
  const { pullRequest: _retained, ...lineage } = presence.lineage;
  return {
    ...lineage,
    artifactIds: trace.artifactIds,
    ...(trace.pullRequest ? { pullRequest: trace.pullRequest } : {}),
  };
}
