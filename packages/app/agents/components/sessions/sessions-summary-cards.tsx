"use client";

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import {
  resolveCanonicalMergedLocPerDollarLabel,
  resolveMergedLocPerDollarDetail,
  resolveMergedLocPerDollarHow,
  resolveMergedLocPerDollarLabel,
  resolveMergedLocPerDollarWhat,
} from "@repo/api/src/types/merged-loc-per-dollar-basis";
import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import { resolveLocPerDollar } from "@repo/api/src/utils/loc-per-dollar";
import { resolveSessionsListPerDollar } from "@repo/app/agents/lib/sessions-list-per-dollar";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { KPI_NOT_COMPUTED_REASON } from "@repo/app/insights/lib/kpi-no-comparison-copy";
import {
  partialStripCardClass,
  SummaryCardRow,
} from "@repo/app/shared/components/summary-card-row";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useMetricCardHideUnavailable } from "@repo/app/shared/feature-flags/use-metric-card-hide-unavailable";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import {
  SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY,
  SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { hiddenMetricCardIds } from "@repo/app/shared/lib/metric-card-hide-policy";
import { CardDensity } from "@repo/design-system/components/ui/card-density";
import type { SessionSummaryDeltas } from "../../lib/session-summary-deltas";
import {
  AlwaysAvailableCards,
  resolveAlwaysAvailableCardsLoading,
  resolveAlwaysAvailableSource,
} from "./sessions-always-available-cards";
import {
  DeliveryMetricCard,
  resolveDeliveryDeltaPlaceholder,
} from "./sessions-delivery-metric-card";
import { PRS_SHIPPED_METRIC_CARD_LABEL } from "./sessions-summary-card-labels";
import {
  areAllSummaryCardsHidden,
  isSummaryCardVisible,
  SESSIONS_SUMMARY_CARD_IDS,
  SessionsSummaryCardId,
} from "./sessions-summary-card-visibility";
import { SessionsSummaryCardsLoading } from "./sessions-summary-cards-loading";
import {
  deliveryComparableDeltas,
  deltaSlotProps,
} from "./sessions-summary-delta-slots";

/**
 * Sessions summary KPI cards. Hoisted into the shared `@repo/app` feature slice
 * (FEA-3937) so web (`apps/app` Sessions page) and the desktop renderer
 * (`SessionsView`) render ONE composite — mirroring `BranchesSummaryCards`.
 * Prop-driven (single fetch): the usage read is fetched ONCE by each surface's
 * parent (alongside the session list) and passed down, rather than each mount
 * owning its own `useAgentSessionUsage` query.
 *
 * Card set (FEA-4126 — reverts to FEA-3937's FIVE-card set): Sessions, Total
 * Tokens, Cost, PRs Shipped, LOC / $. History: FEA-3937 shipped these
 * five and MOVED `Median PR Size` onto the Branches bar (where it is scoped per
 * merged PR on a branch); FEA-3574 then RE-ADDED `Median PR Size` here, taking
 * the row to six, which wrapped to a second row at the desktop viewport and read
 * as broken. FEA-4126 reverses that re-add: `Median PR Size` is removed from the
 * Sessions bar and stays only on Branches. It must NOT be reintroduced here — a
 * regression guard in the tests asserts it is absent (this has regressed once).
 *
 * Per-card auth-state machine (FEA-3574). Each card is in one of three states;
 * the list/table beneath is NOT auth-gated — only the cards change:
 *
 * 1. **Always-available:** Sessions, Total Tokens, Cost. They ALWAYS show the
 *    real value and NEVER a sign-in CTA. Cloud-mode source topology (FEA-3574
 *    review, whitlockk; corrected by ISS-4429): the desktop swaps the delivery
 *    `usage` read to the cloud HTTP source in Cloud mode, and the TABLE beneath
 *    aggregates that same cloud population. So in Cloud mode these cards must
 *    reflect the CLOUD `usage` too — the SAME population the table shows — or
 *    they diverge (ISS-4429: local SQLite lacking the cloud sessions rendered
 *    `0` Sessions/Tokens/Cost while the cloud table showed hundreds of rows).
 *    The desktop still passes the LOCAL SQLite totals separately as
 *    `localUsage`/`isLocalError`, but they are now only a FALLBACK: they back
 *    these cards ONLY when the cloud delivery read has FAILED (`isError` with no
 *    cloud `usage` in hand), so a transient cloud read failure never blanks a
 *    metric SQLite can still compute — WITHOUT letting local totals override a
 *    healthy cloud read and re-introduce the steady-state divergence. Web and
 *    local mode omit `localUsage`, so the single-`usage` path is byte-identical.
 * 2. **Gated (cloud-only, ISS-7866):** PRs Shipped and LOC/$ (FEA-4126
 *    removed Median PR Size from this bar — it is not one of these cards), in
 *    EITHER of the two states a Connect GitHub ask answers: signed out, or
 *    signed in with `githubConnected === false`. Both withdraw the value and
 *    render the one `ConnectGitHubIndicator` in the caption slot — the same
 *    affordance, in the same slot, at the same height as Branches, the Insights
 *    grid and the Dashboard stats row.
 *
 *    Signed out this holds regardless of any `usage` values still in hand
 *    (whitlockk review): we can't see the cloud merged-PR layer these describe, so a
 *    stray value must never surface as a real number and "merged in range" must
 *    never caption a figure we can't vouch for. Signed-in-disconnected ranks
 *    below a value in hand instead, because a cloud value can outlive the grant
 *    that produced it.
 *
 *    History, because this reversed twice. FEA-3159 gave the ask to a modal and
 *    said this bar "intentionally diverges from Branches/Insights, which DO show
 *    a per-card connect CTA". FEA-4037 hoisted a SIGN-IN banner above the row.
 *    ISS-5958 standardized the CTAs that existed without making the surfaces
 *    offering one agree. The result was one user, one moment, two verbs: this
 *    strip said "Sign in" while the dashboard said "Sign up with GitHub" for the
 *    same wall. There is now one verb and one place it renders. The modal is
 *    untouched and still owns the proactive ask.
 * 3. **Empty, no CTA:** the same cloud-only cards when the metric is absent for
 *    a reason no ask would fix — out of range, offline, or a GitHub status we
 *    could not READ (`undefined`, never `false`). They render a neutral `—` with
 *    no CTA, so an unread connection never nags a connected user (ISS-5958).
 *
 * This mirrors the Available / gated / neutral-empty template the Branches list
 * card carried until ISS-9961 removed it, and since ISS-7866 answers the gated
 * state with the same affordance — there is no longer a sign-in CTA here that
 * Branches has no equivalent of.
 *
 * Layout: the web caller opts into `wrapBelow` (FEA-3865) so the fixed-width,
 * horizontally-scrolling strip wraps into a two-column grid below `md` — the
 * same breakpoint the sessions table beneath flips to a card list — instead of
 * forcing a phone to scroll sideways above an already-migrated table. The
 * desktop caller opts into the same `wrapBelow` (ISS-4787 follow-up retired its
 * private grid class) and passes `cardClassName` only for PRESENTATION — its
 * dashboard card carries no width, so the sizing decision below composes onto it
 * rather than deferring to it. FIVE cards lay out cleanly in a single row on the
 * responsive tiers the callers pass (FEA-4126 — six wrapped to a second row at
 * the desktop viewport; mind FEA-3985: a wrapping/grid layout, never a fixed
 * non-wrapping row).
 *
 * An `isError` load failure is NOT a placeholder: every value collapses to the
 * honest `—` sentinel WITHOUT the "Sample" badge (which means demo data pending
 * real wiring, not "we couldn't load this") and the Cost detail line drops. An
 * error is never the signed-out state, so it never routes a delivery card to the
 * sign-in CTA.
 *
 * FEA-4128 (re-scoped by ISS-4429): the local SQLite fallback source can hydrate
 * SEPARATELY from — and much slower than — the cloud-backed source. When the cloud
 * read has FAILED and the cards are therefore waiting on the LOCAL fallback (a
 * first-launch import mid-flight, or the local read still pending), the local usage
 * read resolves to a still-zero summary. Rendering that as a literal `0` is the UI
 * lying about state ("no usage") while the store is still filling.
 * `alwaysAvailableLoading` keeps the three always-available cards' frames intact
 * (label, info popover, and a reason caption) and skeletons ONLY their value slot —
 * not a bare grey slab that drops the label/info while the delivery siblings keep
 * theirs — so `0` is reserved for a confirmed-empty dataset. The wait caption is
 * honest about which wait it is: "Importing your history" ONLY when a genuine
 * first-launch import is in flight (`importInProgress`), otherwise a neutral
 * "Loading…" for a plain pending fallback read. This skeleton is SCOPED to the
 * cloud-failure fallback path: a HEALTHY cloud read paints its real values (the
 * cloud population the table shows) immediately and never skeletons behind a
 * background local import. It is also independent of the full-row `isLoading`
 * skeleton (the whole bar is pending, before any card frame).
 */

// ISS-4429 (design-bot review): the plain pending-fallback wait caption — the
// local read hasn't settled yet but NO import is running, so the card must not
// claim an import. A neutral "Loading…" instead of the import-specific line.
const LOADING_DETAIL = "Loading…";

export function SessionsSummaryCards({
  className,
  cardClassName,
  usage,
  localUsage,
  isLoading,
  alwaysAvailableLoading = false,
  transientRecovering = false,
  importInProgress = false,
  couldNotImportLabel = null,
  isError = false,
  isLocalError = false,
  wrapBelow = false,
  authenticated = true,
  githubConnected,
  githubConnect,
  costUnknownActive = false,
  deltas,
  hiddenCardIds,
}: {
  /** Layout for the card container (desktop passes its dashboard grid). */
  className?: string;
  /**
   * FEA-4217: the summary cards the reader has switched OFF in the toolbar's
   * Options menu, by {@link SessionsSummaryCardId}. Undefined — the flag-off
   * path and every host that does not offer the control — paints all five.
   */
  hiddenCardIds?: ReadonlySet<string>;
  /**
   * Per-card styling. Defaults to the row card sized for the container's layout
   * mode (`wrapBelow` → full-width-below-`md`, otherwise the fixed-width row).
   */
  cardClassName?: string;
  /** The fetched usage summary, or `undefined` while the parent's read is pending. */
  usage: AgentSessionUsageSummary | undefined;
  /**
   * FEA-3574 review (whitlockk); re-scoped by ISS-4429: the LOCAL SQLite totals for
   * the always-available cards (Sessions, Total Tokens, Cost), fed SEPARATELY from
   * the cloud-backed `usage`. These cards are now CLOUD-PRIMARY and this local
   * signal is a FAILURE FALLBACK ONLY — it backs the cards ONLY when the cloud
   * `usage` read has FAILED (`isError` with no cloud `usage` in hand). Whenever the
   * cloud read is healthy (any `usage`, or still loading), the CLOUD population
   * wins — the SAME population the table shows — so a populated local SQLite can
   * never override a healthy cloud read (that was the ISS-4429 divergence: local
   * SQLite lacking the cloud sessions blanked the cards to `0` while the cloud
   * table was full). On the fallback path, `isLocalError` dashes them if the local
   * read also failed. Omitted by web and local mode — then the always-available
   * cards read `usage`/`isError`, so the single-source path is byte-identical.
   */
  localUsage?: AgentSessionUsageSummary | undefined;
  /** Loading state from the parent's usage read. */
  isLoading: boolean;
  /**
   * FEA-4128 (re-scoped by ISS-4429): the LOCAL FALLBACK source is still hydrating
   * — skeleton JUST the Sessions/Tokens/Cost value slots, independent of the
   * full-row `isLoading`. This is scoped to the cloud-FAILURE fallback path: it is
   * honored ONLY when the cloud read has failed (no cloud `usage`) and the cards
   * are therefore waiting on the local fallback (a first-launch import mid-flight
   * or the local read pending). A HEALTHY cloud read paints its real values
   * immediately and ignores this — it never skeletons the cloud population behind a
   * background local import. Without it, a still-importing local summary's `0`
   * would render as a confirmed "no usage" on the fallback path. Reserves `0` for a
   * confirmed-empty local dataset. Defaults to `false`; the delivery cards keep
   * rendering their already-loaded `usage` values. Ignored when `isLoading` (the
   * whole bar is already skeletoned) or when the local read errored.
   */
  alwaysAvailableLoading?: boolean;
  /**
   * ISS-4483 (review cid 3679535439): the list read hit a TRANSIENT db-host error
   * (the local child restarting / crash-looping mid-backfill) with no last-good
   * `usage` in hand yet, and is auto-retrying. HOLD the always-available cards'
   * labels + info popovers and skeleton ONLY their value slots through that recover
   * window — the same value-only treatment as `alwaysAvailableLoading`, but on the
   * TRANSIENT-error path rather than the cloud-failure local-fallback path, so it is
   * NOT gated on the cloud read having failed (a Local-mode transient error has no
   * cloud read to fail). Without it the transient window would either dash the cards
   * or settle them to a confirmed `0`/`0`/`$0` (the lie the ticket flags). Defaults
   * to `false`; ignored when `isLoading` (the whole row is already skeletoned) or
   * once `usage` arrives (the caller drops it — the last-good value keeps rendering).
   */
  transientRecovering?: boolean;
  /**
   * ISS-4429 (design-bot review): is a GENUINE first-launch local import actively
   * populating the store, as opposed to the local fallback read merely being
   * pending? Only when this is true does the wait caption read "Importing your
   * history"; a plain pending fallback gets a neutral "Loading…" so the card never
   * explains an import to someone whose cloud totals simply failed to load. Scoped
   * to the same fallback window as `alwaysAvailableLoading` (both fire only on the
   * cloud-failure path); web/local mode leave it `false`.
   */
  importInProgress?: boolean;
  /**
   * ISS-4444: how many local transcripts the desktop boot import had to QUARANTINE
   * because their parse wedged repeatedly (a CPU-spinning parser on a poison
   * transcript). The boot import still COMPLETES with these skipped, so the cards
   * resolve to their real values rather than spinning forever — but the count is
   * surfaced (design review) as a subtle "N transcripts couldn't be read" caveat ON
   * the Sessions card's own detail line, so the honesty travels with the count it
   * qualifies instead of floating as a detached banner. Defaults to 0 (nothing
   * quarantined → no caveat, plain scope caption). Web mode leaves it null.
   *
   * ISS-6115 (whitlockk review): a ready-made PHRASE, not a count. The right verb
   * depends on which stage of the local import gave up — a wedged parse means
   * the transcript could not be read, an import stall means it was read and
   * could not be saved — and that stage is only known to the desktop adapter
   * that owns the ingest progress. Assembling the sentence here from a bare
   * count is what left this surface saying "couldn't be read" after the count
   * had stopped meaning that.
   */
  couldNotImportLabel?: string | null;
  /** Error state from the parent's usage read (values collapse to `—`, no badge). */
  isError?: boolean;
  /**
   * FEA-3574 review (whitlockk): error state of the SEPARATE local totals read that
   * backs the always-available cards. Defaults to `false`; ignored unless
   * `localUsage` semantics are in play (the desktop cloud-mode source split).
   */
  isLocalError?: boolean;
  /**
   * FEA-3865: wrap the fixed-width strip into a two-column grid below `md`
   * instead of scrolling it sideways. The web Sessions page opts in; the desktop
   * renderer keeps its own grid `className` and leaves this off.
   */
  wrapBelow?: boolean;
  /**
   * Does the surface have a durable cloud session? Signed out (`false`) gates
   * the cloud-only delivery cards behind the connect ask; signed in (`true`,
   * including authenticated-but-offline) leaves them to the neutral empty
   * unless `githubConnected` is a definite `false`. Defaults to `true` so the
   * web Sessions page, always inside an authenticated route, never gates on it.
   *
   * Desktop must resolve this with the TRANSIENT-AWARE predicate
   * (`isDesktopAuthSignedOut`), not a strict `status === "authenticated"`:
   * `resolveGitHubGateConnected` turns a `false` here into a hard "not
   * connected", so a strict read asserts a definite disconnect for the whole
   * sign-in handoff (ISS-7866).
   */
  authenticated?: boolean;
  /**
   * ISS-7869: does this account reach GitHub through EITHER source — an active
   * personal grant OR an org App installation? Resolved by each surface from
   * `resolveGitHubGateConnected`, so `undefined` means UNKNOWN (still loading,
   * or a failed read) and never "disconnected": an unread status must not put an
   * ask in front of a connected user.
   *
   * Only `false` routes the two delivery cards to their connect affordance, and
   * only when they have nothing to state anyway — see `DeliveryMetricCard`.
   */
  githubConnected?: boolean;
  /**
   * ISS-7869: surface-owned connect target for that affordance — an href on web
   * (native OAuth navigation), a handler on desktop (the connect IPC). Omitted
   * by a caller with no connect entry point, which degrades the affordance to
   * informational copy rather than a dead control.
   */
  githubConnect?: GitHubConnectTarget;
  /**
   * ISS-4481 (stage review): the active Cost facet selection is the Unknown /
   * missing-cost option, so every listed row renders "—" (no numeric cost). The
   * Cost tile's facet-scoped `apiEstimatedCost` sums that all-unknown cohort to a
   * finite 0 and would render a misleading "$0" next to a column of dashes — the
   * same fabricated-zero ISS-4418 fixed in the cell, one level up at the aggregate.
   * When true the Cost tile drops to its honest-empty "—" so the tile and the
   * column say the same thing. Defaults to `false`.
   */
  costUnknownActive?: boolean;
  /**
   * ISS-5315: period-over-period comparison for the always-available cards. Built
   * by `buildSessionSummaryDeltas`, which already declines to produce a delta
   * whenever the comparison would not be like-for-like.
   *
   * #4480: its PRESENCE is the host declaring "this surface compares periods",
   * and that is what earns the "No prior period" placeholder. Omitting it means
   * the host does not compare at all (ISS-6041: the desktop Sessions view in
   * LOCAL mode, whose SQLite producer has no prior-window read — in Cloud mode
   * it reads the same HTTP producer web does and supplies a delta object) — the
   * cards then render neither a chip nor a placeholder, rather than a permanent
   * "No prior period" implying a comparison that is never coming. Supplied but
   * with no entry for a card (an
   * unbounded range, a prior read that has not landed, a baseline too small to
   * divide by) IS what renders the placeholder, and that is the case the row's
   * layout is held stable across.
   */
  deltas?: SessionSummaryDeltas;
}) {
  // ISS-5271 (same `…Optional` reasoning): the never-loaded usage summary must
  // skeleton the value slots instead of rendering a fabricated `0`.
  // ISS-10667: read where this card swaps its own label; the RESOLVER leaves,
  // never the gate, so the basis fold stays the single owner of which arm wins.
  const resolveRatioLabel = useFeatureFlagEnabledOptional(
    ONE_LABEL_PER_METRIC_FLAG_KEY
  )
    ? resolveCanonicalMergedLocPerDollarLabel
    : resolveMergedLocPerDollarLabel;
  const honestLoadingEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY
  );
  // ISS-7845 (ISS-4779 closed-by-default, same `…Optional` reasoning): opt in to
  // the delivery pair dashing through the primitive's no-data treatment, the one
  // ISS-5401 already put the three cards beside them on. Resolved ONCE here and
  // passed to both, like `deliveryDeltaTreatment` below, so the pair cannot
  // half-adopt it and render the same absent value two ways.
  const deliveryNoDataEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY
  );
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill only
  // when this surface's own gate is on — PostHog on web, Labs on desktop.
  // Resolved for the delivery pair HERE rather than inside `DeliveryMetricCard`
  // so the treatment reaches every branch of that card, not just the one that
  // renders a chip: a card must not change delta family by changing render
  // state. It sits with the other flag reads, above the `isLoading` early
  // return, because a hook after a conditional return is a hook-order break.
  const deliveryDeltaTreatment = useMetricDeltaTreatment();
  const hideUnavailableMetricCards = useMetricCardHideUnavailable();
  // The stretching mode divides the row into one `1fr` track per card, so hiding
  // two of five inflated the survivors from ~208px to ~356px on the desktop
  // launch track and hiding four gave one card the whole 1099px — widths nobody
  // designed, holding an 11px label and a number. Falling back to the row's own
  // non-stretching card (`--summary-card-min`, never shrinks) leaves the freed
  // space empty instead, which is what the reader asked for by hiding a card.
  // The non-stretching width is COMPOSED onto the caller's class rather than
  // discarded by a `??`, because a host's `cardClassName` is presentational and
  // need not carry any width at all: desktop passes
  // `DASHBOARD_METRIC_CARD_CLASS_NAME` (`h-full` plus a title size), so a plain
  // `??` left its partial strip back in the stretching grid and the survivors
  // inflated on exactly the surface the numbers above were measured on. Only the
  // hidden case composes — a full strip keeps taking the caller's class verbatim
  // — and `cn` lets a caller that DOES declare its own width still win.
  const anyCardHidden = SESSIONS_SUMMARY_CARD_IDS.some((id) =>
    hiddenCardIds?.has(id)
  );
  // whitlockk review on #8082: this is `partialStripCardClass`, so it CALLS it
  // rather than re-deriving it. The inlined copy hardcoded `summaryCardClass(false)`
  // for the hidden case, which pins `--summary-card-min` at EVERY breakpoint — on
  // a `wrapBelow` row that is wider than the two-column track below `md`, so the
  // loading skeleton overflowed its own cell on a phone while the settled strip,
  // which already went through the helper, did not.
  const resolvedCardClassName = partialStripCardClass({
    anyCardHidden,
    cardClassName,
    wrapBelow,
  });

  // Every card hidden: render NOTHING, not an empty row. `SummaryCardRow` would
  // otherwise emit a zero-height div inside its host's `flex flex-col gap-*`,
  // leaving an unexplained band between the toolbar and the table — and, when
  // signed out, a sign-in banner sitting above no cards at all. The hosts read
  // the SAME helper to drop their padded wrapper, so the band does not simply
  // move up a level.
  if (areAllSummaryCardsHidden(hiddenCardIds)) {
    return null;
  }

  if (isLoading) {
    return (
      <SessionsSummaryCardsLoading
        cardClassName={resolvedCardClassName}
        className={className}
        hiddenCardIds={hiddenCardIds}
        loadingDetail={LOADING_DETAIL}
        locPerDollarLabel={resolveRatioLabel(undefined)}
        reservesDeltaSlot={deltas !== undefined}
        wrapBelow={wrapBelow}
      />
    );
  }

  // FEA-4037 — two independent decisions, kept separate (whitlockk review):
  //
  // 1. Is the surface SIGNED OUT? This is a data-honesty decision, NOT a layout
  //    one. When signed out, the two cloud-only delivery cards (PRs Shipped +
  //    LOC/$ — FEA-4126 removed Median PR Size) can't be trusted to
  //    describe merged-PR data we can't see, so they ALWAYS render the neutral
  //    dash with no scope caption — regardless of any `usage` values still in
  //    hand (a stale/local `usage` that happens to carry merged-PR numbers must
  //    not surface as a real value above a "sign in" ask). An error is
  //    authenticated-agnostic and is never the signed-out state, so a failed read
  //    routes to the "Unavailable" dim instead.
  const deliverySignedOut = !(authenticated || isError);
  //
  // 2. Where does the ask live? ON THE CARD (ISS-7869). FEA-4037 hoisted it into
  //    a single banner above the row; that made this the one GitHub-truth strip
  //    whose ask sat somewhere other than the card it unlocks, while Branches,
  //    the Insights grid and the Dashboard all put a compact affordance in the
  //    card's own caption slot. The hoist is gone and the per-card affordance
  //    FEA-4037 replaced is what renders again — same `GatedMetricIndicator`
  //    Card variant those three surfaces use, so the heights match theirs.
  //
  // ISS-7866: the delivery cards' connect ask for a user who IS signed in. The
  // signed-out case is excluded because it asks the same thing one branch
  // earlier, where it also outranks a value in hand; a failed read is its own
  // state. `=== false` is load-bearing: an UNKNOWN status must not ask.
  const deliveryGitHubDisconnected =
    !(deliverySignedOut || isError) && githubConnected === false;
  // The always-available cards skeleton their value while the local FALLBACK
  // source hydrates (unless it terminally errored — then they dash, not spin).
  // Mark the row `aria-busy` for that window so assistive tech announces the region
  // is updating rather than reading the skeletoned value slots as stable content
  // (whitlockk review). Mirrors `AlwaysAvailableCards`' own `cardsLoading` gate exactly
  // via the shared `resolveAlwaysAvailableCardsLoading` helper — ISS-4429 scoped the
  // skeleton to the cloud-failure fallback path (a healthy cloud read paints its
  // real values and never skeletons), so this gate must carry the same cloud-state
  // condition or the region would announce busy while the cards show real content.
  const alwaysAvailableCardsLoading = resolveAlwaysAvailableCardsLoading({
    alwaysAvailableLoading,
    transientRecovering,
    isError,
    isLocalError,
    usage,
    honestLoadingEnabled,
  });

  // FEA-4202 rollout gate, resolved ONCE for both delivery cards so the pair
  // cannot half-adopt the comparison. Flag-off this is `undefined` and the two
  // cards render exactly the ISS-5315 footer — no chip and no placeholder.
  const deliveryDeltas = deliveryComparableDeltas(deltas);
  const alwaysAvailableSource = resolveAlwaysAvailableSource({
    alwaysAvailableLoading,
    isError,
    isLocalError,
    localUsage,
    usage,
  });
  // ISS-10354: the card PUBLISHES its ratio. A completeness verdict over an
  // operand is a caveat, never grounds to withhold a number we hold both
  // operands for. What stood here refused whenever coverage was not `Complete`,
  // which on a real row rendered `Total estimated cost $37,927` beside
  // `PRs shipped 362` and `LOC / $ —`. That is not a state the world can be in:
  // if the dollars render and the merged work renders, the quotient is
  // arithmetic. One refused state (`MigrationPending`, "still being rebuilt")
  // can never clear either, because nothing rebuilds session costs (ISS-10353),
  // so the blackout was permanent rather than transient.
  const locPerDollarValue = resolveLocPerDollar(
    usage?.mergedLocPerDollar,
    usage?.mergedKlocPerDollar
  );
  // ISS-11117: the card's figure, label, caption, unit and both info sentences
  // resolved in ONE object, so a points number cannot reach the row under LOC's
  // words. The LOC arm's four strings still come from the basis fold that owns
  // them, resolved here and handed in.
  const perDollar = resolveSessionsListPerDollar(usage, {
    locValue: locPerDollarValue,
    locCopy: {
      label: resolveRatioLabel(usage?.mergedLocPerDollarBasis),
      detail: resolveMergedLocPerDollarDetail(usage?.mergedLocPerDollarBasis),
      what: resolveMergedLocPerDollarWhat(usage?.mergedLocPerDollarBasis),
      how: resolveMergedLocPerDollarHow(usage?.mergedLocPerDollarBasis),
    },
  });
  // Only the cards the reader still has ON are candidates. That keeps the
  // all-or-nothing rule measured against the row as it is actually painted, so
  // the gate can never take the last visible card: a strip is empty iff the
  // reader emptied it, which is the answer the hosts' own band guards already
  // hold (whitlockk review on #6914).
  // A card is not computable when it HAS NO NUMBER. That is the whole test.
  //
  // What stood here ran the question through five business-logic flags, so
  // "does this value exist" was answered by loading state, error state, and a
  // coverage verdict. Those are different questions: loading is not absent,
  // errored is not absent, and a coverage verdict is our own refusal rather
  // than a fact about the data. Routing them through this predicate is how a
  // value we declined to compute got hidden as though nobody had one.
  const gateHiddenCardIds = hiddenMetricCardIds({
    cards: [
      {
        id: SessionsSummaryCardId.Cost,
        notComputable:
          alwaysAvailableSource.alwaysAvailableUsage?.totalEstimatedCost ==
          null,
      },
      {
        id: SessionsSummaryCardId.PrsShipped,
        notComputable: usage?.mergedPrCount == null,
      },
      {
        id: SessionsSummaryCardId.LocPerDollar,
        notComputable: perDollar.value == null,
      },
    ].filter((card) => isSummaryCardVisible(card.id, hiddenCardIds)),
    enabled: hideUnavailableMetricCards,
  });
  const settledHiddenCardIds: ReadonlySet<string> = new Set([
    ...(hiddenCardIds ?? []),
    ...gateHiddenCardIds,
  ]);
  const settledCardClassName = partialStripCardClass({
    anyCardHidden: SESSIONS_SUMMARY_CARD_IDS.some((id) =>
      settledHiddenCardIds.has(id)
    ),
    cardClassName,
    wrapBelow,
  });
  const row = (
    <SummaryCardRow
      busy={alwaysAvailableCardsLoading}
      className={className}
      // ISS-10540: one density tier on both listing strips (see the row's
      // `density` prop); the Branches strip and both loading rows pin the same.
      density={CardDensity.Compact}
      wrapBelow={wrapBelow}
    >
      <AlwaysAvailableCards
        alwaysAvailableLoading={alwaysAvailableLoading}
        cardClassName={settledCardClassName}
        costUnknownActive={costUnknownActive}
        couldNotImportLabel={couldNotImportLabel}
        deltas={deltas}
        hiddenCardIds={settledHiddenCardIds}
        hideSettledEmptyCost={gateHiddenCardIds.has(SessionsSummaryCardId.Cost)}
        importInProgress={importInProgress}
        isError={isError}
        isLocalError={isLocalError}
        localUsage={localUsage}
        transientRecovering={transientRecovering}
        usage={usage}
      />
      {isSummaryCardVisible(
        SessionsSummaryCardId.PrsShipped,
        settledHiddenCardIds
      ) ? (
        <DeliveryMetricCard
          availableDetail="merged in range"
          cardClassName={settledCardClassName}
          deliveryNoDataEnabled={deliveryNoDataEnabled}
          deltaPlaceholder={resolveDeliveryDeltaPlaceholder(
            deliveryDeltas,
            undefined,
            honestLoadingEnabled
          )}
          deltaProps={deltaSlotProps(
            deliveryDeltas,
            "prsShipped",
            deliveryDeltaTreatment
          )}
          deltaTreatment={deliveryDeltaTreatment}
          formatValue={formatNumber}
          githubConnect={githubConnect}
          githubDisconnected={deliveryGitHubDisconnected}
          info={{
            what: "Pull requests merged from the matched sessions.",
            how: "Count of merged PRs linked to sessions in range.",
          }}
          isError={isError}
          label={PRS_SHIPPED_METRIC_CARD_LABEL}
          signedOut={deliverySignedOut}
          value={usage?.mergedPrCount}
        />
      ) : null}
      {/* FEA-4126: Median PR Size is intentionally NOT rendered here — it was
          removed from the Sessions bar (FEA-3937 layout, undoing FEA-3574's
          re-add) and lives only on the Branches bar, which reads its OWN
          `BranchAnalytics.medianPrSize` (not this field). The
          `usage.medianPrSize` field on the Sessions summary is now unread by any
          card and is kept only for wire compatibility (older clients/producers
          still send it) — do not repurpose it as a signal that the card belongs
          here. Do not reintroduce the card; a regression guard in the tests fails
          if this label returns to the Sessions bar. */}
      {isSummaryCardVisible(
        SessionsSummaryCardId.LocPerDollar,
        settledHiddenCardIds
      ) ? (
        <DeliveryMetricCard
          // ISS-4866 (review cid 3701359138): the caption names the POPULATION
          // this figure is measured over rather than restating the metric — the
          // word "merged" under the value spent a third of a 124px card on a
          // fact the card's own definition carries. (ISS-9964 / ISS-9980 retired
          // the "(Merged)" label variant that used to carry it in the label;
          // the caption's job is unchanged.) The same "… in range" shape
          // PRs Shipped uses one card to the left. NOT "per merged PR": this figure
          // is merged gross lines ÷ cost across the matched
          // SESSIONS, so a per-PR caption would misname its own denominator.
          // ISS-9978: the population claim is basis-dependent too, and reads
          // from the payload through the SAME fold as the two info sentences
          // and the label, so all four land on one arm. Absence and the stated
          // total-cost basis both resolve to the sentence above, so nothing
          // moves against any server deployed today.
          availableDetail={perDollar.detail}
          cardClassName={settledCardClassName}
          deliveryNoDataEnabled={deliveryNoDataEnabled}
          // FEA-4202: never compared — the prior window's spend is read too late in
          // the request to reach the delivery pass (ISS-6398 windowed the current
          // divisor; see `session-summary-deltas.ts`). It takes the ISS-4995 "not
          // computed" reason rather than the range-shaped default; otherwise the
          // tooltip would point at the range control, which cannot help here.
          // ISS-7422: the flag is threaded for symmetry with its rowmate, but the
          // reason argument is what decides — a never-computed comparison has no
          // pending state, so this card keeps its sentence through every read.
          deltaPlaceholder={resolveDeliveryDeltaPlaceholder(
            deliveryDeltas,
            KPI_NOT_COMPUTED_REASON,
            honestLoadingEnabled
          )}
          deltaTreatment={deliveryDeltaTreatment}
          formatValue={perDollar.format}
          githubConnect={githubConnect}
          githubDisconnected={deliveryGitHubDisconnected}
          info={{
            // ISS-9848: BOTH sentences read from the payload, not compiled in.
            // The cloud deploys ahead of installed Desktop builds, so a
            // hardcoded sentence describes whatever basis was current when the
            // CLIENT shipped. Absence resolves to the same two sentences this
            // card used to hard-code (every server that omits the field predates
            // it); an unrecognized basis coarsens BOTH — `what` named the
            // numerator and the unit ("Lines of code merged per dollar"), so
            // coarsening only `how` left the card still asserting a ratio the
            // response had declined to name (codex review on #6929). One
            // resolution, one arm, two sentences that cannot disagree.
            what: perDollar.info.what,
            how: perDollar.info.how,
          }}
          isError={isError}
          // ISS-4866: the merged-scope label, built FROM the shared unit constant so
          // the unit itself cannot drift away from the column that shares it. It
          // names the population this card actually computes (merged PRs only), so
          // the bare unit stops reading as "the efficiency of everything on this
          // row" beside the whole-cohort tiles.
          //
          // ISS-9978: and it is basis-dependent, through the same fold. That
          // label asserts the UNIT and the NUMERATOR, which is exactly what an
          // unrecognized basis declines to state — the card used to coarsen both
          // info sentences and then go on calling the figure LOC/$ in the
          // largest type on the tile. The info hint's accessible name is derived
          // from this label (`About {label}`), so it coarsens with it.
          label={perDollar.label}
          signedOut={deliverySignedOut}
          // ISS-4667: read through the shared skew resolver so a producer still on
          // the KLOC-unit field is scaled into LOC/$ rather than rendering ~0.00.
          value={perDollar.value}
        />
      ) : null}
    </SummaryCardRow>
  );

  // ISS-4444 (design review): the "N transcripts couldn't be read" caveat no longer
  // floats as a separate line above the row — a caveat detached from the number it
  // qualifies reads as a second banner and can contradict the import splash. It now
  // rides the Sessions card's own detail slot (see `AlwaysAvailableCards`), so the
  // honesty travels WITH the count it qualifies, in place. ISS-7869 applied the
  // same reasoning to the sign-in ask FEA-4037 had hoisted above the row: it
  // rides the card it unlocks now, so the strip is one element again.
  return row;
}

/**
 * The three always-available cards — Sessions, Total Tokens, Cost — extracted so
 * the source-resolution + FEA-4128 loading branch stay out of the main
 * component's complexity budget.
 *
 * ISS-4429: cloud-primary, local-fallback-only, so these cards aggregate the SAME
 * population the table shows and never read `0` while the table has cloud rows. The
 * canonical rationale (and the exact cloud-failure condition) lives on
 * `isCloudReadFailed` and `resolveAlwaysAvailableCardsLoading` below; the module
 * header covers the honest-caption and skeleton-scoping contract. Web and local
 * mode pass no local signal, so this resolves to the single `usage`/`isError` path
 * byte-for-byte.
 */
