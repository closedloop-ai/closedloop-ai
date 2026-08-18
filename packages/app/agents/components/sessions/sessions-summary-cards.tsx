"use client";

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import {
  LOC_PER_DOLLAR_MERGED_LABEL,
  resolveLocPerDollar,
} from "@repo/api/src/utils/loc-per-dollar";
import { KPI_NOT_COMPUTED_REASON } from "@repo/app/insights/lib/kpi-no-comparison-copy";
import {
  SummaryCardRow,
  summaryCardClass,
} from "@repo/app/shared/components/summary-card-row";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import {
  SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY,
  SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  formatLocPerDollar,
  formatNumber,
  formatTokenCount,
  KPI_NO_VALUE,
} from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionSummaryDeltas } from "../../lib/session-summary-deltas";
import {
  resolveCostCardPresentation,
  resolveCostTileSlots,
} from "./cost-card-presentation";
import { CostMetricCard } from "./cost-metric-card";
import {
  DeliveryMetricCard,
  resolveDeliveryDeltaPlaceholder,
} from "./sessions-delivery-metric-card";
import { SessionsSignInIndicator } from "./sessions-sign-in-indicator";
import {
  PRS_SHIPPED_METRIC_CARD_LABEL,
  SESSIONS_METRIC_CARD_LABEL,
  TOTAL_TOKENS_METRIC_CARD_LABEL,
} from "./sessions-summary-card-labels";
import { SessionsSummaryCardsLoading } from "./sessions-summary-cards-loading";
import {
  costDeltaKey,
  deliveryComparableDeltas,
  deltaSlotProps,
  resolveComparableDeltas,
  SUMMARY_NO_PRIOR_PERIOD,
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
 *    review, wongk; corrected by ISS-4429): the desktop swaps the delivery
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
 * 2. **Signed-out empty (cloud-only, requires auth):** PRs Shipped and LOC/$
 *    (Merged) / $ (FEA-4126 removed Median PR Size from this bar — it is not one
 *    of these cards). When signed out (`authenticated === false`) they
 *    ALWAYS render a neutral `—` with NO scope caption — regardless of any
 *    `usage` values still in hand (wongk review): signed out we can't see the
 *    cloud merged-PR layer these describe, so a stray value must never surface as
 *    a real number, and "merged in range" must never caption a dash we can't
 *    vouch for. The ask is hoisted into a SINGLE sign-in prompt
 *    (`SessionsSignInIndicator` banner) rendered ONCE above the row (FEA-4037) —
 *    one ask per surface, not the same sentence-plus-button on three cards; it
 *    also removes the `h-full` height coupling where a per-card CTA (icon + two
 *    lines + a button) dragged its single-number neighbours up. The banner needs
 *    a live `onSignIn` AND that the shell isn't already showing the ask
 *    (`signInPromptSuppressed`); when either fails, the cards keep the
 *    informational per-card copy (there is no single ask to hoist).
 * 3. **Signed-in empty (no data, NO CTA):** the same cloud-only cards when
 *    authenticated but the metric is unavailable — out of range, offline, or
 *    GitHub not connected. They render a neutral `—` with NO CTA, so they never
 *    look like the signed-out state (signing in wouldn't help). Per FEA-3159,
 *    the authenticated-but-GitHub-not-connected case stays here in state 3 —
 *    this bar does NOT render a per-card "Connect GitHub" affordance; that
 *    proactive ask is owned by FEA-3159's modal alone (this intentionally
 *    diverges from Branches/Insights, which DO show a per-card connect CTA).
 *
 * This mirrors `BranchKpiCard`'s Available / gated / neutral-empty template,
 * except the gated affordance is a **sign-in** CTA (not Connect-GitHub) and the
 * GitHub-not-connected case deliberately lands in neutral-empty rather than a
 * connect CTA.
 *
 * Layout: the web caller opts into `wrapBelow` (FEA-3865) so the fixed-width,
 * horizontally-scrolling strip wraps into a two-column grid below `md` — the
 * same breakpoint the sessions table beneath flips to a card list — instead of
 * forcing a phone to scroll sideways above an already-migrated table. The
 * desktop caller passes its own dashboard `className`/`cardClassName` grid and
 * leaves `wrapBelow` off. FIVE cards lay out cleanly in a single row on the
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

// FEA-4128 review (design-critic): the reason caption shown in the three always-
// available cards' detail slot while their local source hydrates BECAUSE a genuine
// first-launch import is in flight, so a card that is skeletoning its value says
// WHY it's blank instead of only shimmering.
const IMPORTING_HISTORY_DETAIL = "Importing your history";
// ISS-4429 (design-bot review): the plain pending-fallback wait caption — the
// local read hasn't settled yet but NO import is running, so the card must not
// claim an import. A neutral "Loading…" instead of the import-specific line.
const LOADING_DETAIL = "Loading…";
// ISS-4429 (design-bot review): the settled source caption for the always-
// available cards when they are showing the LOCAL fallback totals (the cloud read
// failed). The three cards then describe a DIFFERENT population than the cloud
// rows the table paints, so the caption names the source — a number that
// disagrees with the rows reads as a deliberate degraded read, not a broken one.
// Mirrors the `ReadSource.Fallback` provenance vocabulary the toolbar badge uses.
const LOCAL_FALLBACK_DETAIL = "From local history";

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
  onSignIn,
  signInError,
  signInPromptSuppressed = false,
  costUnknownActive = false,
  deltas,
}: {
  /** Layout for the card container (desktop passes its dashboard grid). */
  className?: string;
  /**
   * Per-card styling. Defaults to the row card sized for the container's layout
   * mode (`wrapBelow` → full-width-below-`md`, otherwise the fixed-width row).
   */
  cardClassName?: string;
  /** The fetched usage summary, or `undefined` while the parent's read is pending. */
  usage: AgentSessionUsageSummary | undefined;
  /**
   * FEA-3574 review (wongk); re-scoped by ISS-4429: the LOCAL SQLite totals for
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
   * ISS-6115 (wongk review): a ready-made PHRASE, not a count. The right verb
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
   * FEA-3574 review (wongk): error state of the SEPARATE local totals read that
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
   * FEA-3574: does the surface have a durable cloud session? Drives the
   * cloud-only delivery cards' empty state — signed out (`false`) shows a
   * sign-in CTA (state 2); signed in (`true`, incl. authenticated-but-offline /
   * GitHub-not-connected) shows a neutral empty with NO CTA (state 3). Defaults
   * to `true` so the web Sessions page (always inside an authenticated route)
   * never shows the CTA.
   */
  authenticated?: boolean;
  /**
   * FEA-3574: surface-owned sign-in action for the signed-out (state 2) delivery
   * cards. When provided the CTA becomes a live button (desktop passes its
   * browser-OAuth `beginSignIn` IPC); when omitted the affordance degrades to
   * informational copy only.
   */
  onSignIn?: () => void;
  /**
   * FEA-3574 review: retryable error copy from the last failed `beginSignIn`
   * attempt. Rendered on the signed-out (state 2) delivery cards below the
   * sign-in copy so a browser-OAuth failure (start/open/redirect/exchange)
   * surfaces with the CTA as the retry, instead of leaving the card unchanged.
   */
  signInError?: string | null;
  /**
   * FEA-4037 (P2 review): the shell already owns the sign-in ask, so suppress the
   * hoisted banner here even when signed out — the delivery cards still fall to
   * their neutral dash, but no second prompt is stacked. The desktop sets this on
   * `RefreshFailed`, where the app-level `DesktopSessionExpiredBanner` is already
   * up globally. Defaults to `false` (the plain `SignedOut` case still hoists).
   */
  signInPromptSuppressed?: boolean;
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
  // ISS-4773: read here too (same `…Optional` reasoning as above) because the
  // LOC / $ card's info copy asserts its divisor matches the Cost card's
  // headline, and this flag is what breaks that. Only the COPY is gated on it;
  // the divisor itself is unchanged. `AlwaysAvailableCards` reads the same key
  // for the Cost card's own presentation — one flag, two captions that must not
  // contradict each other.
  const costHonestyEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY
  );
  // ISS-5271 (same `…Optional` reasoning): the never-loaded usage summary must
  // skeleton the value slots instead of rendering a fabricated `0`.
  const honestLoadingEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY
  );
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill only
  // when this surface's own gate is on — PostHog on web, Labs on desktop.
  // Resolved for the delivery pair HERE rather than inside `DeliveryMetricCard`
  // so the treatment reaches every branch of that card, not just the one that
  // renders a chip: a card must not change delta family by changing render
  // state. It sits with the other flag reads, above the `isLoading` early
  // return, because a hook after a conditional return is a hook-order break.
  const deliveryDeltaTreatment = useMetricDeltaTreatment();
  const resolvedCardClassName = cardClassName ?? summaryCardClass(wrapBelow);

  if (isLoading) {
    return (
      <SessionsSummaryCardsLoading
        cardClassName={resolvedCardClassName}
        className={className}
        loadingDetail={LOADING_DETAIL}
        locPerDollarLabel={LOC_PER_DOLLAR_MERGED_LABEL}
        reservesDeltaSlot={deltas !== undefined}
        wrapBelow={wrapBelow}
      />
    );
  }

  // FEA-4037 — two independent decisions, kept separate (wongk review):
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
  // 2. Do we HOIST the single banner here? Only when signed out, the surface owns
  //    a live sign-in action, AND the shell isn't already showing the ask
  //    (`signInPromptSuppressed` — the desktop sets it on `RefreshFailed`, where
  //    the app-level session-expired banner already owns the prompt, so we don't
  //    stack a second one). When the banner IS hoisted, the per-card CTA/error is
  //    dropped so the ask lives in exactly one place; when it's suppressed OR
  //    there's no handler, the cards keep their per-card sign-in affordance. Web
  //    is always authenticated, so nothing hoists and it renders byte-identically.
  const showSignInPrompt =
    deliverySignedOut && onSignIn !== undefined && !signInPromptSuppressed;
  // Drop the per-card affordance when the ask lives elsewhere: either this
  // surface hoisted the single banner above the row, OR the shell already owns
  // the ask (`signInPromptSuppressed`, e.g. desktop `RefreshFailed` under the
  // app-level session-expired banner) — in both cases the delivery cards are
  // caption-less neutral dashes. Otherwise the signed-out cards render their own
  // per-card `SessionsSignInIndicator` (a live CTA with `onSignIn`, else the
  // informational-copy degrade when there is no ask to hoist).
  const perCardIndicatorSuppressed = showSignInPrompt || signInPromptSuppressed;
  // The always-available cards skeleton their value while the local FALLBACK
  // source hydrates (unless it terminally errored — then they dash, not spin).
  // Mark the row `aria-busy` for that window so assistive tech announces the region
  // is updating rather than reading the skeletoned value slots as stable content
  // (wongk review). Mirrors `AlwaysAvailableCards`' own `cardsLoading` gate exactly
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
  const row = (
    <SummaryCardRow
      busy={alwaysAvailableCardsLoading}
      className={className}
      wrapBelow={wrapBelow}
    >
      <AlwaysAvailableCards
        alwaysAvailableLoading={alwaysAvailableLoading}
        cardClassName={resolvedCardClassName}
        costUnknownActive={costUnknownActive}
        couldNotImportLabel={couldNotImportLabel}
        deltas={deltas}
        importInProgress={importInProgress}
        isError={isError}
        isLocalError={isLocalError}
        localUsage={localUsage}
        transientRecovering={transientRecovering}
        usage={usage}
      />
      <DeliveryMetricCard
        availableDetail="merged in range"
        cardClassName={resolvedCardClassName}
        deltaPlaceholder={resolveDeliveryDeltaPlaceholder(deliveryDeltas)}
        deltaProps={deltaSlotProps(
          deliveryDeltas,
          "prsShipped",
          deliveryDeltaTreatment
        )}
        deltaTreatment={deliveryDeltaTreatment}
        formatValue={formatNumber}
        info={{
          what: "Pull requests merged from the matched sessions.",
          how: "Count of merged PRs linked to sessions in range.",
        }}
        isError={isError}
        label={PRS_SHIPPED_METRIC_CARD_LABEL}
        onSignIn={onSignIn}
        perCardIndicatorSuppressed={perCardIndicatorSuppressed}
        signedOut={deliverySignedOut}
        signInError={signInError}
        value={usage?.mergedPrCount}
      />
      {/* FEA-4126: Median PR Size is intentionally NOT rendered here — it was
          removed from the Sessions bar (FEA-3937 layout, undoing FEA-3574's
          re-add) and lives only on the Branches bar, which reads its OWN
          `BranchAnalytics.medianPrSize` (not this field). The
          `usage.medianPrSize` field on the Sessions summary is now unread by any
          card and is kept only for wire compatibility (older clients/producers
          still send it) — do not repurpose it as a signal that the card belongs
          here. Do not reintroduce the card; a regression guard in the tests fails
          if this label returns to the Sessions bar. */}
      <DeliveryMetricCard
        // ISS-4866 (review cid 3701359138): the label already carries "(Merged)",
        // so repeating "merged" in the caption directly under the value spent a
        // third of a 124px card re-saying one word. The caption names the
        // population it is measured over instead — the same "… in range" shape
        // PRs Shipped uses one card to the left. NOT "per merged PR": this figure
        // is merged gross lines ÷ cost across the matched
        // SESSIONS, so a per-PR caption would misname its own denominator.
        availableDetail="across sessions in range"
        cardClassName={resolvedCardClassName}
        // FEA-4202: never compared — the prior window's spend is read too late in
        // the request to reach the delivery pass (ISS-6398 windowed the current
        // divisor; see `session-summary-deltas.ts`). It takes the ISS-4995 "not
        // computed" reason rather than the range-shaped default; otherwise the
        // tooltip would point at the range control, which cannot help here.
        deltaPlaceholder={resolveDeliveryDeltaPlaceholder(
          deliveryDeltas,
          KPI_NOT_COMPUTED_REASON
        )}
        deltaTreatment={deliveryDeltaTreatment}
        formatValue={formatLocPerDollar}
        // ISS-4773 (stage review x2 + wongk): the "same figure the Cost card
        // shows" clause is only true while that card sums `apiEstimatedCost`.
        // With honesty ON the Cost headline drops to `meteredEstimatedCost`
        // while this card keeps dividing by the broader non-subscription bucket
        // (`delivery-metrics.ts` feeds `mergedLocPerDollar` off it) — two cards
        // in one strip on different bases, one of them announcing they match, so
        // a reader multiplying LOC/$ by the headline cannot recover merged lines.
        //
        // The flag-ON copy NAMES ITS OWN DIVISOR instead of pointing at a
        // neighbour. Deliberately it does not mention the Cost card at all: the
        // honest presentation ALSO requires a producer that actually sent the
        // split, so on a version-skewed payload that card still reads
        // "cost" and copy naming an "API-billed Cost" card
        // would describe a tile that is not on screen. Naming only this card's
        // own denominator is true in both cases, which is why the gate can be
        // the flag alone and not the resolved presentation.
        info={{
          what: "Lines of code merged per dollar, output efficiency. Higher is better.",
          how: costHonestyEnabled
            ? "Merged gross lines divided by cost across matched sessions — confirmed API-billed spend plus usage whose billing could not be determined."
            : "Merged gross lines divided by cost across matched sessions, the same figure the Cost card shows.",
        }}
        isError={isError}
        // ISS-4866: the merged-scope label, built FROM the shared unit constant so
        // the unit itself cannot drift away from the column that shares it. It
        // names the population this card actually computes (merged PRs only), so
        // the bare unit stops reading as "the efficiency of everything on this
        // row" beside the whole-cohort tiles.
        label={LOC_PER_DOLLAR_MERGED_LABEL}
        onSignIn={onSignIn}
        perCardIndicatorSuppressed={perCardIndicatorSuppressed}
        signedOut={deliverySignedOut}
        signInError={signInError}
        // ISS-4667: read through the shared skew resolver so a producer still on
        // the KLOC-unit field is scaled into LOC/$ rather than rendering ~0.00.
        value={resolveLocPerDollar(
          usage?.mergedLocPerDollar,
          usage?.mergedKlocPerDollar
        )}
      />
    </SummaryCardRow>
  );

  // ISS-4444 (design review): the "N transcripts couldn't be read" caveat no longer
  // floats as a separate line above the row — a caveat detached from the number it
  // qualifies reads as a second banner and can contradict the import splash. It now
  // rides the Sessions card's own detail slot (see `AlwaysAvailableCards`), so the
  // honesty travels WITH the count it qualifies, in place.
  if (showSignInPrompt) {
    // The single sign-in ask (FEA-4037) sits above the row. gap-3 matches the
    // desktop parent's block rhythm (coaching tips → this bar → row) so the
    // stacking isn't looser than its surroundings.
    return (
      <div className="flex flex-col gap-3">
        <SessionsSignInIndicator
          banner
          onSignIn={onSignIn}
          signInError={signInError}
        />
        {row}
      </div>
    );
  }

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
function AlwaysAvailableCards({
  usage,
  localUsage,
  isError,
  isLocalError,
  alwaysAvailableLoading,
  transientRecovering,
  importInProgress,
  couldNotImportLabel,
  cardClassName,
  costUnknownActive,
  deltas,
}: {
  usage: AgentSessionUsageSummary | undefined;
  localUsage: AgentSessionUsageSummary | undefined;
  isError: boolean;
  isLocalError: boolean;
  alwaysAvailableLoading: boolean;
  transientRecovering: boolean;
  importInProgress: boolean;
  couldNotImportLabel: string | null;
  cardClassName: string;
  /**
   * ISS-4481: the active Cost facet is Unknown, so the Cost tile renders its
   * honest-empty "—" instead of summing an all-unknown cohort to a fabricated
   * "$0" (stage review).
   */
  costUnknownActive: boolean;
  /** ISS-5315 — see the public prop's docblock. */
  deltas: SessionSummaryDeltas | undefined;
}) {
  // ISS-4429 (source resolution): cloud-primary, local-fallback-only. The canonical
  // explanation of WHY — and the exact "cloud read failed with nothing to show"
  // condition — lives on `isCloudReadFailed` below; this is just the wiring.
  // `localFallbackAvailable` is false in web/local mode (no local signal passed), so
  // this resolves to the plain `usage`/`isError` path byte-for-byte there.
  // ISS-4773 (ISS-4779 closed-by-default): ON ⇒ the Cost card reports only spend
  // it can stand behind — see `resolveCostCardPresentation`.
  // `…Optional` (not the throwing variant): this is a SHARED component with mount
  // sites that have no FeatureFlagAdapterProvider (Storybook, mini-table tests).
  // The gate is purely additive, so resolving to OFF there is correct; throwing
  // would take the whole subtree down.
  const costHonestyEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY
  );
  // ISS-5271 (same `…Optional` reasoning): read here too so this component's
  // own `cardsLoading` cannot drift from the parent row's `aria-busy` gate —
  // both feed `resolveAlwaysAvailableCardsLoading` with the same flag state.
  const honestLoadingEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY
  );
  const localFallbackAvailable = localUsage !== undefined || isLocalError;
  const onCloudFailurePath = isCloudReadFailed(isError, usage);
  const useLocalFallback = localFallbackAvailable && onCloudFailurePath;
  // The fallback (and its loading skeleton) engages ONLY on the cloud-failure path
  // (`isCloudReadFailed`): a healthy cloud read shows the cloud population — the same
  // one the table paints — immediately, so a background local import never skeletons
  // over a populated cloud card.
  const localFallbackPending = alwaysAvailableLoading && onCloudFailurePath;
  const onLocalFallbackPath = useLocalFallback || localFallbackPending;
  const alwaysAvailableUsage = onLocalFallbackPath ? localUsage : usage;
  const costPresentation = resolveCostCardPresentation(
    costHonestyEnabled,
    alwaysAvailableUsage
  );
  const alwaysAvailableError = onLocalFallbackPath ? isLocalError : isError;
  // FEA-4128 review (design-critic): while the local FALLBACK source hydrates
  // (cloud read failed and we are waiting on local), keep each card's frame —
  // label, info popover, and a reason caption — and skeleton ONLY the value (the
  // MetricCard `loading` prop), instead of replacing the card with a bare grey slab
  // that drops the label and info while its delivery siblings keep theirs. The card
  // carries its own height, so no magic-number placeholder can drift from it. A
  // failed local read outranks loading (dash to `—`). ISS-4429: the skeleton is
  // scoped to the fallback path — a healthy cloud read paints its real values and
  // never skeletons over them while a background local import runs. Shared with the
  // parent row's `aria-busy` gate via `resolveAlwaysAvailableCardsLoading` so the
  // two cannot drift.
  const cardsLoading = resolveAlwaysAvailableCardsLoading({
    alwaysAvailableLoading,
    transientRecovering,
    isError,
    isLocalError,
    usage,
    honestLoadingEnabled,
  });
  // ISS-4429 (design-bot review): are the SETTLED cards showing the LOCAL fallback
  // totals (cloud read failed, local data in hand and not loading)? Then their
  // numbers describe a different population than the cloud rows, so caption them
  // with the source instead of the "matched by the current filters" scope claim.
  const showingLocalFallback = useLocalFallback && !cardsLoading;
  // The wait caption: only a genuine in-flight import earns the "Importing your
  // history" line; a plain pending-fallback read gets a neutral "Loading…".
  const loadingDetail = importInProgress
    ? IMPORTING_HISTORY_DETAIL
    : LOADING_DETAIL;
  const totalTokens =
    (alwaysAvailableUsage?.totalInputTokens ?? 0) +
    (alwaysAvailableUsage?.totalOutputTokens ?? 0);
  // ISS-5315: a delta is only shown when the value beside it is the settled
  // cloud figure the prior-period read was computed against. While the cards are
  // loading, errored, or painting the LOCAL fallback totals, the two aggregates
  // describe different populations — so the chip drops back to the
  // "No prior period" placeholder rather than grading a mismatch.
  const comparableDeltas = resolveComparableDeltas(deltas, {
    cardsLoading,
    errored: alwaysAvailableError,
    showingLocalFallback,
  });
  const costSlots = resolveCostTileSlots({
    cardsLoading,
    costPresentation,
    costUnknownActive,
    errored: alwaysAvailableError,
    loadingDetail,
    localFallbackDetail: LOCAL_FALLBACK_DETAIL,
    showingLocalFallback,
    usage: alwaysAvailableUsage,
  });
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill only
  // when this surface's own gate is on — PostHog on web, Labs on desktop.
  // Threaded through `deltaSlotProps` rather than passed card-by-card: the bag
  // each card already spreads is the one place a card cannot be wired without
  // it, which is what stopped Sessions and Total Tokens silently keeping the
  // `Legacy` default while the Cost card beside them rendered the unified pill.
  const deltaTreatment = useMetricDeltaTreatment();
  const sessionsDeltaProps = deltaSlotProps(
    comparableDeltas,
    "sessions",
    deltaTreatment
  );
  const tokensDeltaProps = deltaSlotProps(
    comparableDeltas,
    "tokens",
    deltaTreatment
  );
  // #4480: Cost carries a chip too — it is the card where a period comparison is
  // most obviously useful, and leaving it out left the strip's bottom edge
  // ragged beside the two that had one. The BASIS has to match the headline,
  // which `resolveCostCardPresentation` may resolve to either the metered or the
  // API figure, so the card reads the entry for the basis it actually rendered
  // rather than one this component picked.
  // ISS-5401: and no chip at all once the headline dashed — `deltaSlotProps`
  // returns the empty slot, so `MetricCard` falls through to the placeholder
  // rather than grading a movement in a value the card just refused to state.
  // ISS-5842 (follow-up, review on #4907): `CostMetricCard` now DECLARES
  // `deltaTreatment`, so the value in this bag actually reaches it. Until that
  // review it did not, and the bag's copy was silently dropped on the spread —
  // the card rendered correctly only because it resolved the same flag itself.
  // Two sources agreeing by coincidence is not one source; this is now one.
  const costDeltaProps = deltaSlotProps(
    costSlots.dashed ? undefined : comparableDeltas,
    costDeltaKey(costPresentation),
    deltaTreatment
  );
  // ISS-5315: the placeholder is only honest on a surface that actually
  // compares periods. `deltas` being present IS that declaration — a host that
  // never computes a comparison passes nothing and keeps the chip-free footer
  // instead of a permanent "No prior period". ISS-6041: that host is no longer
  // "desktop" wholesale, only desktop in LOCAL mode, whose SQLite producer has no
  // prior-window read; in Cloud mode desktop reads the same HTTP producer web
  // does and passes a delta object like web.
  const noPriorPeriod = comparableDeltas ? SUMMARY_NO_PRIOR_PERIOD : undefined;
  // ISS-5401 (design review): a DASHED tile drops the slot entirely rather than
  // borrowing that wording. Its prior period exists and its delta was computed —
  // the card declined to grade it for want of a current value — so "No prior
  // period" would state a second false fact on the very tile this ticket exists
  // to stop overclaiming. Substituting a "No comparison" line instead just
  // stacked a third negation under the `—` and the reason caption, on the one
  // card in the row trying to explain itself.
  //
  // FEA-4202 update: the supporting observation ISS-5401 recorded here — that
  // `PRs Shipped` and `LOC / $` already render with no delta row, so the footer
  // tolerates one — now holds only while the delivery comparison is OFF. With it
  // on, both delivery cards fill their slot with `KpiDeltaPlaceholder` and this
  // dashed tile is the ONLY card in the strip that drops the row. The RULING
  // stands unchanged either way (a card that dashed its own value must not
  // caption a comparison of it); only its "the neighbours do it too" evidence is
  // flag-dependent. Equal height still holds under grid stretch in both.
  const costDeltaPlaceholder = costSlots.dashed ? undefined : noPriorPeriod;
  // ISS-5401 (stage review, threads on #4667): the two tiles below dash through
  // `value={null}` + `valueUnavailableLabel`, NOT a pre-formatted `"—"` string.
  // Handing `MetricCard` the literal left `value` non-null, so `noData` stayed
  // false and their failed-read dash painted bold 2xl at full foreground while
  // the Cost tile beside them — which this ticket moved onto the primitive's
  // muted no-data treatment — went muted and normal-weight. Three tiles, one
  // failed read, two renderings of the identical state, which a reader would
  // reasonably take to mean something. The GLYPH is unchanged (`KPI_NO_VALUE`,
  // the same em-dash `formatCurrencyTileValue` hands the Cost tile); only the
  // weight and colour move, and the whole strip now lands on one NO-DATA
  // treatment.
  //
  // ISS-5842 (follow-up): "treatment" above means the no-data dash treatment
  // ONLY — it is not, and never was, a claim about `MetricDeltaTreatment`. The
  // strip did NOT land on one DELTA treatment: the two cards below spread a bag
  // that carried no `deltaTreatment`, so they fell to `MetricCard`'s `Legacy`
  // default (a bare grey "-52%") while the Cost card beside them, which resolves
  // the flag itself, rendered the unified pill. The delta treatment now rides
  // `deltaSlotProps` for exactly that reason — see `deltaTreatment` above and the
  // required-parameter rationale on `deltaSlotProps` — so the two axes are one
  // strip-wide statement each rather than one true claim standing in for both.
  return (
    <>
      <MetricCard
        className={cardClassName}
        detail={resolveSessionsCardDetail({
          loading: cardsLoading,
          loadingDetail,
          errored: alwaysAvailableError,
          showingLocalFallback,
          couldNotImportLabel,
        })}
        info={{
          what: "Agent sessions matching the current filters and time range.",
          how: "Count of session records in the active filter set.",
        }}
        {...sessionsDeltaProps}
        deltaPlaceholder={noPriorPeriod}
        label={SESSIONS_METRIC_CARD_LABEL}
        loading={cardsLoading}
        value={
          alwaysAvailableError
            ? null
            : formatNumber(alwaysAvailableUsage?.totalSessions ?? 0)
        }
        valueUnavailableLabel={KPI_NO_VALUE}
      />
      <MetricCard
        className={cardClassName}
        detail={resolveAlwaysAvailableDetail(
          cardsLoading,
          loadingDetail,
          showingLocalFallback,
          "input + output"
        )}
        info={{
          what: "Total input and output tokens across the matched sessions.",
          how: "Sum of per-session input and output token counts in range.",
        }}
        {...tokensDeltaProps}
        deltaPlaceholder={noPriorPeriod}
        label={TOTAL_TOKENS_METRIC_CARD_LABEL}
        loading={cardsLoading}
        value={alwaysAvailableError ? null : formatTokenCount(totalTokens)}
        valueUnavailableLabel={KPI_NO_VALUE}
      />
      {/* FEA-3818: the Cost card is the shared CostMetricCard, the SAME
          component the org Dashboard KPI row renders, so the two surfaces can't
          drift on value basis, formatting, info copy, or the honest-empty
          `—` (an unavailable metric never reads as a misleading `$0`). ISS-4401:
          the LABEL is now intentionally per-surface — Sessions passes
          `SESSIONS_COST_METRIC_CARD_LABEL` ("cost") for its
          not-subscription-covered figure, while the Dashboard keeps the default
          "Cost" for its subscription-inclusive total, so the two numbers no
          longer read as the same word disagreeing across screens. The
          headline is the not-subscription-covered spend (apiEstimatedCost) — the
          SAME basis the "LOC / $" card divides by.

          ISS-4773: BOTH of those last two facts change when
          `sessions-cost-billing-honesty` is ON and the producer sent a usable
          three-way split — the label becomes
          `SESSIONS_COST_HONEST_METRIC_CARD_LABEL` ("API-billed Cost", a THIRD
          per-surface name, not the bare word) and the headline narrows to
          `meteredEstimatedCost`, at which point it is NO LONGER the basis
          "LOC / $" divides by, which is why that card's info copy is gated on
          the same flag. All of it is decided by `resolveCostCardPresentation`.
          The detail line
          names the API-EQUIVALENT cost of subscription-covered usage — what it
          would have cost if metered (a "+$X if billed to API" delta, FEA-4231),
          NOT a real seat fee charged — read from the canonical
          `subscriptionEstimatedCost` field BOTH producers populate, independent
          of the subscription-inclusive `totalEstimatedCost` grand total the two
          producers now agree on (FEA-3986). The line drops only when that
          field is zero/unavailable or would render as $0.00. */}
      <CostMetricCard
        className={cardClassName}
        cost={costSlots.cost}
        // ISS-5842: the honest breakdown caption renders in the card's ordinary
        // muted caption tone — NOT amber. A subscription-covered figure and an
        // unclassified figure are facts about the account, not faults the reader
        // can act on, and warning colour is a call to action there is no action
        // for. A permanently-amber caption also spends the one signal we would
        // need to warn about something real later.
        detail={costSlots.detail}
        info={costPresentation.info}
        {...costDeltaProps}
        deltaPlaceholder={costDeltaPlaceholder}
        label={costPresentation.label}
        loading={cardsLoading}
      />
    </>
  );
}

/**
 * ISS-4429 (design-bot review): the always-available (Sessions / Total Tokens)
 * cards' detail caption. While loading, the honest wait line (import vs plain
 * pending); on the settled LOCAL fallback path, the source caption so a number
 * that disagrees with the cloud rows reads as deliberate; otherwise the card's
 * own scope/composition caption.
 */
function resolveAlwaysAvailableDetail(
  loading: boolean,
  loadingDetail: string,
  showingLocalFallback: boolean,
  scopeDetail: string
): string {
  if (loading) {
    return loadingDetail;
  }
  if (showingLocalFallback) {
    return LOCAL_FALLBACK_DETAIL;
  }
  return scopeDetail;
}

/**
 * ISS-4444 (design review): the Sessions card's detail line. Normally the scope
 * caption ("matched by the current filters" / the loading / local-fallback
 * variants via `resolveAlwaysAvailableDetail`). When the local boot import had to
 * quarantine poison transcripts AND the card is settled on real values (not
 * loading, not errored), the caveat rides HERE instead, so the honesty travels
 * with the count it qualifies, in place, rather than as a detached line above the
 * whole row that reads as a second banner and can contradict the import splash.
 * ISS-6115 (wongk review): the sentence itself now ARRIVES from the desktop
 * adapter rather than being assembled here, so the splash and this card cannot
 * phrase one fact two ways — and so this surface cannot keep saying "couldn't be
 * read" about an import that never got that far. The icon is tokenized
 * (`text-warning-foreground` — colored glyph, muted text) per the DS mute-the-
 * text-color-the-icon pattern, not a gray decoration.
 */
function resolveSessionsCardDetail({
  loading,
  loadingDetail,
  errored,
  showingLocalFallback,
  couldNotImportLabel,
}: {
  loading: boolean;
  loadingDetail: string;
  errored: boolean;
  showingLocalFallback: boolean;
  couldNotImportLabel: string | null;
}): ReactNode {
  const scopeDetail = resolveAlwaysAvailableDetail(
    loading,
    loadingDetail,
    showingLocalFallback,
    "matched by the current filters"
  );
  if (loading || errored || !couldNotImportLabel) {
    return scopeDetail;
  }
  // shafty023 review (ISS-4444): the phrase counts quarantined SOURCE
  // TRANSCRIPTS, not sessions — one poison source (e.g. an OpenCode DB) can hold
  // many sessions, and because it never parsed we cannot know how many. The
  // caller says "transcripts" so the caveat states exactly what it measures
  // instead of implying a scope-matched session tally it is not.
  const label = couldNotImportLabel;
  return (
    <span className="flex items-center gap-1.5">
      <TriangleAlertIcon
        aria-hidden
        className="size-3.5 shrink-0 text-warning-foreground"
      />
      {label}
    </span>
  );
}

/**
 * ISS-4429: has the CLOUD delivery read FAILED with nothing to show — errored AND
 * no cloud totals in hand? Only then do the always-available cards fall back to
 * the local SQLite totals (FEA-3574's original intent). A cloud read that merely
 * lacks data (`usage` present, `isError` false) is NOT a failure: the cloud
 * population — the same one the table shows — is the truth, even for a confirmed
 * empty. Keeping this in one predicate stops the value-source resolution and the
 * loading gate from drifting on the cloud-failure condition.
 */
function isCloudReadFailed(
  isError: boolean,
  usage: AgentSessionUsageSummary | undefined
): boolean {
  return isError && usage === undefined;
}

/**
 * ISS-4429 / ISS-4483: the shared always-available-cards loading gate, so the
 * parent row's `aria-busy` announcement and the child cards' value-slot skeleton
 * cannot drift. Two independent value-only-skeleton windows resolve here:
 *
 * - The FEA-4128 local-FALLBACK skeleton (`alwaysAvailableLoading`) is scoped to
 *   the cloud-failure path — it fires ONLY while the cloud read has failed (no
 *   cloud totals) AND the local fallback source is still hydrating AND that local
 *   read has not itself errored (a failed local read dashes to `—` rather than
 *   spinning). A healthy cloud read paints its real values and never skeletons
 *   over them while a background local import runs.
 * - The ISS-4483 TRANSIENT-recover skeleton (`transientRecovering`, review cid
 *   3679535439) fires while a transient db-host list error is auto-retrying with
 *   no last-good `usage` in hand. It is NOT gated on the cloud read having failed:
 *   the reported case is Local mode, which has no cloud read, so requiring
 *   `isCloudReadFailed` would (correctly) never skeleton there and the cards would
 *   settle to a confirmed `0`. Both windows still yield to a terminal local error
 *   (`isLocalError` dashes, never spins).
 */
function resolveAlwaysAvailableCardsLoading({
  alwaysAvailableLoading,
  transientRecovering,
  isError,
  isLocalError,
  usage,
  honestLoadingEnabled,
}: {
  alwaysAvailableLoading: boolean;
  transientRecovering: boolean;
  isError: boolean;
  isLocalError: boolean;
  usage: AgentSessionUsageSummary | undefined;
  honestLoadingEnabled: boolean;
}): boolean {
  if (isLocalError) {
    return false;
  }
  if (transientRecovering) {
    return true;
  }
  // ISS-5271 (flag-gated, default off): a NEVER-LOADED usage summary with no
  // error skeletons the value slots rather than letting the cards read `?? 0`
  // into a confident zero beside a Cost card that honestly dashes. Like the
  // ISS-4483 transient arm above, this is deliberately NOT gated on the cloud
  // read having failed — the lying state is reachable with no failure at all
  // (a disabled/pending query, an enabled-flip window). Last-good values are
  // unaffected: a summary held by `keepPreviousData` keeps `usage` defined, so
  // this arm covers only the nothing-ever-loaded case. A terminal error still
  // outranks it (the `isError` guard here, `isLocalError` above) — errors dash,
  // never spin.
  if (honestLoadingEnabled && usage === undefined && !isError) {
    return true;
  }
  return alwaysAvailableLoading && isCloudReadFailed(isError, usage);
}
