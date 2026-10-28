import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";

/**
 * The desktop-local Status FACET matcher and the status-vocabulary
 * normalization it depends on, split out of `shared-agent-sessions-api.ts`
 * (ISS-5366) so that file stays within its line budget — see AGENTS.md ->
 * "File Size and Organization".
 *
 * This WAS the local-source mirror of the cloud `buildStatusFacetPredicate`.
 * ISS-9939 / ISS-10629 deleted that predicate: the cloud Status FILTER is now a
 * plain equality on the persisted `artifacts.status` column. This file's
 * docstring then read that the two surfaces "bucket a session differently on
 * purpose". ISS-10741: no ruling said that. The operator ruling is ISS-9939,
 * quoted at `packages/app/agents/lib/session-status-filters.ts` — a row badging
 * Waiting or Stale still stores `active` and still matches Active — and the
 * ACTIVE arm below implements it.
 *
 * The sibling that still has to move with this file is the SQL fast path
 * `buildUsageStatusPredicate` (`../database/session-aggregate-filters.ts`),
 * which feeds the counts above the very list this matcher filters — change one,
 * change the other.
 *
 * ISS-11239 (owner ruling, 2026-09-26): `endedAt` is not an input here either.
 * A row storing `active` beside a recorded end matches Active, as cloud does.
 */

// ISS-4586: the two terminal lifecycle values. ISS-5592 dropped the retired
// spellings (migration 0042 collapsed every local row that held one) and then
// the `failed` alias, once `canonicalSharedStatus` stopped manufacturing it.
export const TERMINAL_SHARED_STATUSES: ReadonlySet<string> = new Set([
  SESSION_STATUS.INACTIVE,
  SESSION_STATUS.ERROR,
]);

/**
 * Case-normalize a status at the local shared-API boundary. Case ONLY — every
 * rewrite this function used to perform is gone, so the three lifecycle values
 * are compared as themselves.
 *
 * ISS-5592 removed the `error` → `failed` rewrite first: it MANUFACTURED a
 * spelling nothing stored, purely so the alias map could fold it back at the
 * other end — the map and its only source, each existing to feed the other.
 *
 * The rewrite that canonicalized a stored `running` went with it, on evidence
 * rather than on that reasoning, because its case was different: `running` is the
 * `sessions.status` column DEFAULT and migration 0042 collapsed only
 * `completed`/`abandoned`, so a stored one would have been real data. It is not
 * reachable, and three checks say so rather than one:
 *
 *   • No commit in this repo's history has ever written the value:
 *
 *       git log --all -S"status = 'running'" -- apps/desktop/src \
 *         ':!apps/desktop/src/main/session/session-status-filter-match.ts'
 *
 *     is empty, as is `-S"'running'"` over `write-core.ts` and `live-hook.ts`.
 *     The exclusion is not a thumb on the scale — it removes THIS file, whose
 *     docstring now contains the literal being searched for, so without it the
 *     command reports its own commit and reads as a refutation. `--all` walks
 *     every ref, so pinning to a revision before that commit does not work.
 *   • The DEFAULT has never been reachable either, in EITHER storage engine.
 *     Five files have ever held an `INSERT INTO sessions` (`write-core.ts`,
 *     `live-hook.ts`, `codex-otel-writer.ts`, `sqlite.ts`, and the retired
 *     PGlite-era `pglite.ts`); across every revision of them that carries one,
 *     294 in total, not a single insert omits `status` from its column list. So
 *     no write has ever fallen through to the default.
 *   • Every current writer binds a canonical constant: `SESSION_STATUS.ACTIVE`
 *     in `live-hook.ts`, the ERROR/INACTIVE `CASE` in `session-maintenance.ts`,
 *     a `SessionStatus`-typed value in `write-core-terminal-end.ts`.
 *
 * And the failure mode if one somehow existed is the DESIGNED degradation, not
 * data loss: the DISPLAY fold badges it "Unknown", which is what this build
 * already does with every other spelling it does not recognise. Removing the
 * rewrite cannot hide a row, only relabel one.
 *
 * (The column default itself is unchanged — SQLite cannot alter one without a
 * table rebuild, and rebuilding a live local store to retire a value nothing
 * reaches is not a trade worth making. ISS-6734 holds it.)
 *
 * Still applied SYMMETRICALLY to the row status and the requested filter, which
 * is what keeps the two comparable. Do not make one side skip it.
 */
export function canonicalSharedStatus(status: string): string {
  return status.toLowerCase();
}

export function matchesStatusFilter(
  session: SyncedAgentSession,
  requestedStatus: string
): boolean {
  const { status } = resolveRequestedStatusFilter(requestedStatus);
  const { canonicalStatus, displaysAsWaiting } =
    deriveRowDisplaySignals(session);

  // ISS-9939 / ISS-10629 (operator ruling, 2026-09-18): the WAITING, STALE and
  // UNKNOWN arms are GONE. Those values are display-only projections the ruling
  // retired as FILTER values on both surfaces.
  //
  // The FIRST-PARTY UI path cannot send one: `SessionStatusFacetValue` offers
  // the three persisted lifecycle values and `dedupeSessionStatusFacetValues`
  // drops a restored retired value at the parse boundary
  // (`packages/app/agents/lib/session-filter-adapter.tsx`). That seam is on the
  // PLURAL `statuses` only — the back-compat singular `status` has none on any
  // path, and the IPC schema types it as a bare optional string, so an
  // automation sender over the browser bridge can still carry a retired word
  // (marisolashgrove, #7663). Narrow claim deliberately: the behaviour on arrival
  // is what makes that safe, not the absence of a sender. Such a request falls
  // to the stored-status equality at the bottom, the same fallthrough every
  // other unrecognized spelling already gets.
  //
  // ISS-10741: no display subtraction here, matching cloud. A row badging
  // Waiting or Stale still stores `active` and still matches Active (ISS-9939).
  if (status === SESSION_STATUS.ACTIVE) {
    return canonicalStatus === SESSION_STATUS.ACTIVE;
  }
  if (status === SESSION_STATUS.INACTIVE) {
    /* The `inactive` REQUEST is exactly that — no expansion, on either surface.
     * ISS-4654 dropped it here (migration 0042 collapses the retired spellings at
     * boot, so there is nothing local left to reach) and ISS-5592 dropped the
     * cloud half too, once the ingest fold made the spelling unwritable and a
     * production count confirmed the column holds none. */
    return canonicalStatus === SESSION_STATUS.INACTIVE;
  }
  // ISS-4559: a row that DISPLAYS as Waiting must not come back under its raw
  // status. `displaysAsWaiting` already carries the non-terminal guard, so a
  // finished row holding a stale `awaitingInputSince` is not hidden from its own
  // facet.
  //
  // Kept when ISS-10741 dropped the identical term from ACTIVE: that arm is a
  // live facet the ruling settled, this is a retired spelling no ruling covers.
  //
  // ISS-10629 left this subtraction in place when the WAITING arm it paired with
  // went. It is no longer "belongs to Waiting instead", because there is no
  // Waiting facet to belong to — it is the last statement of the older rule that
  // a badge and a facet must not contradict each other, and removing it would
  // WIDEN which rows a retired-spelling request gathers, which no ruling asked
  // for.
  //
  // TWO CONSEQUENCES, BOTH DELIBERATE AND BOTH REPORTED ON THE ISS-10629 PR:
  //   • Desktop is NOT vacuous for a retired request the way cloud is. Cloud
  //     narrows `?status=waiting` to `{ in: [] }`; here a row that LITERALLY
  //     stores `waiting` still matches, and `db-constants.ts` records that a
  //     legacy local row can hold one (migration 0042 left the spelling alone).
  //   • …unless that same row is awaiting input, in which case this subtraction
  //     drops it and it is gathered by no facet at all. The WAITING arm's
  //     unconditional `displaysAsWaiting ||` used to catch exactly that shape.
  //     That drop IS pinned, on both twins (marisolashgrove, #7663): the oracle's
  //     awaiting-input rows over a stored `stale`/`unknown`/unrecognized
  //     spelling set `matchedByRawStatusFacet: false`, and both sweeps ask a row
  //     for its OWN raw status — so removing this subtraction reddens
  //     `shared-agent-sessions-status-facet.test.ts` and
  //     `session-aggregate-status-parity.test.ts`.
  return !displaysAsWaiting && canonicalStatus === status;
}

/** The REQUEST-side vocabulary, resolved once for {@link matchesStatusFilter}. */
type ResolvedStatusRequest = {
  /** The facet to dispatch on, canonicalized through the shared alias map. */
  status: string;
};

/**
 * Resolve the REQUESTED filter value into the facet to dispatch on.
 *
 * Case-normalize the requested filter the same way the row status is, so the
 * two are compared on equal terms. ISS-5592 removed the alias rewriting: the
 * shared UI sends `SESSION_STATUS.ERROR` and local rows store `error`, so they
 * match directly instead of both being rewritten to `failed` first.
 *
 * ISS-5592 removed the ISS-4985 retired-request fold that used to sit here. A
 * `completed`/`abandoned` request now falls through to the raw
 * `canonicalStatus === status` equality at the bottom of
 * {@link matchesStatusFilter} and matches nothing — which is correct, because
 * nothing stores those spellings: migration 0042 collapsed the local store at
 * boot and the cloud ingest fold made the value unwritable.
 */
function resolveRequestedStatusFilter(
  requestedStatus: string
): ResolvedStatusRequest {
  return { status: canonicalSharedStatus(requestedStatus) };
}

/** The ROW-side display signals, derived once for {@link matchesStatusFilter}. */
type RowDisplaySignals = {
  canonicalStatus: string;
  displaysAsWaiting: boolean;
};

/**
 * Derive, ONCE per row, the display signals {@link matchesStatusFilter} reads.
 *
 * Extracted rather than inlined so that function stays inside the
 * cognitive-complexity ceiling (AGENTS.md → Code Style).
 */
function deriveRowDisplaySignals(
  session: SyncedAgentSession
): RowDisplaySignals {
  const canonicalStatus = canonicalSharedStatus(session.status);
  // Desktop stores waiting-for-user state as a timestamp on a non-terminal row,
  // not as a persisted session status.
  const isAwaitingInput =
    !TERMINAL_SHARED_STATUSES.has(canonicalStatus) &&
    Boolean(session.awaitingInputSince);
  // ISS-4556 / ISS-4559: "this row DISPLAYS as Waiting". ISS-10629 retired the
  // WAITING, STALE and UNKNOWN arms and ISS-10741 stopped ACTIVE subtracting it,
  // so the one reader left is the raw-status fallback — where it keeps a legacy
  // row storing the literal `waiting` from answering its own spelling while it
  // badges Waiting.
  //
  // ISS-7837: NOT byte-for-byte the condition `projectDisplayedSharedStatus`
  // projects on, and a comment here claimed it was. That projection PARSES
  // (`parseNullableSessionDate(...) !== null`); this tests truthiness, so a row
  // whose `awaitingInputSince` is present but unparseable ("13 o'clock") badges
  // Waiting there and is excluded from Waiting here. Correcting the PARSE is
  // sequenced behind ISS-6714, the open product call on the sibling `endedAt`
  // field, which this condition reads on the same line — so the divergence
  // stands and is named rather than asserted away.
  const displaysAsWaiting = isAwaitingInput && !session.endedAt;
  return { canonicalStatus, displaysAsWaiting };
}
