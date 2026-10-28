import { DOCUMENT_LIST_MAX_SEARCH_LENGTH } from "@repo/api/src/types/document";
import {
  DOCUMENT_SUMMARY_WINDOW_DAYS,
  type DocumentListSummary,
} from "@repo/api/src/types/document-list-summary";
import { matchesFilter } from "@repo/app/documents/lib/document-filter";
import { formatNumber } from "@repo/app/shared/lib/format-utils";

/**
 * ISS-8936 — stable identity for each Documents summary card.
 *
 * Ids rather than labels, for the reason `SessionsSummaryCardId` gives: a card
 * identified only by its display label stops being identifiable the moment the
 * label is reworded. Nothing persists these ids today — the band is not
 * hideable, see `DocumentsSummaryCards` for why — but they are
 * what a React key and a test assertion address, and a card that arrives with a
 * label for a name cannot be given a stable one later without breaking both.
 */
export const DocumentsSummaryCardId = {
  Total: "total",
  ProducedBySessions: "produced-by-sessions",
  UpdatedInWindow: "updated-in-window",
  NeverEdited: "never-edited",
} as const;
export type DocumentsSummaryCardId =
  (typeof DocumentsSummaryCardId)[keyof typeof DocumentsSummaryCardId];

/** The label each card states, in the order the band paints them. */
export const DOCUMENTS_SUMMARY_CARD_LABELS: Record<
  DocumentsSummaryCardId,
  string
> = {
  [DocumentsSummaryCardId.Total]: "Documents",
  // "Produced by", not "From": the count is PRODUCES-provenance only, which is
  // narrower than every session that touched the document. A label claiming the
  // wider fact would overstate a number the server cannot measure — see
  // `DocumentListSummary.producedByAgentSessions`.
  [DocumentsSummaryCardId.ProducedBySessions]: "Produced by sessions",
  [DocumentsSummaryCardId.UpdatedInWindow]: "Updated this week",
  [DocumentsSummaryCardId.NeverEdited]: "Never edited",
};

/**
 * Every card, in strip order. The band is built from this rather than from four
 * JSX literals, so a card cannot be added to the render without a label, an info
 * popover and a loading shell arriving with it.
 */
export const DOCUMENTS_SUMMARY_CARD_IDS: readonly DocumentsSummaryCardId[] = [
  DocumentsSummaryCardId.Total,
  DocumentsSummaryCardId.ProducedBySessions,
  DocumentsSummaryCardId.UpdatedInWindow,
  DocumentsSummaryCardId.NeverEdited,
];

/** What a card's info popover says: the fact, then how it was measured. */
export type DocumentsSummaryCardInfo = { what: string; how: string };

/**
 * The derivation behind each number, in the reader's words.
 *
 * `how` exists because three of these four are narrower than their label can fit,
 * and a count whose definition is invisible reads as whatever the reader assumed.
 * "Produced by sessions" counts production links and not mentions; "Never edited"
 * is a version counter and not an activity feed. A reader deciding what to act on
 * is entitled to both.
 */
export const DOCUMENTS_SUMMARY_CARD_INFO: Record<
  DocumentsSummaryCardId,
  DocumentsSummaryCardInfo
> = {
  [DocumentsSummaryCardId.Total]: {
    what: "Every document matching the filters in force.",
    how: "Counted on the server over the same query the list below is drawn from, so it does not stop at the page on screen.",
  },
  [DocumentsSummaryCardId.ProducedBySessions]: {
    what: "Documents an agent session produced.",
    how: "Counts a recorded production link from a session in this organization. A session that only read or mentioned a document is not counted.",
  },
  [DocumentsSummaryCardId.UpdatedInWindow]: {
    what: "Documents changed recently.",
    how: "Counts documents whose last update falls inside the window named below the number.",
  },
  [DocumentsSummaryCardId.NeverEdited]: {
    what: "Documents created but never written.",
    how: "Counts documents still on the version their creation wrote — no later version has been saved.",
  },
};

/** One card, resolved from a settled summary. */
export type DocumentsSummaryCard = {
  id: DocumentsSummaryCardId;
  label: string;
  info: DocumentsSummaryCardInfo;
  /**
   * The count, or `null` when no settled summary is in hand.
   *
   * `null` is "we do not know", which `MetricCard` renders as its muted no-data
   * slot. It is NEVER used for a measured zero: an org with no documents reads
   * `0`, in the same weight as any other number, because that is a fact. Folding
   * the two together is the defect the honest-loading gate exists for.
   */
  value: number | null;
  /** The caption under the number: what population it was measured over. */
  detail: string;
};

/**
 * The four cards for a settled summary.
 *
 * Every sub-count carries the SAME denominator in its caption, which is the
 * reconciliation AC1 asks for made visible: a reader can check "Produced by
 * sessions 260 / of 412 in this view" against the pager beneath it without
 * doing arithmetic across two screens.
 */
export function buildDocumentsSummaryCards(
  summary: DocumentListSummary
): readonly DocumentsSummaryCard[] {
  const denominator = documentsSummaryDenominatorDetail(summary.total);
  const values: Record<DocumentsSummaryCardId, number> = {
    [DocumentsSummaryCardId.Total]: summary.total,
    [DocumentsSummaryCardId.ProducedBySessions]:
      summary.producedByAgentSessions,
    [DocumentsSummaryCardId.UpdatedInWindow]: summary.updatedInWindow,
    [DocumentsSummaryCardId.NeverEdited]: summary.neverEdited,
  };
  const details: Record<DocumentsSummaryCardId, string> = {
    [DocumentsSummaryCardId.Total]: DOCUMENTS_SUMMARY_TOTAL_DETAIL,
    [DocumentsSummaryCardId.ProducedBySessions]: denominator,
    [DocumentsSummaryCardId.UpdatedInWindow]: documentsSummaryWindowDetail(
      summary.windowDays
    ),
    [DocumentsSummaryCardId.NeverEdited]: denominator,
  };
  return DOCUMENTS_SUMMARY_CARD_IDS.map((id) => ({
    id,
    label: DOCUMENTS_SUMMARY_CARD_LABELS[id],
    info: DOCUMENTS_SUMMARY_CARD_INFO[id],
    value: values[id],
    detail: details[id],
  }));
}

/**
 * The same four cards with no value — the shape the band renders when the read
 * FAILED.
 *
 * Every card is still painted, and each still states its label and its info
 * popover. A failed read withdraws the numbers, never the cards: dropping them
 * would delete the reader's only signal that four measurements they can see the
 * slots for did not arrive, and suppressing one while its siblings render is the
 * suppression-is-the-defect case.
 */
export function buildUnavailableDocumentsSummaryCards(
  detail: string
): readonly DocumentsSummaryCard[] {
  return DOCUMENTS_SUMMARY_CARD_IDS.map((id) => ({
    id,
    label: DOCUMENTS_SUMMARY_CARD_LABELS[id],
    info: DOCUMENTS_SUMMARY_CARD_INFO[id],
    value: null,
    detail,
  }));
}

/** The caption the total states: which population it counted. */
export const DOCUMENTS_SUMMARY_TOTAL_DETAIL = "Matching current filters";

/**
 * Why the band holds no number at all — the settled state in which no figure can
 * be stated, as distinct from the unsettled state in which one is coming.
 *
 * ONE member today, and it stays an enumeration rather than collapsing to a
 * boolean because the caption is what the reader acts on: a second reason gets its
 * own sentence in the exhaustive map below rather than borrowing this one's. The
 * over-long-search case is deliberately NOT a member — that state publishes the
 * three figures it can count and names the one operand it cannot reach
 * ({@link buildDocumentsSummaryCardsFromRows}).
 */
export const DocumentsSummaryUnavailableReason = {
  /** The read failed, or returned nothing. */
  ReadFailed: "read-failed",
} as const;
export type DocumentsSummaryUnavailableReason =
  (typeof DocumentsSummaryUnavailableReason)[keyof typeof DocumentsSummaryUnavailableReason];

/**
 * What each reason says in the caption slot, where a measured population would
 * otherwise be named. Exhaustive by construction: a second reason fails `tsc` here
 * rather than rendering an empty caption under an absent value.
 */
export const DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS: Record<
  DocumentsSummaryUnavailableReason,
  string
> = {
  [DocumentsSummaryUnavailableReason.ReadFailed]: "Couldn't load this figure",
};

/**
 * The denominator caption every sub-count carries.
 *
 * Stated even when it is zero. "Of 0 in this view" beside a `0` is a matched
 * pair a reader can reconcile; omitting it there would make the empty case the
 * one card that does not say what it measured.
 */
export function documentsSummaryDenominatorDetail(total: number): string {
  return `Of ${formatNumber(total)} in this view`;
}

/** The caption the freshness card states: the window the count was measured over. */
export function documentsSummaryWindowDetail(windowDays: number): string {
  if (windowDays === 1) {
    return "In the last day";
  }
  return `In the last ${formatNumber(windowDays)} days`;
}

/**
 * One row as this fallback reads it. Structural rather than `DocumentWithProject`
 * so the helper states exactly the four fields it measures and nothing else.
 */
export type DocumentsSummaryRow = {
  title: string;
  slug: string;
  latestVersion: number;
  updatedAt: Date | string;
};

/**
 * The input {@link buildDocumentsSummaryCardsFromRows} counts over: the rows the
 * list holds, plus the term it is narrowing them by.
 *
 * `now` is injectable so the freshness boundary is pinnable in a test rather than
 * read off the wall clock. `windowDays` defaults to the same constant the server
 * reports, so the fallback's caption names the same window the settled band does.
 */
export type DocumentsSummaryRowFallback = {
  filterText: string;
  now?: Date;
  rows: readonly DocumentsSummaryRow[];
  windowDays?: number;
};

/**
 * The cards for the ONE reachable state the server cannot answer: a search term
 * longer than {@link DOCUMENT_LIST_MAX_SEARCH_LENGTH}, which
 * `GET /documents/summary` rejects with a 400.
 *
 * WHY THIS EXISTS RATHER THAN A ROW OF BLANKS. For that term the list abandons the
 * server read and falls back to the whole population narrowed in the browser, so
 * the rows are all in hand — and `updatedAt` and `latestVersion` are on every one
 * of them. Three of the four figures are therefore computable from operands that
 * are already rendering beside the band, which makes withholding them the defect
 * rather than the caution (AGENTS.md → "Never Delete a Capability You Cannot
 * Compute"; review-soul finding U on the first draft of this band, which withheld
 * all four under a "not measured" caption).
 *
 * `producedByAgentSessions` is the one genuinely absent operand and is NAMED as
 * such: provenance lives on `artifact_links`, which the browser never reads, so
 * there is nothing here to count. It keeps its card, keeps its label, keeps its
 * info popover, and states why it has no number — the shortfall disclosed beside
 * the figures rather than in place of them.
 *
 * The narrowing is `matchesFilter`, IMPORTED from the canonical owner that
 * `table-view-pipeline` already filters the rows with, so the band and the table
 * cannot disagree about which rows the term selected. Re-implementing the
 * predicate here is what would make this a second derivation.
 */
export function buildDocumentsSummaryCardsFromRows({
  filterText,
  now = new Date(),
  rows,
  windowDays = DOCUMENT_SUMMARY_WINDOW_DAYS,
}: DocumentsSummaryRowFallback): readonly DocumentsSummaryCard[] {
  const shown = rows.filter((row) => matchesFilter(row, filterText));
  const cutoff = now.getTime() - windowDays * MILLISECONDS_PER_DAY;
  const values: Record<DocumentsSummaryCardId, number | null> = {
    [DocumentsSummaryCardId.Total]: shown.length,
    [DocumentsSummaryCardId.ProducedBySessions]: null,
    [DocumentsSummaryCardId.UpdatedInWindow]: shown.filter(
      (row) => new Date(row.updatedAt).getTime() >= cutoff
    ).length,
    [DocumentsSummaryCardId.NeverEdited]: shown.filter(
      (row) => row.latestVersion <= 1
    ).length,
  };
  const details: Record<DocumentsSummaryCardId, string> = {
    [DocumentsSummaryCardId.Total]: DOCUMENTS_SUMMARY_ON_SCREEN_DETAIL,
    [DocumentsSummaryCardId.ProducedBySessions]:
      DOCUMENTS_SUMMARY_PROVENANCE_ABSENT_DETAIL,
    [DocumentsSummaryCardId.UpdatedInWindow]:
      documentsSummaryWindowDetail(windowDays),
    [DocumentsSummaryCardId.NeverEdited]: documentsSummaryDenominatorDetail(
      shown.length
    ),
  };
  return DOCUMENTS_SUMMARY_CARD_IDS.map((id) => ({
    id,
    label: DOCUMENTS_SUMMARY_CARD_LABELS[id],
    info: DOCUMENTS_SUMMARY_CARD_INFO[id],
    value: values[id],
    detail: details[id],
  }));
}

/**
 * The caption the total states in the row-counted fallback. It says WHICH
 * population produced the number, and that population really is everything the
 * list is showing — the arm this fallback runs on is the unbounded read, so the
 * rows on screen are the whole matching set rather than one page.
 */
export const DOCUMENTS_SUMMARY_ON_SCREEN_DETAIL = "Counted from the rows shown";

/** The shortfall, named: which operand this one card has no access to. */
export const DOCUMENTS_SUMMARY_PROVENANCE_ABSENT_DETAIL =
  "Session provenance not loaded for this search";

const MILLISECONDS_PER_DAY = 86_400_000;
