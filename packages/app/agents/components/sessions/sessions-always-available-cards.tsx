"use client";

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { resolveSessionTokenTotal } from "@repo/api/src/utils/session-token-total";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  formatNumber,
  formatTokenCount,
  KPI_NO_VALUE,
} from "@repo/app/shared/lib/format-utils";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionSummaryDeltas } from "../../lib/session-summary-deltas";
import { resolveCostBreakdownLanes } from "./cost-breakdown-lanes";
import {
  type CostCardPresentation,
  resolveCostCardPresentation,
  resolveCostTileSlots,
} from "./cost-card-presentation";
import { CostMetricCard } from "./cost-metric-card";
import { SESSIONS_METRIC_CARD_LABEL } from "./sessions-summary-card-labels";
import {
  isSummaryCardVisible,
  SessionsSummaryCardId,
} from "./sessions-summary-card-visibility";
import {
  costDeltaKey,
  deltaSlotProps,
  honestSummaryDeltaPlaceholder,
  resolveComparableDeltas,
  shippedSummaryDeltaPlaceholder,
} from "./sessions-summary-delta-slots";
import { useSessionsSummaryCardLabels } from "./use-sessions-summary-card-labels";

/**
 * The Sessions strip's three ALWAYS-AVAILABLE cards (Sessions, Total Tokens,
 * Cost) and the source resolution they share with the row that hosts them.
 *
 * Extracted from `sessions-summary-cards.tsx` under the root AGENTS.md file-size
 * discipline, the same seam `sessions-delivery-metric-card.tsx` was taken along:
 * these three read the cloud/local fallback chain and never gate on a GitHub
 * connection, which is exactly what the delivery pair does not do.
 */

// ISS-4444 (design review): the import wait caption for the always-available
// cards while a genuine import is running.
const IMPORTING_HISTORY_DETAIL = "Importing your history";
// ISS-4429 (design-bot review): the plain pending-fallback wait caption — the
// local read hasn't settled yet but NO import is running, so the card must not
// claim an import. A neutral "Loading…" instead of the import-specific line.
export const LOADING_DETAIL = LIST_SUMMARY_LOADING_DETAIL;
// ISS-4429 (design-bot review): the settled source caption for the always-
// available cards when they are showing the LOCAL fallback totals (the cloud read
// failed). The three cards then describe a DIFFERENT population than the cloud
// rows the table paints, so the caption names the source — a number that
// disagrees with the rows reads as a deliberate degraded read, not a broken one.
// Mirrors the `ReadSource.Fallback` provenance vocabulary the toolbar badge uses.
const LOCAL_FALLBACK_DETAIL = "From local history";

export function AlwaysAvailableCards({
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
  hiddenCardIds,
  hideSettledEmptyCost,
}: {
  usage: AgentSessionUsageSummary | undefined;
  localUsage: AgentSessionUsageSummary | undefined;
  hiddenCardIds: ReadonlySet<string> | undefined;
  /** ISS-9730: the row already decided this — see `isSettledEmptyCost`. */
  hideSettledEmptyCost: boolean;
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
  // ISS-5271 (same `…Optional` reasoning): read here too so this component's
  // own `cardsLoading` cannot drift from the parent row's `aria-busy` gate —
  // both feed `resolveAlwaysAvailableCardsLoading` with the same flag state.
  // ISS-10667: the strip reads the same label map the Options menu and the
  // loading shell read, so a card and its menu row cannot name it differently.
  // The resolved STRING is what travels to the render helper, never the gate.
  const tokensLabel =
    useSessionsSummaryCardLabels()[SessionsSummaryCardId.Tokens];
  const honestLoadingEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY
  );
  // The fallback (and its loading skeleton) engages ONLY on the cloud-failure path
  // (`isCloudReadFailed`): a healthy cloud read shows the cloud population — the same
  // one the table paints — immediately, so a background local import never skeletons
  // over a populated cloud card.
  const { alwaysAvailableError, alwaysAvailableUsage, useLocalFallback } =
    resolveAlwaysAvailableSource({
      alwaysAvailableLoading,
      isError,
      isLocalError,
      localUsage,
      usage,
    });
  const costPresentation = resolveCostCardPresentation(alwaysAvailableUsage);
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
  // ISS-7175: all FOUR counters — DOC-15's `Total Tokens per Session`, which is
  // what the card has always been LABELLED. It summed only the uncached pair, so
  // on a cache-heavy harness (where `cache_read` dominates) the tile understated
  // by roughly an order of magnitude and disagreed with the Session-detail
  // Tokens row, which prints all four. The delta chip beside this value is
  // computed server-side and moved to the same basis in the same change
  // (`usage-summary.ts` for the current period, `usage-comparison.ts` for the
  // prior). All three now sum through `resolveSessionTokenTotal`'s term list, so
  // "must stay in step" is a typecheck rather than a promise. NOT to be confused
  // with the AI Impact card's `Tokens per KLOC`, which excludes cache on purpose.
  const totalTokens = resolveSessionTokenTotal({
    input: alwaysAvailableUsage?.totalInputTokens,
    output: alwaysAvailableUsage?.totalOutputTokens,
    cacheRead: alwaysAvailableUsage?.totalCacheReadTokens,
    cacheWrite: alwaysAvailableUsage?.totalCacheWriteTokens,
  });
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
  // ISS-4748: lanes only in breakdown mode, only for a splittable payload, and
  // never beneath a dashed headline. All three conditions live in the resolver,
  // so this component gains no branch of its own.
  const costLanes = resolveCostBreakdownLanes(
    costPresentation,
    alwaysAvailableUsage,
    costSlots.dashed
  );
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
  // ISS-7175 (review): gated on the tile's own dash, exactly as Cost is below.
  // `comparableDeltas` drops out on loading / error / local fallback, and none of
  // those covers a corrupt counter, so without this the tile paints KPI_NO_VALUE
  // with a live "+37% vs. prior 30 days" under it. Worse than merely odd: the
  // chip grades `current.totalTokens`, summed by `sumSessionTokenCounters`, which
  // does not validate its terms — so it would grade a movement computed from the
  // very counter the value slot just refused to trust. ISS-5401's invariant: a
  // card that declined to state its value must not grade a movement in it.
  const tokensDashed = alwaysAvailableError || totalTokens === null;
  // Total Tokens is NOT in this gate's scope, and cannot be: `resolveSessionTokenTotal`
  // returns null for exactly one reason — a term that is PRESENT and unusable
  // (null, non-finite, negative). An ABSENT term folds to 0, so a legitimately
  // empty cohort totals 0 and renders a number. `null` is therefore the corrupt
  // signal itself, never an honest empty, and hiding on it would delete the only
  // on-screen evidence of a malformed payload (codex, #6885).
  const tokensDeltaProps = deltaSlotProps(
    tokensDashed ? undefined : comparableDeltas,
    "tokens",
    deltaTreatment
  );
  // #4480: Cost carries a chip too — it is the card where a period comparison is
  // most obviously useful, and leaving it out left the strip's bottom edge
  // ragged beside the two that had one. The chip grades the headline the card
  // actually rendered rather than one this component picked.
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
  // ISS-7422 / ISS-7525: only a SETTLED, UNMEASURED absence earns that wording
  // — in-flight shimmers, measured-but-declined says so; the resolver owns which.
  const deltaPlaceholder = honestLoadingEnabled
    ? honestSummaryDeltaPlaceholder(comparableDeltas)
    : shippedSummaryDeltaPlaceholder(comparableDeltas);
  // ISS-7175: the dashed Total Tokens tile drops its comparison slot and states
  // no value, the same invariant the dashed Cost tile applies just below — a card
  // that declined to state its value must not grade a movement in it. Resolved
  // here rather than inline in the tile for the same reason `costDeltaPlaceholder`
  // is: FEA-4217's per-card visibility branches left the render with no
  // complexity budget for a ternary in the slot.
  const tokensDeltaPlaceholder = tokensDashed ? undefined : deltaPlaceholder;
  const tokensValue = tokensDashed ? null : formatTokenCount(totalTokens);
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
  const costDeltaPlaceholder = costSlots.dashed ? undefined : deltaPlaceholder;
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
  return renderAlwaysAvailableCards({
    alwaysAvailableError,
    alwaysAvailableUsage,
    cardClassName,
    cardsLoading,
    costDeltaPlaceholder,
    costDeltaProps,
    costLanes,
    costPresentation,
    costSlots,
    couldNotImportLabel,
    deltaPlaceholder,
    hiddenCardIds,
    hideSettledEmptyCost,
    loadingDetail,
    sessionsDeltaProps,
    showingLocalFallback,
    tokensDashed,
    tokensDeltaPlaceholder,
    tokensDeltaProps,
    tokensLabel,
    tokensValue,
  });
}

function renderAlwaysAvailableCards({
  alwaysAvailableError,
  alwaysAvailableUsage,
  cardClassName,
  cardsLoading,
  costDeltaPlaceholder,
  costDeltaProps,
  costLanes,
  costPresentation,
  costSlots,
  couldNotImportLabel,
  deltaPlaceholder,
  hiddenCardIds,
  hideSettledEmptyCost,
  loadingDetail,
  sessionsDeltaProps,
  showingLocalFallback,
  tokensDashed,
  tokensDeltaPlaceholder,
  tokensDeltaProps,
  tokensLabel,
  tokensValue,
}: AlwaysAvailableCardRenderInput) {
  return (
    <>
      {isSummaryCardVisible(SessionsSummaryCardId.Sessions, hiddenCardIds) ? (
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
          deltaPlaceholder={deltaPlaceholder}
          label={SESSIONS_METRIC_CARD_LABEL}
          loading={cardsLoading}
          value={
            alwaysAvailableError
              ? null
              : formatNumber(alwaysAvailableUsage?.totalSessions ?? 0)
          }
          valueUnavailableLabel={KPI_NO_VALUE}
        />
      ) : null}
      {isSummaryCardVisible(SessionsSummaryCardId.Tokens, hiddenCardIds) ? (
        <MetricCard
          className={cardClassName}
          detail={resolveTokensCardDetail({
            dashed: tokensDashed,
            loading: cardsLoading,
            loadingDetail,
            showingLocalFallback,
          })}
          info={{
            what: "Total tokens across the matched sessions, including cache reads and writes.",
            how: "Sum of per-session input, output, cache-read and cache-write token counts in range.",
          }}
          {...tokensDeltaProps}
          deltaPlaceholder={tokensDeltaPlaceholder}
          label={tokensLabel}
          loading={cardsLoading}
          value={tokensValue}
          valueUnavailableLabel={KPI_NO_VALUE}
        />
      ) : null}
      {isSummaryCardVisible(SessionsSummaryCardId.Cost, hiddenCardIds) &&
      !hideSettledEmptyCost ? (
        <CostMetricCard
          className={cardClassName}
          cost={costSlots.cost}
          detail={costSlots.detail}
          info={costPresentation.info}
          lanes={costLanes}
          {...costDeltaProps}
          deltaPlaceholder={costDeltaPlaceholder}
          label={costPresentation.label}
          loading={cardsLoading}
        />
      ) : null}
    </>
  );
}

type AlwaysAvailableCardRenderInput = {
  alwaysAvailableError: boolean;
  alwaysAvailableUsage: AgentSessionUsageSummary | undefined;
  cardClassName: string;
  cardsLoading: boolean;
  costDeltaPlaceholder: ReactNode;
  costDeltaProps: ReturnType<typeof deltaSlotProps>;
  costLanes: ReturnType<typeof resolveCostBreakdownLanes>;
  costPresentation: CostCardPresentation;
  costSlots: ReturnType<typeof resolveCostTileSlots>;
  couldNotImportLabel: string | null;
  deltaPlaceholder: ReactNode;
  hiddenCardIds: ReadonlySet<string> | undefined;
  hideSettledEmptyCost: boolean;
  loadingDetail: string;
  sessionsDeltaProps: ReturnType<typeof deltaSlotProps>;
  showingLocalFallback: boolean;
  tokensDashed: boolean;
  tokensDeltaPlaceholder: ReactNode;
  tokensDeltaProps: ReturnType<typeof deltaSlotProps>;
  tokensLabel: string;
  tokensValue: string | null;
};

/**
 * ISS-4429 (design-bot review): the always-available (Sessions / token total)
 * cards' detail caption. While loading, the honest wait line (import vs plain
 * pending); on the settled LOCAL fallback path, the source caption so a number
 * that disagrees with the cloud rows reads as deliberate; otherwise the card's
 * own scope/composition caption.
 */
/**
 * ISS-7175 (review): the caption a dashed Total Tokens tile carries instead of
 * reciting what the number is made of. Telling a reader the composition of a
 * figure that could not be computed says the wrong thing twice — it implies a
 * number exists, and it explains one that doesn't. Mirrors the Cost tile, which
 * swaps its caption for a reason in the same state.
 */
const TOKENS_UNAVAILABLE_DETAIL = "token counts unavailable for this range";

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
 * ISS-7175: the Total Tokens card's detail line — the scope caption, or the
 * reason the tile has no number to caption.
 *
 * A twin of `resolveSessionsCardDetail` below rather than a ternary at the call
 * site: FEA-4217 wrapped each card in its own `isSummaryCardVisible` branch, and
 * the two sets of branch points together put `AlwaysAvailableCards` over the
 * cognitive-complexity ceiling that each change cleared on its own.
 *
 * `dashed` alone does not earn the reason — a still-loading or local-fallback
 * read has no number YET, which the scope caption's own loading and fallback
 * variants already say correctly. Only a SETTLED absence swaps the caption, the
 * same rule `TOKENS_UNAVAILABLE_DETAIL` states above.
 */
function resolveTokensCardDetail({
  dashed,
  loading,
  loadingDetail,
  showingLocalFallback,
}: {
  dashed: boolean;
  loading: boolean;
  loadingDetail: string;
  showingLocalFallback: boolean;
}): string {
  if (dashed && !(loading || showingLocalFallback)) {
    return TOKENS_UNAVAILABLE_DETAIL;
  }
  return resolveAlwaysAvailableDetail(
    loading,
    loadingDetail,
    showingLocalFallback,
    "input + output + cache"
  );
}

/**
 * ISS-4444 (design review): the Sessions card's detail line. Normally the scope
 * caption ("matched by the current filters" / the loading / local-fallback
 * variants via `resolveAlwaysAvailableDetail`). When the local boot import had to
 * quarantine poison transcripts AND the card is settled on real values (not
 * loading, not errored), the caveat rides HERE instead, so the honesty travels
 * with the count it qualifies, in place, rather than as a detached line above the
 * whole row that reads as a second banner and can contradict the import splash.
 * ISS-6115 (whitlockk review): the sentence itself now ARRIVES from the desktop
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
  // davetho review (ISS-4444): the phrase counts quarantined SOURCE
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
 *   (`isLocalError` dashes, never spins) — but ISS-7829 scoped that to the
 *   fallback path the error is actually reported on; see the guard below.
 */
export function resolveAlwaysAvailableCardsLoading({
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
  // ISS-7829 (ISS-4779 closed-by-default): the local-error guard is scoped to
  // the path where that error is the one the cards actually REPORT.
  //
  // `isLocalError` describes the local FALLBACK source, which the cards only
  // read once the cloud read has failed (`isCloudReadFailed` — the same
  // predicate `AlwaysAvailableCards` resolves its value SOURCE with, so the
  // loading gate and the source resolution cannot answer "are we on the fallback
  // path" differently). Unconditionally it also suppressed both loading arms
  // below on renders that were not reading that source at all, which would let
  // the cards fall through to `?? 0` for a summary nothing computed.
  //
  // SHIPPED, ON THE DESKTOP CLOUD-MODE TRANSIENT PATH (whitlockk review). `usageError`
  // does NOT reach this helper as `isError`: it is classified first, and
  // `classifyListReadErrorState`'s `metricReadErrored` deliberately EXCLUDES a
  // transient failure of either half, which `resolveSummaryCardsErrored` then
  // folds into the `isError` prop. So when the list wins the race and the usage
  // half fails transiently (`usageErrorTransient`, recovery not yet exhausted)
  // the cards are handed `isError: false`, `usage: undefined` and
  // `transientRecovering: true` — while the SEPARATE local fallback read, which
  // is enabled on that very render, can independently settle as `isLocalError`.
  // That is precisely the state this widens, and before this change the guard
  // suppressed the ISS-4483 recover skeleton there and published `?? 0` for a
  // summary nothing computed. Web passes no local signal and desktop Local mode
  // hard-codes `isLocalError` false, so neither is affected either way.
  //
  // OFF this is byte-for-byte today's behavior. ON, a failed local read still
  // outranks every loading arm on the fallback path itself — errors dash, never
  // spin, which is what the guard was written for and what its sibling case
  // pins.
  const localErrorIsReported =
    !honestLoadingEnabled || isCloudReadFailed(isError, usage);
  if (isLocalError && localErrorIsReported) {
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

/**
 * Which usage payload the always-available cards are actually reporting, and
 * whose error state goes with it.
 *
 * Shared by the row and by the cards it renders: the row has to know which
 * cards the hide gate would retire before it can size the strip or decide the
 * strip renders at all, and re-deriving the fallback chain there is how the two
 * would come to disagree about which population is on screen.
 */
export function resolveAlwaysAvailableSource({
  alwaysAvailableLoading,
  isError,
  isLocalError,
  localUsage,
  usage,
}: {
  alwaysAvailableLoading: boolean;
  isError: boolean;
  isLocalError: boolean;
  localUsage: AgentSessionUsageSummary | undefined;
  usage: AgentSessionUsageSummary | undefined;
}): {
  alwaysAvailableError: boolean;
  alwaysAvailableUsage: AgentSessionUsageSummary | undefined;
  onLocalFallbackPath: boolean;
  useLocalFallback: boolean;
} {
  const localFallbackAvailable = localUsage !== undefined || isLocalError;
  const onCloudFailurePath = isCloudReadFailed(isError, usage);
  const useLocalFallback = localFallbackAvailable && onCloudFailurePath;
  const localFallbackPending = alwaysAvailableLoading && onCloudFailurePath;
  const onLocalFallbackPath = useLocalFallback || localFallbackPending;
  return {
    alwaysAvailableError: onLocalFallbackPath ? isLocalError : isError,
    alwaysAvailableUsage: onLocalFallbackPath ? localUsage : usage,
    onLocalFallbackPath,
    useLocalFallback,
  };
}
