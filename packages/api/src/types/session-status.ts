/**
 * @file session-status.ts
 * @description The canonical session-status vocabularies (FEA-1718 / PLN-921
 * §8), shared by `apps/api` (which writes onto a SESSION artifact's free-form
 * `status` column), `packages/app`, and the desktop main process.
 *
 * ISS-5592 moved this here from `@closedloop-ai/loops-api/session-status` and split the
 * DISPLAY COPY into the sibling `session-status-display.ts`, so a
 * bundle-sensitive `"use client"` surface that wants only a label does not pull
 * in the folds. This module is the VALUES and the NORMALIZERS; nothing here is
 * user-facing text.
 *
 * `packages/design-system` deliberately does NOT read this module. It is a
 * separate, project-agnostic product (FEA-4115) and is gated from `@repo/api`,
 * so it carries its OWN `SESSION_STATUS` in `components/ui/types.ts`. That copy
 * is NOT kept in sync with this one by design — decided by Cosimo on 2026-08-14.
 * Desktop and web DO stay in sync, and both read this module.
 *
 * ## TWO vocabularies, one set of values (ISS-5592, narrowed by ISS-10364)
 *
 * {@link SESSION_STATUS} is the LIFECYCLE set — `active`, `inactive`, `error` —
 * and it is the whole set a row may STORE. Do not add a fourth member and do not
 * reintroduce a retired one.
 *
 * {@link DISPLAYED_SESSION_STATUS} is what a RENDER speaks. ISS-5592 through
 * ISS-5366 built this as the lifecycle set plus three read-time derivations —
 * `waiting` (the awaiting-input sub-state), `unknown` (an unparseable stored
 * string), and `stale` (an `active` row silent past
 * {@link STALE_SESSION_DISPLAY_THRESHOLD_HOURS}) — each kept distinct because a
 * render must not claim a run is going when nothing establishes that.
 *
 * **ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23/24) RETIRED all
 * three.** Verbatim: "Unparsable status are already converted to Active on
 * import. Don't distinguish between active and stale", then "let's drop
 * waiting as well." {@link DISPLAYED_SESSION_STATUS} is now exactly
 * {@link SESSION_STATUS} under a second name: an unparseable stored status and
 * a reaper-silent `active` row both read `active`, and the awaiting-input
 * sub-state no longer has a word — `session_detail.awaitingInputSince` is
 * still written and read, but nothing projects it into a display member any
 * more. The type alias is kept distinct from {@link SessionStatus} so a render
 * call site still reads as a display derivation rather than a raw lifecycle
 * value, even though the two vocabularies now share every member; deleting
 * {@link DISPLAYED_SESSION_STATUS} outright is a later, call-site-touching
 * slice.
 *
 * Two pieces of the retired vocabulary survive outside a render:
 *
 *   • {@link STALE_SESSION_DISPLAY_THRESHOLD_HOURS} and
 *     {@link isSessionDisplayStale} — the desktop collector's
 *     `data-revision.ts` classifies a wedged rebuild candidate with them, which
 *     is collector logic, not a render.
 *   • the literal string `"waiting"` as an INCOMING wire value. It is still
 *     ACCEPTED from a version-skewed producer that sends it as a stored status
 *     — the main ingest (`upsert-arm-detail.ts`) and the reopen arm
 *     (`session-reopen.ts`) both fold it to `active`, preserving the
 *     `awaitingInputSince` anchor so the fold loses nothing — see
 *     {@link LEGACY_WAITING_WIRE_STATUS}. That tolerance is a compatibility
 *     boundary, not a display path: nothing downstream of it ever renders the
 *     word again.
 *
 * ISS-4654 RETIRED `completed` and `abandoned`, and ISS-5592 removed the last of
 * their tolerance. They are now ORDINARY UNRECOGNIZED VALUES: nothing labels,
 * sorts, filters or folds them, and an inbound one takes the fail-open branch to
 * `active` like any other spelling this build does not model. See the note above
 * {@link normalizeSessionStatus} for what that costs a version-skewed producer.
 */
export const SESSION_STATUS = {
  ACTIVE: "active",
  /**
   * The terminal-but-not-failed state (ISS-4586) — a run is either going
   * (ACTIVE), finished (INACTIVE), or finished-with-an-error (ERROR).
   * `ends_with_error` decides ERROR vs INACTIVE at the moment a run is declared
   * idle, and the retired `completed`/`abandoned` pair both collapsed here.
   */
  INACTIVE: "inactive",
  ERROR: "error",
} as const;

/** What a session row may STORE — exactly three values, see the file header. */
export type SessionStatus =
  (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

/**
 * What a RENDER speaks. Since ISS-10364 this is {@link SESSION_STATUS} under a
 * second name — every display-only derivation was retired (see the file
 * header) — kept as its own const/type so a render call site still reads as a
 * display derivation rather than a raw lifecycle value.
 *
 * Spread from the lifecycle set rather than restating it, so the two vocabularies
 * cannot drift on the values they share.
 */
export const DISPLAYED_SESSION_STATUS = {
  ...SESSION_STATUS,
} as const;

export type DisplayedSessionStatus =
  (typeof DISPLAYED_SESSION_STATUS)[keyof typeof DISPLAYED_SESSION_STATUS];

/**
 * ISS-10364: the literal `"waiting"` string a version-skewed producer can still
 * send as an INCOMING session status, now that {@link DISPLAYED_SESSION_STATUS}
 * no longer has a `WAITING` member to compare against. NOT a display value —
 * every consumer of this constant folds it to {@link SESSION_STATUS.ACTIVE}
 * while preserving `awaitingInputSince`, exactly as the retired member's
 * comparisons always did. See the file header's "survives outside a render"
 * note for why the tolerance itself is not going anywhere.
 */
export const LEGACY_WAITING_WIRE_STATUS = "waiting";

/**
 * ISS-10364: the retired DISPLAY-ONLY facet spellings a bookmark, saved view,
 * or version-skewed client can still request — `waiting`, `stale`, `unknown`.
 * HELD EXPLICITLY, not derived from the vocabulary: before this ticket these
 * were `Exclude<DisplayedSessionStatus, SessionStatus>`, computed from the
 * difference between the two vocabularies; now that
 * {@link DISPLAYED_SESSION_STATUS} equals {@link SESSION_STATUS} exactly, that
 * difference is empty, and a derived set would have silently stopped
 * stripping these three from a Status facet request — exactly what
 * `resolvePersistedStatusFilter` (`apps/api`) exists to prevent (ISS-10629: an
 * empty `in` is unsatisfiable by construction; falling through to "no
 * predicate" would silently widen the request to every session).
 */
export const RETIRED_DISPLAY_FACET_SPELLINGS = [
  "waiting",
  "stale",
  "unknown",
] as const;

/**
 * ISS-4997: the EXHAUSTIVE fold of every CANONICAL status onto the display
 * vocabulary, typed `Record<DisplayedSessionStatus, DisplayedSessionStatus>` so
 * adding a member to {@link DISPLAYED_SESSION_STATUS} fails `tsc` here until it
 * is intentionally mapped.
 *
 * That compile-time guard is the actual fix for ISS-4997. The runtime
 * `default: return ACTIVE` it replaces was only the symptom: because a `switch`
 * over `string` can never be exhaustive, a status added server-side silently
 * acquired the most consequential meaning in the set — "this agent is running" —
 * with nothing failing anywhere. A missing key here is now a build error.
 *
 * Since ISS-10364 every key maps to itself — there is no longer a display-only
 * member to fold ONTO a lifecycle value. The map stays because a status added to
 * {@link SESSION_STATUS} still has to be added here before it type-checks.
 */
const CANONICAL_SESSION_STATUS_FOLD: Record<
  DisplayedSessionStatus,
  DisplayedSessionStatus
> = {
  [SESSION_STATUS.ACTIVE]: SESSION_STATUS.ACTIVE,
  [SESSION_STATUS.INACTIVE]: SESSION_STATUS.INACTIVE,
  [SESSION_STATUS.ERROR]: SESSION_STATUS.ERROR,
};

/*
 * ISS-5592: `RETIRED_SESSION_STATUS`, `RetiredSessionStatus`,
 * `RETIRED_SESSION_STATUS_FOLD` and `RETIRED_SESSION_STATUS_VALUES` are GONE,
 * and with them the whole `completed`/`abandoned` compatibility path. Removed on
 * Cosimo's explicit decision (2026-08-14) with the consequence accepted.
 *
 * State the consequence plainly rather than implying this was inert cleanup: the
 * two spellings are now UNRECOGNIZED, so they take the fail-open branch in
 * {@link normalizeSessionStatus} and resolve to ACTIVE. A version-skewed client
 * that still sends `completed` therefore has a FINISHED run stored as `active`
 * — reaper-eligible and rendered as running — where it previously stored
 * `inactive`. The ISS-4654 backfill collapsed the pre-fold rows and ISS-5981's
 * total ingest fold stops new ones, so the exposure is a producer older than
 * `20260808120000_iss4654_backfill_legacy_session_status`, not the stored corpus.
 *
 * A request for `?status=completed` from a bookmark or saved view likewise no
 * longer routes onto the Inactive facet; it is an ordinary unrecognized value.
 *
 * Do not reintroduce either spelling as a first-class member. There is nowhere
 * left to put one: {@link CANONICAL_SESSION_STATUS_FOLD} is typed
 * `Record<DisplayedSessionStatus, …>`, so an alias key does not compile. If a
 * producer needs tolerating again, fix the producer — which is what ISS-5592
 * did to the one that manufactured `failed`.
 */

/*
 * ISS-5592: `SESSION_STATUS_FOLD` is GONE. It layered two aliases — `running`
 * and `failed` — on top of the canonical map, and there is now nothing to fold:
 * the one live producer of `failed` was the desktop's own `canonicalSharedStatus`,
 * which manufactured it from a stored `error`, and that rewrite is removed in the
 * same change. A vocabulary with no aliases needs no alias map.
 *
 * The canonical map is the whole fold. Do not reintroduce a second one to
 * "tolerate" a spelling — fix the producer, which is what this change did.
 */

/**
 * ISS-5366: every raw status string {@link foldSessionStatus} RECOGNIZES. Since
 * ISS-5592 that is exactly the canonical members — the last aliases (`running`,
 * `failed`) went with the alias map.
 *
 * Exported so a STORE can express "the display would call this Unknown" as a
 * `NOT IN` over this list: an unrecognized status is by definition unlistable,
 * so the only way a query can reach those rows is by excluding the recognized
 * ones. Derived from the fold map rather than retyped, so adding an alias there
 * cannot leave a consumer matching a value the display has since learned to
 * read.
 *
 * ISS-10629 retired the UNKNOWN facet predicates that were the original callers,
 * on both surfaces, and left this export with NO production reader. Everything
 * that still imports it is a test or a lint rule:
 * `scripts/lint/rules/no-transcribed-status-fold.ts`, the parity oracle, and two
 * suites. It is emphatically NOT read by {@link isRecognizedSessionStatus},
 * which deliberately tests the fold map directly — see that function's own note.
 */
export const RECOGNIZED_SESSION_STATUS_VALUES: readonly string[] = Object.keys(
  CANONICAL_SESSION_STATUS_FOLD
);

/**
 * The display fold of a raw status string. Since ISS-10364 an unrecognized
 * value resolves to {@link SESSION_STATUS.ACTIVE}, exactly like
 * {@link normalizeSessionStatus} — there is no longer a display-only member to
 * assert the gap with.
 *
 * `Object.hasOwn` rather than a bare index read: `status` is external input, so
 * a lookup on an object literal would otherwise resolve inherited keys
 * (`constructor`, `__proto__`) and return a non-status value.
 */
function foldSessionStatus(status: string): DisplayedSessionStatus {
  return Object.hasOwn(CANONICAL_SESSION_STATUS_FOLD, status)
    ? CANONICAL_SESSION_STATUS_FOLD[status as DisplayedSessionStatus]
    : SESSION_STATUS.ACTIVE;
}

/**
 * ISS-4586: fold a status into the canonical ACTIVE / INACTIVE / ERROR
 * vocabulary. INACTIVE is the neutral "terminal, not failed" state — NOT a
 * success claim; there is no separate indeterminate terminal state in this
 * model.
 *
 * Every KNOWN alias is mapped EXPLICITLY (davetho P2) through
 * {@link CANONICAL_SESSION_STATUS_FOLD}: the display-only `waiting` resolves to
 * ACTIVE, and every other member maps to itself. ISS-5592 removed the last
 * aliases, so no spelling reaches a lifecycle value by any name but its own.
 *
 * ISS-4997: an UNRECOGNIZED value still folds to ACTIVE here, and that is
 * deliberate. This is the STORED/canonical fold;
 * {@link resolveDisplayedSessionStatus} is the honest DISPLAY derivation and is
 * what render code should call.
 *
 * That split is load-bearing, INCLUDING for the literal string `"unknown"`
 * (whitlockk, #4324). `status` is a free-form external column, so a newer or older
 * producer genuinely can send that value, and consumers of this fold — the
 * Documents table row registry (`sessionStatusToIcon`/`sessionStatusToLabel`)
 * among them — are not display surfaces that handle the display-only members.
 * Recognizing the literal here would pair the label "Unknown" with the
 * in-progress icon, since `sessionStatusToIcon` has no UNKNOWN branch — a fresh
 * instance of the contradiction ISS-4997 exists to remove.
 *
 * So `"unknown"` takes the same fail-open branch as any other unrecognized
 * value here — and since ISS-10364 that is the ONLY branch it takes anywhere.
 * The row derivation that used to recognize it, and the badge that read the
 * value before normalizing, both stopped producing display words on the
 * operator's 2026-09-23 ruling. This fail-open is now the whole answer, and it
 * is also the version-skew compatibility path.
 */
export function normalizeSessionStatus(status: string): SessionStatus {
  if (!Object.hasOwn(CANONICAL_SESSION_STATUS_FOLD, status)) {
    return SESSION_STATUS.ACTIVE;
  }
  return LIFECYCLE_SESSION_STATUS_FOLD[
    CANONICAL_SESSION_STATUS_FOLD[status as DisplayedSessionStatus]
  ];
}

/**
 * ISS-4586: fold a DISPLAYED status to the display vocabulary. Since ISS-10364
 * this is a pure alias of {@link normalizeSessionStatus} — `waiting` is no
 * longer a value either function can produce or preserve, so there is nothing
 * left for this one to do differently. It is kept, rather than deleted and its
 * ~15 call sites renamed in this same diff, because every one of them is typed
 * against {@link DisplayedSessionStatus} and reads as "the displayed status",
 * not "the stored one" — the distinction in the TYPE still carries meaning even
 * though the two functions' bodies no longer differ. New display code may call
 * either; a future cleanup can retire this name and repoint its callers at
 * {@link normalizeSessionStatus} directly.
 */
export function normalizeDisplayedSessionStatus(
  status: string
): DisplayedSessionStatus {
  return normalizeSessionStatus(status);
}

/**
 * ISS-5592: the fold from the DISPLAY vocabulary onto the LIFECYCLE one — what
 * {@link normalizeSessionStatus} means once the display members are in a
 * vocabulary of their own.
 *
 * Typed `Record<DisplayedSessionStatus, SessionStatus>` so it carries the same
 * compile-time guard {@link CANONICAL_SESSION_STATUS_FOLD} does: a member added
 * to {@link DISPLAYED_SESSION_STATUS} fails `tsc` here until it is intentionally
 * mapped, rather than silently acquiring the most consequential meaning in the
 * set. Since ISS-10364 every key maps to itself — there is no display-only
 * member left to fail open to ACTIVE.
 */
const LIFECYCLE_SESSION_STATUS_FOLD: Record<
  DisplayedSessionStatus,
  SessionStatus
> = {
  [SESSION_STATUS.ACTIVE]: SESSION_STATUS.ACTIVE,
  [SESSION_STATUS.INACTIVE]: SESSION_STATUS.INACTIVE,
  [SESSION_STATUS.ERROR]: SESSION_STATUS.ERROR,
};

/**
 * The subset of {@link SESSION_STATUS} values that are terminal: the run is over
 * or has failed, so it can never be genuinely "awaiting user input". Hoisted
 * here (FEA-3038) as the single source of truth so the set isn't re-encoded per
 * consumer — the largest being `apps/api/app/agent-sessions/service/session-status-projection.ts`
 * and its desktop mirror, where only a NON-terminal run is exempt from the
 * awaiting-input classifiers below.
 */
export const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  SESSION_STATUS.INACTIVE,
  SESSION_STATUS.ERROR,
]);

/**
 * ISS-4998: the age past which a stored `active`/`waiting` status stops being
 * evidence that anything is running.
 *
 * Read side only. It mirrors `FALLBACK_STALE_SESSION_AGE_HOURS`, the write-side
 * cutoff the hourly `/cron/reconcile-stale-sessions` reaper uses
 * (`apps/api/app/agent-sessions/stale-session-reaper-service.ts`), because that
 * job IS the product's declared definition of "too old to still be running".
 * Duplicating the NUMBER rather than importing it is deliberate: this module is
 * runtime-neutral and consumed by the desktop renderer, which cannot reach an
 * `apps/api` service, and the reaper's own value is environment-overridable
 * (`STALE_SESSION_AGE_HOURS`) while a display threshold must be stable.
 *
 * The point is that the READ path had no cutoff at all: the Sessions list showed
 * whatever the column said, so a session the reaper had not yet swept — because
 * the cron missed, or the env value was raised — rendered a confident "Active"
 * 63 hours after its last activity (SES-78262). A display that depends on a
 * background job having run must degrade when it has not.
 *
 * Lives in THIS module rather than beside the copy that quotes it
 * (`SESSION_STALE_TOOLTIP` in `./session-status-display.ts`) because it is a
 * LOGIC constant: {@link isSessionDisplayStale} is the reason it exists, and the
 * sentence reads it so the number in the copy cannot drift from the cutoff that
 * produced the fold.
 */
export const STALE_SESSION_DISPLAY_THRESHOLD_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The status a session DISPLAYS.
 *
 * ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23/24) STOPPED THIS
 * PRODUCING any display-only word. Verbatim: "Unparsable status are already
 * converted to Active on import. Don't distinguish between active and stale",
 * then "let's drop waiting as well", then "We'll get rid of the whole
 * DISPLAYED_STATUS enum."
 *
 * Step 1 (#7820) narrowed the RETURN TYPE to {@link SessionStatus} while
 * retaining {@link DISPLAYED_SESSION_STATUS} itself, so every consumer branch
 * handling a display-only member became unreachable without a flag day. This
 * step removed those now-unreachable members from the enum and their branches
 * from every consumer. {@link DISPLAYED_SESSION_STATUS} still exists — deleting
 * the type itself, rather than just emptying it, is the one piece of the
 * ruling ("We'll get rid of the whole DISPLAYED_STATUS enum") left for a later
 * slice, since that touches every call site's import rather than its behavior.
 *
 * What went, and what replaced it:
 *
 *   • the `waiting` passthrough and projection. The awaiting-input FACT is
 *     untouched — it lives on `session_detail.awaitingInputSince`, which is
 *     still written and still read. Only the WORD is gone, including the
 *     renderer's own `resolveDisplayedSessionStatusWithWaiting` projection
 *     (`packages/app/agents/lib/session-displayed-status-with-waiting.ts`),
 *     which is now a thin alias of this function.
 *   • the staleness fold against {@link STALE_SESSION_DISPLAY_THRESHOLD_HOURS}.
 *     The threshold and {@link isSessionDisplayStale} SURVIVE: their other
 *     reader is the desktop collector
 *     (`apps/desktop/src/main/collectors/engine/data-revision.ts`), which
 *     classifies a wedged rebuild candidate with them. That is collector logic,
 *     not a render.
 *   • the unrecognized-value fold to `unknown`. An unreadable spelling now takes
 *     {@link normalizeSessionStatus}'s fail-open to `active`, which is also the
 *     version-skew compatibility path.
 *
 * The timestamp parameters are no longer read. They stay on the signature so
 * the many existing callers keep compiling unchanged; retiring them is a
 * separate, call-site-touching cleanup.
 */
export function resolveDisplayedSessionStatus(input: {
  status: string;
  lastActivityAt?: Date | string | null;
  startedAt?: Date | string | null;
  now?: Date;
}): SessionStatus {
  return normalizeSessionStatus(input.status);
}

/**
 * Whether `lastActivityAt` is older than the display staleness threshold.
 * Since ISS-10364 no render reads this — its one remaining reader is the
 * desktop collector (`data-revision.ts`), which classifies a wedged rebuild
 * candidate, not a badge.
 */
export function isSessionDisplayStale(
  lastActivityAt: Date | string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!lastActivityAt) {
    return false;
  }
  const timestamp =
    lastActivityAt instanceof Date ? lastActivityAt : new Date(lastActivityAt);
  const elapsedMs = now.getTime() - timestamp.getTime();
  if (!Number.isFinite(elapsedMs)) {
    return false;
  }
  return elapsedMs > STALE_SESSION_DISPLAY_THRESHOLD_HOURS * MS_PER_HOUR;
}

/**
 * ISS-5131: what a status asserts about whether the run is OVER — the only
 * lifecycle question a Duration measure needs to ask.
 *
 * Three answers, because "has not ended" and "we cannot tell" are different
 * claims, and collapsing them is how a finished session came to render a
 * duration that grew forever.
 */
export const SessionDurationLifecycle = {
  /** The run is over. Its span is bounded by its own end instant. */
  Ended: "ended",
  /** The run has been observed NOT to have ended. Its span reaches `now`. */
  Running: "running",
  /**
   * The status asserts nothing either way. Since ISS-10364 {@link foldSessionStatus}
   * only ever answers a lifecycle value, so this currently has no reachable
   * path through a STATUS — it is reached only by an absent status
   * ({@link resolveSessionDurationLifecycle}'s `status == null` guard) and kept
   * as the honest answer for a future unmodelled status, not re-derived from
   * one today.
   */
  Indeterminate: "indeterminate",
} as const;
export type SessionDurationLifecycle =
  (typeof SessionDurationLifecycle)[keyof typeof SessionDurationLifecycle];

/**
 * ISS-5131: THE one lifecycle classifier every Duration derivation asks, folded
 * through the same map the badges use ({@link CANONICAL_SESSION_STATUS_FOLD}) so
 * every surface resolves a status identically.
 *
 * ONE classifier is the whole point (whitlockk, #4409). Three hand-rolled copies of
 * "is this terminal" — one per surface, each spelling out literals — once put
 * `error` and its then-alias `failed` on OPPOSITE sides of the branch: the row
 * rendered a live, growing duration while the comparator sorted it with the
 * blanks. ISS-5592 removed that alias (and the boundary rewrite that produced
 * it), so the spellings can no longer diverge — but the single classifier is
 * what keeps a future one from doing the same. One classifier, three callers
 * (`packages/app/agents/lib/session-duration.ts`,
 * `apps/api/app/agent-sessions/service/session-display-sort.ts`,
 * `apps/desktop/src/main/session/session-working-set-sort.ts`), and that class of
 * split cannot recur.
 *
 * Input is lower-cased first: `status` is a free-form external column and a
 * version-skewed producer may send `"Error"`. An ABSENT status is
 * `Indeterminate` — no evidence is not evidence of running.
 */
export function resolveSessionDurationLifecycle(
  status: string | null | undefined
): SessionDurationLifecycle {
  if (status == null) {
    return SessionDurationLifecycle.Indeterminate;
  }
  const folded = foldSessionStatus(status.toLowerCase());
  if (folded === SESSION_STATUS.INACTIVE || folded === SESSION_STATUS.ERROR) {
    return SessionDurationLifecycle.Ended;
  }
  // `foldSessionStatus` only ever answers ACTIVE/INACTIVE/ERROR since
  // ISS-10364, so this covers every remaining case — including a value this
  // build does not recognize, which folds to ACTIVE.
  return SessionDurationLifecycle.Running;
}

/**
 * ISS-5981: does this build MODEL `status` — i.e. does the fold know what the
 * spelling means, rather than failing it open to {@link SESSION_STATUS.ACTIVE}?
 *
 * The fail-open is deliberate (an unmodelled value is not a terminal claim, so
 * the row stays live and the reaper decides), but it is still a coercion of a
 * value this build cannot interpret, and the root `AGENTS.md` rule on bad data
 * is that such a coercion is routed to a monitor rather than absorbed. This is
 * the predicate that lets the ingest count it — see
 * `SessionSyncMetric.UnmodelledStatusFolded`. Without it, a newer producer
 * introducing a status this build has never seen is silently recorded as
 * "running", and nothing anywhere reports the skew.
 *
 * Deliberately NOT `RECOGNIZED_SESSION_STATUS_VALUES.includes(...)`: that is an
 * O(n) scan over the same map, and `Object.hasOwn` is what keeps a caller-supplied
 * `__proto__`/`constructor` from resolving an inherited key.
 */
export function isRecognizedSessionStatus(
  status: string
): status is DisplayedSessionStatus {
  return Object.hasOwn(CANONICAL_SESSION_STATUS_FOLD, status);
}

/**
 * The DISPLAY member a stored `status` renders as. Since ISS-10364 this is a
 * pure alias of {@link normalizeDisplayedSessionStatus} — there is no longer a
 * display-only word to match ahead of the fold. Kept, rather than deleted and
 * its call sites repointed in this same diff, for the same reason
 * {@link normalizeDisplayedSessionStatus} is: every caller is typed against
 * {@link DisplayedSessionStatus} and reads as "fold an already-derived status
 * for display".
 *
 * Distinct from {@link resolveDisplayedSessionStatus}, which DERIVES a display
 * status from a raw row's status plus its timestamps. This takes a status that
 * has already been derived — what a `SessionTableRow` carries — and only decides
 * which display member it is.
 */
export function foldToDisplayedSessionStatus(
  status: string
): DisplayedSessionStatus {
  return normalizeDisplayedSessionStatus(status);
}

/*
 * ISS-12430 (operator ruling, 2026-10-13): no status derivation may read
 * `sessionEndedAt` or `endsWithError` to answer what a row DISPLAYS — status is
 * the single source of truth for display, as it is for storage. ISS-8488's
 * read-time reconciliation of a stored `active` carrying a recorded end lived
 * here; do not reintroduce it. The write-side fail-open in
 * {@link normalizeSessionStatus} is unaffected.
 *
 * The row count behind the ruling was taken on CLOUD Postgres only. No desktop
 * SQLite store was counted, and the desktop writers do treat `active` beside an
 * `endedAt` as a distinct state (`isLive`,
 * `apps/desktop/src/main/database/write-core-import-phases-session.ts`).
 *
 * Such a row is left to the stale-session reaper, which does NOT preserve the
 * producer's end: `reapCandidate`
 * (`apps/api/app/agent-sessions/stale-session-reaper-service.ts`) writes
 * `sessionEndedAt: lastActivityAt` unconditionally, which for this shape moves
 * the recorded end earlier. Until the reaper reaches it — up to the stale
 * cutoff — the row badges Active and its Duration counts to `now`.
 */
