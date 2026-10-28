"use client";

import type { FindDocumentsOptions } from "@repo/api/src/types/document";
import { DocumentsSummaryCards } from "@repo/app/documents/components/documents-summary-cards";
import { useDocumentsSummary } from "@repo/app/documents/hooks/use-documents-summary";
import type {
  DocumentsSummaryRow,
  DocumentsSummaryRowFallback,
} from "@repo/app/documents/lib/documents-summary-cards";
import { DocumentsSummaryUnavailableReason } from "@repo/app/documents/lib/documents-summary-cards";
import { isSummaryMetricsLoading } from "@repo/app/shared/lib/summary-metrics-loading";
import { keepPreviousData } from "@tanstack/react-query";

/**
 * ISS-8936 — the Documents index summary band, and the ONLY owner of its read.
 *
 * It exists as its own component rather than as a block inside
 * `DocumentsIndexView` because that is what makes the gate real. The view reads
 * `documents-index-summary-cards` once and either mounts this or mounts nothing,
 * so on the closed default `useDocumentsSummary` is not merely `enabled: false` —
 * it is not in the tree at all, and the closed reader pays for nothing. The
 * boolean never crosses this boundary: the props below are a population and two
 * facts about it, none of them flag-derived, so nothing under the branch can ask
 * which arm it is on.
 */
export function DocumentsSummaryBand({
  className,
  filterText,
  isPopulationUnsettled,
  isTermOverLong,
  rows,
  searchParams,
}: {
  className?: string;
  /**
   * The population itself is not yet known — the term the band is about to send
   * is not the term in the box, or the gate that picks the list's read has not
   * answered. Either way there is a read still to come, which is loading rather
   * than an empty index.
   */
  isPopulationUnsettled: boolean;
  /**
   * The term is longer than the endpoint accepts, so the server cannot be asked
   * about this population at all. The band does NOT go blank for it: that arm is
   * always the unbounded whole-population read, so `rows` below holds everything
   * the list is showing and three of the four figures are counted from it.
   */
  isTermOverLong: boolean;
  /**
   * The rows the list holds, and the term it narrows them by — the operands the
   * row-counted fallback spends. Read only while {@link isTermOverLong}.
   */
  filterText: string;
  rows: readonly DocumentsSummaryRow[];
  /** The list's filters, with the term already resolved for the server. */
  searchParams: FindDocumentsOptions;
}) {
  const serverCanAnswer = !isTermOverLong;
  const {
    data: summary,
    isError,
    isPending,
    isPlaceholderData,
  } = useDocumentsSummary(searchParams, {
    enabled: serverCanAnswer,
    // `keepPreviousData` keeps the four cards populated while a new term settles,
    // and `isPlaceholderData` is what stops that becoming a lie: the fold below
    // reads it as loading, so the PREVIOUS population's counts are never stated
    // as the current one's — the exact divergence ISS-9887 folded these two
    // strips together to end.
    placeholderData: keepPreviousData,
  });
  return (
    <DocumentsSummaryCards
      className={className}
      isLoading={
        isSummaryMetricsLoading({
          isPending,
          isServingPreviousScope: isPlaceholderData,
        }) || isPopulationUnsettled
      }
      rowFallback={resolveRowFallback({
        filterText,
        isPopulationUnsettled,
        isTermOverLong,
        rows,
      })}
      // WITHHELD on the refused-term arm, and that is the whole point of
      // `serverCanAnswer`. For an over-long term `resolveServerSearch` drops the
      // search, so the key this band registers collapses to the unfiltered one the
      // page loaded with — which is usually still cached, and which
      // `keepPreviousData` would hand back regardless. Passing it on would rank a
      // WHOLE-ORG payload above the row-counted answer and state it as the
      // narrowed population's counts, under a table the term had narrowed
      // (review thread on #8000). The server was not asked about this population,
      // so it has no answer about it.
      summary={serverCanAnswer ? summary : undefined}
      unavailableReason={
        isError ? DocumentsSummaryUnavailableReason.ReadFailed : undefined
      }
    />
  );
}

/**
 * The row-counted operands, or `undefined` when they are not an answer yet.
 *
 * `undefined` outside the refused-term state, not an empty fallback: the band ranks
 * the SERVER's answer first, and handing it rows unconditionally would let a
 * zero-row page silently outrank a settled payload on any arm.
 *
 * `undefined` ALSO while the population is unsettled, even inside that state. The
 * fallback outranks the skeleton — it is a settled answer and the skeleton is a
 * promise of one — so a cold read's empty `rows` handed over here would paint four
 * settled zeroes for a population nothing has counted. Withholding it until the
 * rows arrive is what keeps the skeleton showing for that window, and it cannot
 * shimmer indefinitely: the rows settle, and the fallback then takes over from a
 * query that is disabled and will never leave `pending` (review thread on #8000).
 */
function resolveRowFallback({
  filterText,
  isPopulationUnsettled,
  isTermOverLong,
  rows,
}: {
  filterText: string;
  isPopulationUnsettled: boolean;
  isTermOverLong: boolean;
  rows: readonly DocumentsSummaryRow[];
}): DocumentsSummaryRowFallback | undefined {
  if (!isTermOverLong || isPopulationUnsettled) {
    return;
  }
  return { filterText, rows };
}
