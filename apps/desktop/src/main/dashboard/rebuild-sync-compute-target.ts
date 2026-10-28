/**
 * @file rebuild-sync-compute-target.ts
 * @description FEA-3659: pure resolver for the compute-target id the
 * data-revision rebuild enqueue keys its sync-outbox rows under. Kept in its own
 * leaf module (no `electron` import) so the offline → no-enqueue contract is
 * unit-testable in the node:test environment without booting the Electron
 * runtime (importing the runtime module pulls in `electron`, which node:test
 * cannot load).
 *
 * #4150: also hosts `buildSharedAgentSessionsListOptions` — the ONE Sessions-list
 * options builder both list channels share — extracted here from
 * `agent-dashboard-design-system-runtime.ts` so adding it does not grow that
 * runtime. It is the same class of pure, electron-free helper this leaf already
 * owns.
 */
import type { ReadSessionDeadLetterState } from "../agent-sync/agent-session-dead-letter-sync-state.js";
import type { GetSharedAgentSessionsOptions } from "../session/shared-agent-sessions-api.js";
import type { TranscriptMainBlobState } from "../transcript-sync/transcript-sync-types.js";

/**
 * FEA-3659: resolve the compute-target id the data-revision rebuild enqueue must
 * key its sync-outbox rows under. Prefers the IDENTITY-SCOPED
 * `getSyncComputeTargetId` — the id the session lane writes under, null when none
 * is attributable to the account signed in now; when a caller wired only the
 * legacy `getComputeTargetId` it falls back to that. Critically, when
 * `getSyncComputeTargetId` IS wired, its `null` result is honored as null — it
 * does NOT fall through to the stale `getComputeTargetId`, so a rebuild never
 * enqueues under a stale `lastComputeTargetId` that would strand rows under the
 * wrong source key across an account switch.
 *
 * ISS-8691: "no target" and "offline" stopped being the same question — the
 * session lane retains its target across a socket drop, so this resolves to a
 * real id while offline. That is required, not incidental: the read side below
 * must consult the outbox under the key the write side is enqueuing under, or a
 * still-queued row loses the `pending` it has earned — ISS-9004: it reads back
 * as unknown, publishing no disclosure, rather than as the false `synced` it
 * used to.
 */
export function resolveRebuildSyncComputeTargetId(options: {
  getSyncComputeTargetId?: () => string | null;
  getComputeTargetId?: () => string | null;
}): string | null {
  if (options.getSyncComputeTargetId) {
    return options.getSyncComputeTargetId() ?? null;
  }
  return options.getComputeTargetId?.() ?? null;
}

/** The narrow transcript-store surface the list-options builder reads. */
type TranscriptBlobStateReader = {
  transcriptSync?: {
    listMainBlobStates: (
      externalSessionIds: string[]
    ) => Promise<TranscriptMainBlobState[]>;
  } | null;
};

/**
 * ISS-4647: the ONE options object every local Sessions LIST read is given —
 * shared by the standalone `list` channel and the combined `pageData` channel
 * (whose list half is the same `getSharedAgentSessions` call, and which is what
 * `SessionsView` actually reads through).
 *
 * Two handlers building this literal independently is exactly how FEA-4157 shipped
 * a `pageData` path with no compute target, which loaded an empty pending-outbox
 * set and mislabelled every pending-upload row as `synced` on the real Sessions
 * page while the standalone handler looked correct. One builder, no drift.
 *
 * - `computeTargetId` is the IDENTITY-SCOPED target, so the outbox lookup is
 *   keyed under the same source key the sync write side enqueues under. ISS-9004:
 *   null ⇒ the pending set is UNKNOWN, not proven-empty, and the row publishes no
 *   cloud-sync disclosure — it was never honest to read it as `synced`, because
 *   rows enqueued under an earlier target outlive the target we can name.
 * - `loadTranscriptBlobStates` adds the transcript-BLOB lane, so a session whose
 *   metadata was acked while its raw transcript is still queued discloses
 *   `pending` here exactly as it does on the cloud list. Bounded to the page's
 *   ids; an absent transcript store degrades to no verdict (outbox-only).
 */
export function buildSharedAgentSessionsListOptions(
  agentDatabase: TranscriptBlobStateReader,
  options: {
    getSyncComputeTargetId?: () => string | null;
    getComputeTargetId?: () => string | null;
    readSessionDeadLetterState?: ReadSessionDeadLetterState;
  }
): GetSharedAgentSessionsOptions {
  return {
    computeTargetId: resolveRebuildSyncComputeTargetId(options),
    readSessionDeadLetterState: options.readSessionDeadLetterState,
    loadTranscriptBlobStates: (externalSessionIds) =>
      agentDatabase.transcriptSync?.listMainBlobStates(externalSessionIds) ??
      Promise.resolve([]),
  };
}
