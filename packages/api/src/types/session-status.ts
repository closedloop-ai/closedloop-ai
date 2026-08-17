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
 * is NOT kept in sync with this one by design — decided by Chris on 2026-08-14.
 * Desktop and web DO stay in sync, and both read this module.
 *
 * ## TWO vocabularies, deliberately (ISS-5592)
 *
 * {@link SESSION_STATUS} is the LIFECYCLE set — `active`, `inactive`, `error` —
 * and it is the whole set a row may STORE. Do not add a fourth member and do not
 * reintroduce a retired one.
 *
 * {@link DISPLAYED_SESSION_STATUS} is what a RENDER or a FILTER FACET speaks: the
 * lifecycle set plus three values no producer originates and no new code writes.
 * Reach for it only where the value is derived for presentation, never for a
 * write. The three:
 *
 *   • `waiting` — the awaiting-input sub-state, projected per read from the
 *     `session_detail.awaitingInputSince` timestamp, and the word the Status
 *     facet passes. It is NOT a lifecycle value, and since ISS-5981 no write
 *     path can store one: the cloud main ingest and the reopen arm (ISS-5974)
 *     both fold an incoming `waiting` to `active`, each preserving the
 *     `awaitingInputSince` anchor so the fold loses nothing. It is still
 *     ACCEPTED on the wire — that tolerance is a compatibility boundary — it is
 *     simply no longer STORED. Rows written before that landed were not
 *     backfilled and can still carry it, which is why reads stay tolerant.
 *   • `unknown` (ISS-4997) — this build cannot parse the stored string (version
 *     skew). It asserts nothing, which is the point: an unrecognized run may
 *     well still be running.
 *   • `stale` (ISS-4998) — the row stores `active` but has said nothing for
 *     longer than {@link STALE_SESSION_DISPLAY_THRESHOLD_HOURS}, so `active` is
 *     a stored value no longer backed by evidence. Kept DISTINCT from `unknown`
 *     (#4324): "we cannot parse this" is a gap in OUR vocabulary and tells the
 *     user nothing actionable, while "this run has been silent for over a day"
 *     is a checkable fact about THEIR session that the Last activity cell in the
 *     same row corroborates. Neither is terminal.
 *
 * Folding any of the three onto `active` restores exactly the conflation those
 * tickets removed.
 *
 * ISS-4654 RETIRED `completed` and `abandoned`, and ISS-5592 removed the last of
 * their tolerance. They are now ORDINARY UNRECOGNIZED VALUES: nothing labels,
 * sorts, filters or folds them, and an inbound one takes the fail-open branch to
 * `active` like any other spelling this build does not model. See the note above
 * {@link normalizeSessionStatus} for what that costs a version-skewed producer.
 *
 * `AgentSessionState` (`./agent-session.ts`) is a DIFFERENT axis, not this
 * vocabulary renamed — it carries members neither set has an equivalent for. See
 * the root `AGENTS.md`, "Session State".
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
 * What a RENDER or a FILTER FACET speaks: {@link SESSION_STATUS} plus the three
 * read-time derivations described in the file header.
 *
 * Spread from the lifecycle set rather than restating it, so the two vocabularies
 * cannot drift on the values they share.
 */
export const DISPLAYED_SESSION_STATUS = {
  ...SESSION_STATUS,
  WAITING: "waiting",
  UNKNOWN: "unknown",
  STALE: "stale",
} as const;

export type DisplayedSessionStatus =
  (typeof DISPLAYED_SESSION_STATUS)[keyof typeof DISPLAYED_SESSION_STATUS];

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
 */
const CANONICAL_SESSION_STATUS_FOLD: Record<
  DisplayedSessionStatus,
  DisplayedSessionStatus
> = {
  [SESSION_STATUS.ACTIVE]: SESSION_STATUS.ACTIVE,
  [SESSION_STATUS.INACTIVE]: SESSION_STATUS.INACTIVE,
  [SESSION_STATUS.ERROR]: SESSION_STATUS.ERROR,
  [DISPLAYED_SESSION_STATUS.WAITING]: SESSION_STATUS.ACTIVE,
  [DISPLAYED_SESSION_STATUS.UNKNOWN]: DISPLAYED_SESSION_STATUS.UNKNOWN,
  [DISPLAYED_SESSION_STATUS.STALE]: DISPLAYED_SESSION_STATUS.STALE,
};

/**
 * The DISPLAY-ONLY members: values {@link resolveDisplayedSessionStatus}
 * produces for a render, which no producer writes and nothing persists.
 *
 * {@link normalizeSessionStatus} deliberately does NOT recognize these, so a
 * consumer of the STORED fold never renders one — see the note on that
 * function.
 */
const DISPLAY_ONLY_SESSION_STATUSES: ReadonlySet<string> = new Set([
  DISPLAYED_SESSION_STATUS.UNKNOWN,
  DISPLAYED_SESSION_STATUS.STALE,
]);

/**
 * Whether a status is one of the DISPLAY-ONLY members
 * ({@link DISPLAYED_SESSION_STATUS.UNKNOWN}, {@link DISPLAYED_SESSION_STATUS.STALE}).
 *
 * Consumers need this because {@link normalizeSessionStatus} deliberately
 * fail-opens these to `active` (see its note), so a predicate written as
 * `normalizeDisplayedSessionStatus(x) === ACTIVE` would answer "yes, running"
 * for a row whose badge reads "Stale". Ask this FIRST wherever the question is
 * really "is this row displaying as live?".
 *
 * Narrows (ISS-5366) so a caller that guards on it can go straight to a
 * `Record<DisplayedSessionStatus, …>` — a label map, a rank — without a cast.
 * The set holds only {@link DISPLAYED_SESSION_STATUS} members, so the narrowing
 * is sound.
 */
export function isDisplayOnlySessionStatus(
  status: string
): status is DisplayOnlySessionStatus {
  return DISPLAY_ONLY_SESSION_STATUSES.has(status);
}

/*
 * ISS-5592: `RETIRED_SESSION_STATUS`, `RetiredSessionStatus`,
 * `RETIRED_SESSION_STATUS_FOLD` and `RETIRED_SESSION_STATUS_VALUES` are GONE,
 * and with them the whole `completed`/`abandoned` compatibility path. Removed on
 * Chris's explicit decision (2026-08-14) with the consequence accepted.
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
 * `NOT IN` over this list. The Status facet's UNKNOWN predicate
 * (`buildStatusFacetPredicate`) is the caller: an unrecognized status is by
 * definition unlistable, so the only way a query can reach those rows is by
 * excluding the recognized ones. Derived from the fold map rather than retyped,
 * so adding an alias there cannot leave the facet matching a value the display
 * has since learned to read.
 */
export const RECOGNIZED_SESSION_STATUS_VALUES: readonly string[] = Object.keys(
  CANONICAL_SESSION_STATUS_FOLD
);

/**
 * The display fold of a raw status string. An unrecognized value resolves to
 * {@link DISPLAYED_SESSION_STATUS.UNKNOWN} — it asserts nothing, rather than asserting the
 * most alarming thing in the vocabulary.
 *
 * `Object.hasOwn` rather than a bare index read: `status` is external input, so
 * a lookup on an object literal would otherwise resolve inherited keys
 * (`constructor`, `__proto__`) and return a non-status value.
 */
function foldSessionStatus(status: string): DisplayedSessionStatus {
  return Object.hasOwn(CANONICAL_SESSION_STATUS_FOLD, status)
    ? CANONICAL_SESSION_STATUS_FOLD[status as DisplayedSessionStatus]
    : DISPLAYED_SESSION_STATUS.UNKNOWN;
}

/**
 * ISS-4586: fold a status into the canonical ACTIVE / INACTIVE / ERROR
 * vocabulary. INACTIVE is the neutral "terminal, not failed" state — NOT a
 * success claim; there is no separate indeterminate terminal state in this
 * model.
 *
 * Every KNOWN alias is mapped EXPLICITLY (shafty023 P2) through
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
 * (wongk, #4324). `status` is a free-form external column, so a newer or older
 * producer genuinely can send that value, and consumers of this fold — the
 * Documents table row registry (`sessionStatusToIcon`/`sessionStatusToLabel`)
 * among them — are not display surfaces that handle the display-only members.
 * Recognizing the literal here would pair the label "Unknown" with the
 * in-progress icon, since `sessionStatusToIcon` has no UNKNOWN branch — a fresh
 * instance of the contradiction ISS-4997 exists to remove.
 *
 * So `"unknown"` takes the same fail-open branch as any other unrecognized
 * value here. Recognition of the display-only member happens at the ROW
 * DERIVATION ({@link resolveDisplayedSessionStatus}) and in the badge before it
 * normalizes.
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
 * ISS-4586: fold a DISPLAYED status to the display vocabulary — identical to
 * {@link normalizeSessionStatus} but PRESERVES `waiting`. `waiting` is not a
 * stored status; it is the awaiting-input sub-state of active that the Sessions
 * list projects (`projectDisplayedSessionStatus`) and renders as its own badge,
 * so display consumers (badge, status icon) must keep it distinct rather than
 * folding it into `active`. Everything else folds exactly as
 * {@link normalizeSessionStatus} does — read the table there rather than a copy
 * of it here — including the legacy fail-open default: an UNRECOGNIZED value
 * still folds to `active`, never a fabricated terminal outcome.
 *
 * This preserves a literal `waiting` and NOTHING else. In particular a stored
 * `unknown` or `stale` does NOT survive: both are keys of the canonical fold, so
 * they resolve through {@link normalizeSessionStatus} to `active` like any other
 * non-terminal display word. An earlier version of this note claimed `unknown`
 * "folds to ITSELF" (code review, #5156) — it does not, and reasoning from that
 * sentence would have you expect an Unknown badge from a path that cannot
 * produce one.
 *
 * {@link resolveDisplayedSessionStatus} is what actually derives `unknown` and
 * `stale`, and is what new display code should call.
 */
export function normalizeDisplayedSessionStatus(
  status: string
): DisplayedSessionStatus {
  if (status === DISPLAYED_SESSION_STATUS.WAITING) {
    return DISPLAYED_SESSION_STATUS.WAITING;
  }
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
 * set. All three read-time derivations land on ACTIVE, which is the fail-open
 * this fold has always applied — see the note on `normalizeSessionStatus` for
 * why `unknown` is deliberately not recognized as itself here.
 */
const LIFECYCLE_SESSION_STATUS_FOLD: Record<
  DisplayedSessionStatus,
  SessionStatus
> = {
  [SESSION_STATUS.ACTIVE]: SESSION_STATUS.ACTIVE,
  [SESSION_STATUS.INACTIVE]: SESSION_STATUS.INACTIVE,
  [SESSION_STATUS.ERROR]: SESSION_STATUS.ERROR,
  [DISPLAYED_SESSION_STATUS.WAITING]: SESSION_STATUS.ACTIVE,
  [DISPLAYED_SESSION_STATUS.UNKNOWN]: SESSION_STATUS.ACTIVE,
  [DISPLAYED_SESSION_STATUS.STALE]: SESSION_STATUS.ACTIVE,
};

/**
 * The subset of {@link SESSION_STATUS} values that are terminal: the run is over
 * or has failed, so it can never be genuinely "awaiting user input". Hoisted
 * here (FEA-3038) as the single source of truth so the set isn't re-encoded per
 * consumer — the largest being `toAgentSessionState`
 * (`apps/api/app/agent-sessions/service/projections.ts`), where only a
 * NON-terminal run can be PendingApproval.
 *
 * What that classifier does with a terminal status is deliberately NOT restated
 * here. It is a `Record<SessionStatus, …>` in that file, so it is exhaustive and
 * a new member fails `tsc` there; read it. This paragraph used to transcribe it
 * and went stale in three separate ways at once — it named `COMPLETED`,
 * `FAILED` and `ABANDONED` (spellings ISS-4654 retired), claimed `ABANDONED`
 * preserved its own `AgentSessionState` (that member is retired too — "nothing
 * can reach the state any more"), and described FEA-3551's PR rescue as live
 * when `prSignal` no longer feeds the branch at all. ISS-5592 asks explicitly
 * that the rescue not be cited as a live second axis; this is what citing it
 * looked like.
 */
export const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  SESSION_STATUS.INACTIVE,
  SESSION_STATUS.ERROR,
  // NOTE: UNKNOWN and STALE are deliberately NOT terminal. "We cannot say" and
  // "it has gone quiet" are not outcomes, and treating either as one would let
  // the awaiting-input overlay and the terminal-state classifiers invent a
  // finish that never happened.
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
 * ISS-4997 + ISS-4998: the ONE honest derivation of the status a session should
 * DISPLAY. Both tickets are the same defect — a status that fails OPEN to
 * "running" — so both are resolved here rather than at two call sites.
 *
 * Two ways a displayed `Active` can be a claim the data does not support:
 *   1. the raw value is not one this consumer recognizes (ISS-4997), and
 *   2. the raw value IS `active` but the session has been silent longer than
 *      {@link STALE_SESSION_DISPLAY_THRESHOLD_HOURS} (ISS-4998).
 *
 * They resolve to DIFFERENT values — {@link DISPLAYED_SESSION_STATUS.UNKNOWN} and
 * {@link DISPLAYED_SESSION_STATUS.STALE} respectively — because they are different facts
 * (#4324 review). Neither asserts liveness; only one of them says anything the
 * reader can act on. See the note on `DISPLAYED_SESSION_STATUS.STALE`.
 *
 * TWO statuses are deliberately exempt from the staleness fold:
 *
 * - A TERMINAL status — {@link TERMINAL_SESSION_STATUSES}, which is `inactive`
 *   and `error` and, since ISS-5592 retired the legacy pair, nothing else.
 *   Those are conclusions the session already reached, and age does not make a
 *   reached conclusion less true. Only a claim of liveness can expire.
 * - `waiting`. It looks like a liveness claim but it is not an inference at all:
 *   the cloud projects it from a durable stored fact (`awaitingInputSince` set,
 *   session not ended, status non-terminal — `projectDisplayedSessionStatus`).
 *   A run that asked for approval three days ago and got no answer genuinely IS
 *   still awaiting input; nothing about that is unknown, and "Unknown" would
 *   destroy the most actionable signal on the surface ("this one is blocked on
 *   you"). It would also manufacture a fresh contradiction of exactly the kind
 *   this batch exists to remove: the WAITING facet predicate keys on
 *   `awaitingInputSince` with no cutoff, so filtering Status = Waiting would
 *   return a full page of rows whose badges all read "Unknown".
 *
 * A pure derivation with no flag awareness. It applies BOTH folds together, and
 * they keep their DIFFERENT values: an unrecognized status reads "Unknown", a
 * long-silent `active` row reads "Stale". That is the shipped behavior since
 * ISS-5366 retired the `sessions-honest-unknown-states` gate that used to sit at
 * the call site. Do not restate this as one value — a facet option, a group-by
 * band, or a tooltip built off the wrong word is exactly the drift the split
 * above exists to prevent.
 *
 * The staleness clock reads `lastActivityAt ?? startedAt` — the SAME fallback
 * the write-side reaper uses (wongk, #4324). Reading only `lastActivityAt` left
 * a hole exactly where the bug lives: a row whose activity timestamp is null or
 * unparseable has no evidence of recent life at all, yet it would have skipped
 * the staleness fold and gone on reading "Active" forever. Falling back to the
 * start time means the two sides agree on which rows are too old, instead of
 * the display quietly exempting the least-evidenced rows on the surface.
 *
 * A caller with NEITHER timestamp still gets the unrecognized-status fold but
 * not the staleness fold: no timestamp at all is an absence of evidence, not
 * evidence of staleness.
 */
export function resolveDisplayedSessionStatus(input: {
  status: string;
  lastActivityAt?: Date | string | null;
  startedAt?: Date | string | null;
  now?: Date;
}): DisplayedSessionStatus {
  if (input.status === DISPLAYED_SESSION_STATUS.WAITING) {
    return DISPLAYED_SESSION_STATUS.WAITING;
  }
  const folded = foldSessionStatus(input.status);
  if (folded !== SESSION_STATUS.ACTIVE) {
    return folded;
  }
  // `??` alone would not be enough: a MALFORMED `lastActivityAt` is a non-null
  // string, so it would satisfy the coalesce and then fail to parse, silently
  // exempting the row. Resolve to the first PARSEABLE timestamp instead.
  const staleAnchor =
    toParsedTimestamp(input.lastActivityAt) ??
    toParsedTimestamp(input.startedAt);
  return isSessionDisplayStale(staleAnchor, input.now)
    ? DISPLAYED_SESSION_STATUS.STALE
    : folded;
}

/**
 * The first parseable reading of a timestamp field, or `null` when the value is
 * absent or unparseable. `null` is the honest representation of "no usable
 * timestamp" — it is never coerced into a date the data does not support.
 */
function toParsedTimestamp(
  value: Date | string | null | undefined
): Date | null {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Whether `lastActivityAt` is older than the display staleness threshold.
 * Exported so a surface that keeps the raw status (a tooltip, a detail row) can
 * explain WHY the status reads Unknown instead of restating the rule.
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
 * The DISPLAY-ONLY members of {@link SESSION_STATUS}: statuses the CLIENT
 * derives for presentation and no producer ever stores.
 *
 * Named (ISS-5366) so {@link isDisplayOnlySessionStatus} can narrow to it. Keep
 * in step with `DISPLAY_ONLY_SESSION_STATUSES`.
 */
export type DisplayOnlySessionStatus =
  | typeof DISPLAYED_SESSION_STATUS.UNKNOWN
  | typeof DISPLAYED_SESSION_STATUS.STALE;

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
   * The status asserts nothing either way — an unrecognized value, or a
   * stored-active row gone silent past the staleness cutoff that DISPLAYS as
   * Unknown. Measuring such a row to `now` would claim it is still running,
   * which is exactly what the reader is being told we do not know.
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
 * ONE classifier is the whole point (wongk, #4409). Three hand-rolled copies of
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
  if (
    folded === SESSION_STATUS.ACTIVE ||
    folded === DISPLAYED_SESSION_STATUS.WAITING
  ) {
    return SessionDurationLifecycle.Running;
  }
  // The two DISPLAY-ONLY members (`stale`, `unknown`) land here, as does any
  // value this build does not recognize.
  return SessionDurationLifecycle.Indeterminate;
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
export function isRecognizedSessionStatus(status: string): boolean {
  return Object.hasOwn(CANONICAL_SESSION_STATUS_FOLD, status);
}
