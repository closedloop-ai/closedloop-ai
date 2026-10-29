import type { SessionStatusOrderingName } from "@repo/api/src/types/session-status-root-order";
import type { BasicUser } from "@repo/api/src/types/user";
import type { ReadSessionDeadLetterState } from "../agent-sync/agent-session-dead-letter-sync-state.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { LoadTranscriptBlobStates } from "./local-transcript-cloud-sync.js";
import type { SessionListQueryObserver } from "./session-list-query-execution.js";
import type { SanitizedQuery } from "./shared-agent-sessions-query.js";

export type WorkingSetOptions = {
  statusRootRank?: (status: string) => number | null;
  computeTargetId?: string | null;
  // FEA-3284: which matcher gates the hydration fallback. The list passes
  // `matchesListQuery` (facets PLUS the substantive quality gate); the
  // usage/analytics folds pass `matchesQuery` (facets only) so their totals stay
  // byte-for-byte in step with the all-quality SQL `aggregateUsage`/
  // `aggregateAnalytics` paths (FEA-1834 §4) and the substantive gate never
  // leaks into cost/usage accounting. Defaults to `matchesQuery` when omitted.
  matcher?: (session: SyncedAgentSession, query: SanitizedQuery) => boolean;
  // FEA-3450: when set, the full-corpus filter pass also buckets the rows that
  // match every facet but are idle (the rows the substantive default hides) into
  // the returned `idleCount`, folding what used to be a second full-corpus scan
  // (`computeIdleCount`, which re-ran `sumTokenUsage` + `countToolUseEvents` per
  // row) into the single filter loop. Only the list read sets it; usage/analytics
  // never need the count. Ignored when `quality=all` (nothing is hidden → 0).
  countIdle?: boolean;
};

/**
 * Local list options. `computeTargetId` is the identity-scoped sync target;
 * null means unknown, so no cloud-sync verdict is disclosed.
 */
export type GetSharedAgentSessionsOptions = SessionListQueryObserver & {
  /** Resolved main-process assignment; absent on older hosts means vocabulary order. */
  statusOrdering?: SessionStatusOrderingName;
  computeTargetId?: string | null;
  /** Clone-safe directory snapshot supplied when projection runs in the DB host. */
  orgDirectory?: ReadonlyMap<string, BasicUser>;
  /** Internal observer used by the clone-safe DB-host projection. */
  onPendingOutboxAvailability?: (available: boolean) => void;
  /**
   * ISS-4647: bounded lookup of the page's `main` transcript blob states, so the
   * local list discloses a transcript lane that is still behind (parity with the
   * cloud list). Injected rather than read here because the transcript store
   * lives behind the db-host proxy; omitted (legacy/fake callers, or no store) ⇒
   * no transcript verdict ⇒ today's outbox-only behavior.
   */
  loadTranscriptBlobStates?: LoadTranscriptBlobStates;
  /** ISS-11427: the session lane's verdict on a row it has set aside. */
  readSessionDeadLetterState?: ReadSessionDeadLetterState;
};
