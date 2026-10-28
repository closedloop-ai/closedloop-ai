"use client";

import type { DocumentListSummary } from "@repo/api/src/types/document-list-summary";
import {
  SUMMARY_CARD_SCROLL_CLASS,
  SUMMARY_CARD_STRETCH_CLASS,
  SummaryCardRow,
} from "@repo/app/shared/components/summary-card-row";
import { SummaryMetricsLoadingRow } from "@repo/app/shared/components/summary-metrics-loading-row";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";
import { CardDensity } from "@repo/design-system/components/ui/card-density";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { ReactNode } from "react";
import {
  buildDocumentsSummaryCards,
  buildDocumentsSummaryCardsFromRows,
  buildUnavailableDocumentsSummaryCards,
  DOCUMENTS_SUMMARY_CARD_IDS,
  DOCUMENTS_SUMMARY_CARD_INFO,
  DOCUMENTS_SUMMARY_CARD_LABELS,
  DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS,
  type DocumentsSummaryCard,
  type DocumentsSummaryRowFallback,
  DocumentsSummaryUnavailableReason,
} from "../lib/documents-summary-cards";

/**
 * The band's own region label, so the four cards are reachable as ONE named group
 * rather than as four unrelated numbers between the toolbar and the table. The
 * cards carry no heading of their own — their labels are `CardDescription` text —
 * so without this there is nothing for assistive tech to announce the band by.
 */
export const DOCUMENTS_SUMMARY_REGION_LABEL = "Documents summary";

/**
 * ISS-8936 — the summary metric band above the Documents index.
 *
 * Built on `SummaryCardRow` + `MetricCard` + `SummaryMetricsLoadingRow`, the
 * shared strip the Sessions and Branches listings already render, rather than a
 * fourth hand-rolled row: the row owns `--summary-card-min`, the two-line label
 * reservation and the shared value baseline, and reaching those with a bespoke
 * grid is what ISS-7052 cost. Nothing here is Documents-specific except the four
 * metrics themselves.
 *
 * THREE STATES, AND NO TWO OF THEM RENDER THE SAME THING (AC2).
 *
 * 1. **Loading** — `SummaryMetricsLoadingRow`: the label is stated (it is known
 *    before the read), the value slot SHIMMERS, and the caption says the row is
 *    loading. It never states a number, so it can never be read as a measured
 *    zero. This is the state the index is in while the gate that picks its read is
 *    resolving, while a typed term is settling, and while the request is in
 *    flight — every moment the host calls unsettled.
 * 2. **Unavailable** — every card kept, every label kept, every info popover kept,
 *    the numbers withdrawn to `MetricCard`'s muted no-data slot under a caption
 *    naming WHY, from `DocumentsSummaryUnavailableReason`. A read that cannot be
 *    answered withdraws VALUES; it does not delete cards, does not suppress the
 *    band, and never fabricates a `0`.
 *
 *    It OUTRANKS the skeleton, which is the precedence `isSummaryMetricsLoading`
 *    states for both shipped strips: a refusal and a failure are settled answers,
 *    and shimmering over one removes the reader's only signal that nothing is
 *    coming. A disabled query sits at `pending` forever, so ranking these the
 *    other way would shimmer indefinitely under a search the server already
 *    refused.
 * 3. **Settled** — the real counts, INCLUDING a real `0`, in the card's normal
 *    weight. A zero here is a measurement and is rendered as one.
 *
 * THE BAND IS NOT HIDEABLE, and that is a satisfied acceptance criterion rather
 * than a missing feature — stated here so the next reader does not add a toggle by
 * analogy with Sessions.
 *
 * ISS-8936 AC3 is conditional: "IF cards are hideable, the hidden-card axis routes
 * through the existing saved-view serialization owner, not a second
 * implementation". The Documents index has NO saved-view state to route it
 * through: `hiddenSummaryCardIds` is a `SessionsListSurfaceV2` axis, and the
 * Documents index persists a search term, sort, page size, column visibility and
 * scroll position through `useViewStatePersistence` — no view record, no hidden
 * sets. So the only way to ship a hideable band here is to invent that axis for
 * Documents, which is a SECOND implementation of exactly what AC3 forbids, and
 * which is ISS-8915's work rather than this ticket's. ISS-8722's absent ≠ empty ≠
 * applied hazard cannot be reached because there is no axis to materialize. When
 * Documents gains saved views, the band takes that owner's set —
 * `isSummaryCardVisible`-shaped, reading the HIDDEN direction so a card added
 * later is visible to a reader whose stored view predates it.
 */
export function DocumentsSummaryCards({
  className,
  isLoading,
  rowFallback,
  summary,
  unavailableReason,
}: {
  className?: string;
  /** No settled summary for the population on screen has arrived yet. */
  isLoading: boolean;
  /**
   * The rows the LIST is showing, for the one state the server cannot answer: a
   * search term the endpoint rejects. Present only in that state; when it is,
   * three of the four figures are counted from these rows and the fourth names
   * the operand the browser has no access to. See
   * {@link buildDocumentsSummaryCardsFromRows}.
   */
  rowFallback: DocumentsSummaryRowFallback | undefined;
  summary: DocumentListSummary | undefined;
  /**
   * Why there is no figure to state, when that is settled. `undefined` means
   * nothing is known to be wrong, so `isLoading` and `summary` decide between the
   * skeleton and the numbers.
   */
  unavailableReason: DocumentsSummaryUnavailableReason | undefined;
}) {
  return (
    <section aria-label={DOCUMENTS_SUMMARY_REGION_LABEL} className={className}>
      {renderDocumentsSummaryRow({
        isLoading,
        rowFallback,
        summary,
        unavailableReason,
      })}
    </section>
  );
}

/**
 * The row itself, in whichever of the three states applies.
 *
 * Module-level rather than inline so the three-way branch is scored against this
 * function instead of the component, and so the loading arm and the settled arm
 * spend the SAME `SUMMARY_CARD_STRETCH_CLASS` — a loading shell sized differently from
 * the card that replaces it is the reflow ISS-9887 folded these two rows together
 * to prevent.
 */
function renderDocumentsSummaryRow({
  isLoading,
  rowFallback,
  summary,
  unavailableReason,
}: {
  isLoading: boolean;
  rowFallback: DocumentsSummaryRowFallback | undefined;
  summary: DocumentListSummary | undefined;
  unavailableReason: DocumentsSummaryUnavailableReason | undefined;
}): ReactNode {
  const cardClassName = SUMMARY_CARD_STRETCH_CLASS;
  // A SETTLED answer outranks the skeleton, whichever kind it is — a stated
  // reason, or figures counted from the rows on screen. Both are answers; the
  // skeleton is a promise that one is coming. It is also what stops an
  // indefinite shimmer: for the refused term the query is DISABLED, so it never
  // leaves `pending`, and the row fallback is the only answer that will ever
  // arrive for it.
  if (
    isLoading &&
    unavailableReason === undefined &&
    rowFallback === undefined
  ) {
    return (
      <SummaryMetricsLoadingRow
        cardClassName={cardClassName}
        cards={DOCUMENTS_SUMMARY_CARD_IDS.map((id) => ({
          key: id,
          label: DOCUMENTS_SUMMARY_CARD_LABELS[id],
          info: DOCUMENTS_SUMMARY_CARD_INFO[id],
        }))}
        className={SUMMARY_CARD_SCROLL_CLASS}
        loadingDetail={LIST_SUMMARY_LOADING_DETAIL}
      />
    );
  }
  return (
    <SummaryCardRow
      className={SUMMARY_CARD_SCROLL_CLASS}
      density={CardDensity.Compact}
    >
      {resolveDocumentsSummaryCards({
        rowFallback,
        summary,
        unavailableReason,
      }).map((card) => (
        <MetricCard
          className={cardClassName}
          detail={card.detail}
          info={card.info}
          key={card.id}
          label={card.label}
          value={card.value}
          valueUnavailableLabel={KPI_NO_VALUE}
        />
      ))}
    </SummaryCardRow>
  );
}

/**
 * Which cards the settled band paints, ranked in ONE place so no two arms can both
 * render or both be skipped.
 *
 * The SERVER's answer wins when there is one. The row fallback comes next, because
 * it is the honest answer for the state the server refuses rather than a second
 * opinion about a state it answered. Only with neither does the band withdraw the
 * numbers: there is no payload and no rows, so there is nothing to state, and
 * inventing a figure is the fabrication this whole band is shaped to avoid.
 */
function resolveDocumentsSummaryCards({
  rowFallback,
  summary,
  unavailableReason,
}: {
  rowFallback: DocumentsSummaryRowFallback | undefined;
  summary: DocumentListSummary | undefined;
  unavailableReason: DocumentsSummaryUnavailableReason | undefined;
}): readonly DocumentsSummaryCard[] {
  if (summary !== undefined && unavailableReason === undefined) {
    return buildDocumentsSummaryCards(summary);
  }
  if (rowFallback !== undefined) {
    return buildDocumentsSummaryCardsFromRows(rowFallback);
  }
  return buildUnavailableDocumentsSummaryCards(
    DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS[
      unavailableReason ?? DocumentsSummaryUnavailableReason.ReadFailed
    ]
  );
}
