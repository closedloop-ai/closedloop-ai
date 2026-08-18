import {
  DISPLAYED_SESSION_STATUS,
  isSessionDisplayStale,
  RECOGNIZED_SESSION_STATUS_VALUES,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";

/**
 * The desktop-local Status FACET matcher and the status-vocabulary
 * normalization it depends on, split out of `shared-agent-sessions-api.ts`
 * (ISS-5366) so that file stays within its line budget — see AGENTS.md ->
 * "File Size and Organization".
 *
 * This is the local-source MIRROR of the cloud `buildStatusFacetPredicate`
 * (`apps/api/app/agent-sessions/service/query-builder.ts`). The two must bucket
 * a session identically: the Sessions list is one shared table rendered over
 * either source, so a row the cloud facet returns and the desktop facet drops
 * (or vice versa) is the same filter telling two stories the ISS-5366 batch
 * exists to stop. Change one, change the other.
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
 * data loss: it falls to {@link matchesUnknownFacet} and badges "Unknown",
 * which is what this build already does with every other spelling it does not
 * recognise. Removing the rewrite cannot hide a row, only relabel one.
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
  requestedStatus: string,
  displayedStatusParity = false
): boolean {
  const { status } = resolveRequestedStatusFilter(requestedStatus);
  const {
    canonicalStatus,
    displaysAsWaiting,
    excludedAsWaiting,
    excludedAsDisplayedWaiting,
    isDisplayStale,
  } = deriveRowDisplaySignals(session, displayedStatusParity);

  if (status === DISPLAYED_SESSION_STATUS.WAITING) {
    // The `!session.endedAt` guard mirrors the cloud facet/projection
    // (FEA-3149): an ended-but-not-yet-canonicalized row projects to a terminal
    // state on cloud and so must not surface as Waiting. Kept out of
    // `isAwaitingInput` so the `active` branch below is unchanged — cloud's
    // active facet excludes awaiting-input rows regardless of ended_at.
    if (!displayedStatusParity) {
      return displaysAsWaiting;
    }
    // ISS-4559: `waiting` is BOTH a projected display value and a legacy
    // PERSISTED one. A row literally storing `waiting` DISPLAYS as Waiting —
    // the projection returns the raw status when it does not fire — yet matched
    // NEITHER facet: this branch demanded `awaitingInputSince`, and ACTIVE
    // demands `active`. Union the stored value in, mirroring the cloud WAITING
    // predicate.
    return (
      displaysAsWaiting || canonicalStatus === DISPLAYED_SESSION_STATUS.WAITING
    );
  }
  if (status === SESSION_STATUS.ACTIVE) {
    return (
      canonicalStatus === SESSION_STATUS.ACTIVE &&
      !excludedAsWaiting &&
      !isDisplayStale
    );
  }
  if (status === DISPLAYED_SESSION_STATUS.STALE) {
    // Exactly the complement the ACTIVE branch excludes, plus a row that
    // literally persists `stale` (which the final equality used to answer) —
    // INCLUDING that equality's waiting-exclusion, which this arm was missing.
    //
    // ISS-5656: `stale` folds to `active`, which is non-terminal, so the Waiting
    // projection fires for a `stale` row awaiting input and it BADGES "Waiting".
    // Unconditional, this arm returned it from Stale too — the same double-count
    // {@link matchesUnknownFacet} subtracts one status over. (`isDisplayStale`
    // already carries the subtraction; only the literal arm lacked it.)
    return (
      isDisplayStale ||
      (!excludedAsDisplayedWaiting &&
        canonicalStatus === DISPLAYED_SESSION_STATUS.STALE)
    );
  }
  if (status === DISPLAYED_SESSION_STATUS.UNKNOWN) {
    // ISS-4559: the awaiting-input projection runs AHEAD of the unrecognized
    // fold, so a version-skewed row (unrecognized status, awaiting input, not
    // ended) DISPLAYS as Waiting, not Unknown — see {@link matchesUnknownFacet}.
    return matchesUnknownFacet(canonicalStatus, excludedAsDisplayedWaiting);
  }
  if (status === SESSION_STATUS.INACTIVE) {
    /* The `inactive` REQUEST is exactly that — no expansion, on either surface.
     * ISS-4654 dropped it here (migration 0042 collapses the retired spellings at
     * boot, so there is nothing local left to reach) and ISS-5592 dropped the
     * cloud half too, once the ingest fold made the spelling unwritable and a
     * production count confirmed the column holds none. */
    return canonicalStatus === SESSION_STATUS.INACTIVE;
  }
  // ISS-4559: ON, a row that DISPLAYS as Waiting belongs to the Waiting facet
  // and to no other, so it must not also come back under its raw status — the
  // same "matched by exactly the facet it displays" rule the ACTIVE branch
  // encodes. `displaysAsWaiting` already carries the non-terminal guard, so a
  // finished row holding a stale `awaitingInputSince` is not hidden from its own
  // facet. Mirrors the cloud fallback `{ NOT: DISPLAYS_AS_WAITING, status }`.
  //
  // ISS-5656: reads the shared `excludedAsDisplayedWaiting` rather than spelling
  // the gate out again — this arm, the UNKNOWN facet, and the literal-`stale`
  // arm now subtract one declared population.
  return !excludedAsDisplayedWaiting && canonicalStatus === status;
}

/**
 * The UNKNOWN facet: a status the display fold does not RECOGNIZE renders
 * "Unknown", as does a row literally storing `unknown`. Matching by EXCLUSION is
 * the only way to reach a value a future producer invents, since by definition it
 * cannot be listed.
 *
 * ISS-4559: a row that DISPLAYS as Waiting is excluded first. The awaiting-input
 * projection runs AHEAD of the unrecognized fold, so a version-skewed row that is
 * also awaiting input badges "Waiting" — and without this it was returned by BOTH
 * the Waiting and the Unknown facet: double-counted, under a facet whose name
 * contradicts its own badge, in exactly the version-skew case Unknown exists to
 * serve. The same "matched by exactly the facet it displays" rule the ACTIVE
 * branch and the raw-status fallback encode.
 *
 * Extracted rather than inlined so `matchesStatusFilter` stays inside the
 * cognitive-complexity ceiling (AGENTS.md → Code Style).
 *
 * ISS-5656: takes the caller's already-resolved `excludedAsDisplayedWaiting`
 * instead of re-applying the gate to a raw `displaysAsWaiting`. Three arms
 * subtract this population and each used to spell the condition itself, which is
 * how the literal-`stale` arm came to be written without it.
 */
function matchesUnknownFacet(
  canonicalStatus: string,
  excludedAsDisplayedWaiting: boolean
): boolean {
  if (excludedAsDisplayedWaiting) {
    return false;
  }
  return (
    !RECOGNIZED_SESSION_STATUS_VALUES.includes(canonicalStatus) ||
    canonicalStatus === DISPLAYED_SESSION_STATUS.UNKNOWN
  );
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
  excludedAsWaiting: boolean;
  excludedAsDisplayedWaiting: boolean;
  isDisplayStale: boolean;
};

/**
 * Derive, ONCE per row, every display signal the facet arms read.
 *
 * Extracted rather than inlined so {@link matchesStatusFilter} stays inside the
 * cognitive-complexity ceiling (AGENTS.md → Code Style) — and extracted as ONE
 * derivation rather than per-facet ones because the arms deliberately SHARE
 * these values and read several of them in opposite senses; re-deriving per
 * facet is exactly how they drift apart.
 */
function deriveRowDisplaySignals(
  session: SyncedAgentSession,
  displayedStatusParity: boolean
): RowDisplaySignals {
  const canonicalStatus = canonicalSharedStatus(session.status);
  // Desktop stores waiting-for-user state as a timestamp on a non-terminal row,
  // not as a persisted session status.
  const isAwaitingInput =
    !TERMINAL_SHARED_STATUSES.has(canonicalStatus) &&
    Boolean(session.awaitingInputSince);
  // ISS-4556 / ISS-4559: "this row DISPLAYS as Waiting" — the desktop half of
  // the cloud `DISPLAYS_AS_WAITING` clause and byte-for-byte the condition
  // `projectDisplayedSharedStatus` projects on. Declared once and used in
  // opposite senses by WAITING and ACTIVE, so a row is excluded from Active
  // EXACTLY when it displays as Waiting.
  const displaysAsWaiting = isAwaitingInput && !session.endedAt;
  // ISS-4559: ON, a row leaves the Active population EXACTLY when it DISPLAYS as
  // Waiting — the same clause the WAITING branch selects, negated. OFF (the
  // closed-by-default rollout state), the pre-ISS-4559 predicate applies: it
  // dropped EVERY awaiting-input row regardless of `endedAt`, so an ended +
  // awaiting-input row was returned by neither facet.
  //
  // Declared ONCE, above the staleness test, and read by ACTIVE, STALE, and the
  // staleness test itself. That is load-bearing: `resolveDisplayedSessionStatus`
  // exempts a row from the staleness fold only when it displays as WAITING, so a
  // staleness test keyed on the wider `isAwaitingInput` disagrees with the badge
  // for an ended + awaiting-input row and re-opens, one dimension over, the very
  // ACTIVE/STALE gap ISS-4559 closes for ACTIVE/WAITING.
  const excludedAsWaiting = displayedStatusParity
    ? displaysAsWaiting
    : isAwaitingInput;
  // ISS-5656: the gated subtraction every arm that matches on the row's OWN
  // STORED status applies — "this row belongs to the Waiting facet, so it
  // belongs to no other". Distinct from `excludedAsWaiting` above, which is the
  // ACTIVE/STALE partition's subtraction and is deliberately WIDER while the
  // gate is off.
  //
  // Declared once because it had been written out three times: the raw-status
  // fallback, {@link matchesUnknownFacet}, and — missing — the literal-`stale`
  // arm of the STALE branch, which is the whole of ISS-5656. Three copies of one
  // condition is how the fourth came to be forgotten.
  const excludedAsDisplayedWaiting = displayedStatusParity && displaysAsWaiting;
  // ISS-5366: the desktop mirror of the cloud ACTIVE/STALE partition. The shared
  // Sessions table badges a long-silent `active` row "Stale" on BOTH surfaces
  // (`resolveDisplayedSessionStatus`, unconditional since the
  // `sessions-honest-unknown-states` gate was retired), so the local filter has
  // to split the same population the same way — otherwise desktop's Active facet
  // returns rows desktop's own grid labels Stale.
  const isDisplayStale =
    canonicalStatus === SESSION_STATUS.ACTIVE &&
    !excludedAsWaiting &&
    isSessionDisplayStale(session.lastActivityAt ?? session.startedAt);
  return {
    canonicalStatus,
    displaysAsWaiting,
    excludedAsWaiting,
    excludedAsDisplayedWaiting,
    isDisplayStale,
  };
}
