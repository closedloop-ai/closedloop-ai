import { DocumentType } from "@repo/api/src/types/document";
import { DOCUMENT_SUMMARY_WINDOW_DAYS } from "@repo/api/src/types/document-list-summary";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-8936 — the band host's own decisions, which nothing else scores.
 *
 * Every OTHER suite that mounts this component replaces it: the host-wiring suite
 * with a props recorder, the two flag-open siblings with a marker, and the strip's
 * own suite passes `isLoading` / `rowFallback` / `unavailableReason` in as literal
 * props. So the precedence this module composes — a refused term outranking a
 * forever-pending disabled query, a stale `keepPreviousData` scope reading as
 * loading, an error reaching the strip as a stated reason — had no coverage at all
 * (review-soul finding B). Each case here reddens under the specific mutation named
 * beside it.
 */
const mocks = vi.hoisted(() => ({
  useDocumentsSummary: vi.fn(),
  cardsProps: vi.fn(),
}));

vi.mock("@repo/app/documents/hooks/use-documents-summary", () => ({
  useDocumentsSummary: mocks.useDocumentsSummary,
}));
vi.mock("@repo/app/documents/components/documents-summary-cards", () => ({
  DocumentsSummaryCards: (props: Record<string, unknown>) => {
    mocks.cardsProps(props);
    return <div data-testid="summary-cards" />;
  },
}));

import { DocumentsSummaryBand } from "@repo/app/documents/components/index/documents-summary-band";

const SEARCH_PARAMS = {
  type: DocumentType.Doc,
  unassignedProject: true,
} as const;

const SUMMARY = {
  total: 1234,
  producedByAgentSessions: 817,
  updatedInWindow: 46,
  neverEdited: 213,
  windowDays: DOCUMENT_SUMMARY_WINDOW_DAYS,
};

const ROW = {
  title: "Runbook",
  slug: "DOC-1",
  latestVersion: 1,
  updatedAt: "2026-09-19T00:00:00.000Z",
};

/** What the hook reports, with every field a settled successful read would carry. */
function hookState(overrides: Record<string, unknown> = {}) {
  return {
    data: SUMMARY,
    isError: false,
    isPending: false,
    isPlaceholderData: false,
    ...overrides,
  };
}

/** The props the strip was handed on the last render. */
function cardsProps(): Record<string, unknown> {
  const props = mocks.cardsProps.mock.calls.at(-1)?.[0];
  if (props === undefined) {
    throw new Error("the strip was never rendered");
  }
  return props as Record<string, unknown>;
}

/** The options the hook was called with on the last render. */
function hookOptions(): Record<string, unknown> {
  const call = mocks.useDocumentsSummary.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error("the read was never issued");
  }
  return call[1] as Record<string, unknown>;
}

function renderBand(props: Record<string, unknown> = {}) {
  return render(
    <DocumentsSummaryBand
      filterText=""
      isPopulationUnsettled={false}
      isTermOverLong={false}
      rows={[]}
      searchParams={SEARCH_PARAMS}
      {...props}
    />
  );
}

describe("DocumentsSummaryBand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useDocumentsSummary.mockReturnValue(hookState());
  });

  it("passes a settled payload straight through", () => {
    renderBand();

    expect(cardsProps().summary).toEqual(SUMMARY);
    expect(cardsProps().isLoading).toBe(false);
    expect(cardsProps().unavailableReason).toBeUndefined();
    expect(cardsProps().rowFallback).toBeUndefined();
  });

  it("reads a pending query as loading", () => {
    // Kills: deleting `isPending` from the fold.
    mocks.useDocumentsSummary.mockReturnValue(
      hookState({ data: undefined, isPending: true })
    );

    renderBand();

    expect(cardsProps().isLoading).toBe(true);
  });

  it("reads a PREVIOUS scope's payload as loading, not as current", () => {
    // Kills: replacing `isServingPreviousScope: isPlaceholderData` with `false`.
    // `keepPreviousData` leaves the prior search's counts in hand; stating them as
    // the current population's is the ISS-9887 divergence.
    mocks.useDocumentsSummary.mockReturnValue(
      hookState({ isPlaceholderData: true })
    );

    renderBand();

    expect(cardsProps().isLoading).toBe(true);
  });

  it("reads an unsettled population as loading even on a settled payload", () => {
    // Kills: deleting `|| isPopulationUnsettled` from the fold.
    renderBand({ isPopulationUnsettled: true });

    expect(cardsProps().isLoading).toBe(true);
  });

  it("states a failed read as a reason rather than a number", () => {
    mocks.useDocumentsSummary.mockReturnValue(
      hookState({ data: undefined, isError: true })
    );

    renderBand();

    expect(cardsProps().summary).toBeUndefined();
    expect(cardsProps().unavailableReason).toBe("read-failed");
  });

  it("never issues a read the endpoint would refuse", () => {
    // Kills: deleting `enabled: !isTermOverLong` — the request would go out on
    // every keystroke past the 200-character bound and 400 every time.
    renderBand({ isTermOverLong: true });

    expect(hookOptions().enabled).toBe(false);
  });

  it("hands the strip the rows for a refused term, and only then", () => {
    // Kills: returning the fallback unconditionally, which would let a zero-row
    // page outrank a settled server payload on every arm.
    renderBand({ filterText: "x", isTermOverLong: true, rows: [ROW] });

    expect(cardsProps().rowFallback).toEqual({ filterText: "x", rows: [ROW] });

    renderBand({ filterText: "x", isTermOverLong: false, rows: [ROW] });

    expect(cardsProps().rowFallback).toBeUndefined();
  });

  it("withholds a payload the server never answered this term with", () => {
    // Kills: passing `summary` straight through on the refused-term arm. The
    // hook is mocked here as it behaves in the browser for an over-long term —
    // the search is dropped, so the key collapses to the unfiltered one the page
    // loaded with, and a cached or `keepPreviousData` payload comes back with
    // `isPending` false. Ranked above the row fallback that is the WHOLE-ORG
    // counts stated as the narrowed population's.
    mocks.useDocumentsSummary.mockReturnValue(hookState({ data: SUMMARY }));

    renderBand({ filterText: "x", isTermOverLong: true, rows: [ROW] });

    // Paired: the fallback the strip MUST be handed, beside the payload it must
    // not, so neither assertion can be satisfied by a strip that never rendered.
    expect(cardsProps().rowFallback).toEqual({ filterText: "x", rows: [ROW] });
    expect(cardsProps().summary).toBeUndefined();
  });

  it("withholds the row fallback until the rows it counts have settled", () => {
    // Kills: dropping `isPopulationUnsettled` from `resolveRowFallback`. The
    // fallback outranks the skeleton, so a cold unbounded read's empty `rows`
    // handed over here paints four settled zeroes for a population nothing has
    // counted yet.
    renderBand({
      filterText: "x",
      isPopulationUnsettled: true,
      isTermOverLong: true,
      rows: [],
    });

    expect(cardsProps().rowFallback).toBeUndefined();
    expect(cardsProps().isLoading).toBe(true);

    // Presence half: the same locator DOES resolve once the rows settle.
    renderBand({
      filterText: "x",
      isPopulationUnsettled: false,
      isTermOverLong: true,
      rows: [ROW],
    });

    expect(cardsProps().rowFallback).toEqual({ filterText: "x", rows: [ROW] });
  });
});
