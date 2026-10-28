import { DocumentType } from "@repo/api/src/types/document";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import {
  countMatchingDocuments,
  type DocumentsIndexReadState,
  DocumentsIndexState,
  hasActiveSearch,
  resolveDocumentsIndexState,
} from "@repo/app/documents/lib/documents-index-state";
import { describe, expect, it } from "vitest";

/**
 * ISS-8940. The states are a partition, so the assertions below are written as
 * independent reads whose expected verdicts are typed out by hand — not derived
 * from the resolver's own branches, which would agree with whatever it
 * currently does.
 *
 * PRD-695 §2 names six. The seventh, `StaleNoResults`, was added on whitlockk's
 * review (cid 3955716628) because the six were not exclusive: a failed refresh
 * whose cached rows all fall outside the active search answered to two of them
 * at once.
 */

// A settled, successful, populated read. Each case below names only the fields
// that make it the state under test, so a case cannot pass by accident on a
// field it never set.
const SETTLED: DocumentsIndexReadState = {
  isLoading: false,
  isFetching: false,
  isError: false,
  rowCount: 3,
  matchCount: 3,
  hasSearch: false,
  // The client-side filter, so `rowCount` is the population. Every case below
  // that does not say otherwise is describing that read.
  searchAppliedUpstream: false,
};

function read(
  overrides: Partial<DocumentsIndexReadState>
): DocumentsIndexReadState {
  return { ...SETTLED, ...overrides };
}

function doc(id: string, title: string): DocumentRowData {
  return {
    id,
    title,
    // `matchesFilter` searches title OR slug, so a fixture without a slug would
    // exercise a different predicate than production rows do.
    slug: `DOC-${id}`,
    type: DocumentType.Doc,
    projectId: null,
  } as unknown as DocumentRowData;
}

describe("resolveDocumentsIndexState", () => {
  it("reports a settled populated read as populated", () => {
    expect(resolveDocumentsIndexState(SETTLED)).toBe(
      DocumentsIndexState.Populated
    );
  });

  it("reports a first read with nothing yet as loading, not empty", () => {
    expect(
      resolveDocumentsIndexState(
        read({ isLoading: true, isFetching: true, rowCount: 0, matchCount: 0 })
      )
    ).toBe(DocumentsIndexState.Loading);
  });

  it("reports an in-flight read with no rows yet as loading, not empty", () => {
    // The ISS-7370 shape: `isLoading` has already flipped false (a cached
    // no-data entry exists) while the request that will produce rows is still
    // open. A count reported here would be an unsettled zero.
    expect(
      resolveDocumentsIndexState(
        read({ isFetching: true, rowCount: 0, matchCount: 0 })
      )
    ).toBe(DocumentsIndexState.Loading);
  });

  it("reports a settled read with no documents as first-use empty", () => {
    expect(
      resolveDocumentsIndexState(read({ rowCount: 0, matchCount: 0 }))
    ).toBe(DocumentsIndexState.FirstUseEmpty);
  });

  it("reports a search that matches none of the existing documents as no-results", () => {
    expect(
      resolveDocumentsIndexState(
        read({ rowCount: 3, matchCount: 0, hasSearch: true })
      )
    ).toBe(DocumentsIndexState.NoResults);
  });

  it("reports a search that narrows without emptying the list as populated", () => {
    // The ordinary case: a search is active and still matches something. Only a
    // match set of exactly zero is a no-results verdict.
    expect(
      resolveDocumentsIndexState(
        read({ rowCount: 3, matchCount: 1, hasSearch: true })
      )
    ).toBe(DocumentsIndexState.Populated);
  });

  it("reports a search that matches everything as populated", () => {
    expect(
      resolveDocumentsIndexState(
        read({ rowCount: 3, matchCount: 3, hasSearch: true })
      )
    ).toBe(DocumentsIndexState.Populated);
  });

  it("reports a failed read with no cached rows as a blocking error", () => {
    expect(
      resolveDocumentsIndexState(
        read({ isError: true, rowCount: 0, matchCount: 0 })
      )
    ).toBe(DocumentsIndexState.BlockingError);
  });

  it("reports a failed refresh over cached rows as stale, not as an error and not as populated", () => {
    const state = resolveDocumentsIndexState(read({ isError: true }));
    expect(state).toBe(DocumentsIndexState.StaleAfterFailedRefresh);
    expect(state).not.toBe(DocumentsIndexState.BlockingError);
    expect(state).not.toBe(DocumentsIndexState.Populated);
  });

  it("calls an empty organization first-use empty even while a search is typed", () => {
    // The pre-ISS-8940 derivation reached neither empty branch here and let the
    // table claim a filter was hiding rows that do not exist.
    expect(
      resolveDocumentsIndexState(
        read({ rowCount: 0, matchCount: 0, hasSearch: true })
      )
    ).toBe(DocumentsIndexState.FirstUseEmpty);
  });

  it("keeps a failed refresh over cached rows stale while the retry is in flight", () => {
    // `isError` and `isFetching` are both true for the whole of the refetch the
    // "Try again" button fires. With rows still on screen the honest word is
    // stale: they have not gone anywhere, and replacing them with a skeleton
    // would take away the only usable thing on the surface.
    expect(
      resolveDocumentsIndexState(read({ isError: true, isFetching: true }))
    ).toBe(DocumentsIndexState.StaleAfterFailedRefresh);
  });

  it("shows an in-flight retry with nothing cached as loading, not as a standing error", () => {
    // The other half of the same pair, pinned so the precedence between the
    // loading check and the failure check is asserted rather than merely never
    // exercised. Here there is nothing to keep on screen, so a request that IS
    // open reads as loading — the error returns if this attempt also fails.
    expect(
      resolveDocumentsIndexState(
        read({ isError: true, isFetching: true, rowCount: 0, matchCount: 0 })
      )
    ).toBe(DocumentsIndexState.Loading);
  });

  it("splits a failure on the row count alone, naming each side", () => {
    expect(
      resolveDocumentsIndexState(
        read({ isError: true, rowCount: 1, matchCount: 1 })
      )
    ).toBe(DocumentsIndexState.StaleAfterFailedRefresh);
    expect(
      resolveDocumentsIndexState(
        read({ isError: true, rowCount: 0, matchCount: 0 })
      )
    ).toBe(DocumentsIndexState.BlockingError);
  });

  it("keeps a search verdict from outranking an empty population", () => {
    // Precedence, asserted as precedence: with no documents at all the answer
    // is the population's, never the filter's, whatever the search says. The
    // read is the client-filtered one, which is what makes `rowCount` a
    // population count and this verdict knowable (see the ISS-9762 pair below).
    expect(
      resolveDocumentsIndexState(
        read({ rowCount: 0, matchCount: 0, hasSearch: true })
      )
    ).not.toBe(DocumentsIndexState.NoResults);
  });

  it("names a failed refresh whose cached rows all fall outside the search as its own state", () => {
    // whitlockk review, cid 3955716628. This read satisfied BOTH the stale and the
    // no-results descriptions, and the surface rendered both — a "showing your
    // last loaded documents" banner over a screen showing none of them. It is
    // one state, so the resolver names it rather than leaving the body to
    // compose two.
    const state = resolveDocumentsIndexState(
      read({ isError: true, rowCount: 3, matchCount: 0, hasSearch: true })
    );
    expect(state).toBe(DocumentsIndexState.StaleNoResults);
    expect(state).not.toBe(DocumentsIndexState.StaleAfterFailedRefresh);
    expect(state).not.toBe(DocumentsIndexState.NoResults);
  });

  it("keeps a failed refresh whose rows DO match the search on the plain stale state", () => {
    // The other half of the pair, so the new split is asserted as a split and
    // not merely as one extra case: rows are on screen here, so the banner over
    // them is true and the combined state must not fire.
    expect(
      resolveDocumentsIndexState(
        read({ isError: true, rowCount: 3, matchCount: 1, hasSearch: true })
      )
    ).toBe(DocumentsIndexState.StaleAfterFailedRefresh);
  });

  it("splits a zero-row search on whether the rows arrived already searched", () => {
    // ISS-9762, the whole defect in one pair. Both reads are indistinguishable
    // from the payload — zero rows, zero matches, a term in the box — and they
    // are opposite facts: one organization has documents that did not match,
    // the other has none. What separates them is whose count `rowCount` is.
    expect(
      resolveDocumentsIndexState(
        read({
          rowCount: 0,
          matchCount: 0,
          hasSearch: true,
          searchAppliedUpstream: true,
        })
      )
    ).toBe(DocumentsIndexState.NoResults);
    expect(
      resolveDocumentsIndexState(
        read({
          rowCount: 0,
          matchCount: 0,
          hasSearch: true,
          searchAppliedUpstream: false,
        })
      )
    ).toBe(DocumentsIndexState.FirstUseEmpty);
  });

  it("leaves a server-answered search that returned rows populated", () => {
    // The other side of the widened guard: knowing the rows were pre-searched
    // must not make every searched read a zero-row verdict.
    expect(
      resolveDocumentsIndexState(
        read({
          rowCount: 2,
          matchCount: 2,
          hasSearch: true,
          searchAppliedUpstream: true,
        })
      )
    ).toBe(DocumentsIndexState.Populated);
  });

  it("gives every distinct read its own state, so no two collapse", () => {
    const states = [
      resolveDocumentsIndexState(read({ isLoading: true, rowCount: 0 })),
      resolveDocumentsIndexState(SETTLED),
      resolveDocumentsIndexState(read({ rowCount: 0, matchCount: 0 })),
      resolveDocumentsIndexState(read({ matchCount: 0, hasSearch: true })),
      resolveDocumentsIndexState(read({ isError: true, rowCount: 0 })),
      resolveDocumentsIndexState(read({ isError: true })),
      resolveDocumentsIndexState(
        read({ isError: true, matchCount: 0, hasSearch: true })
      ),
    ];
    expect(new Set(states).size).toBe(7);
  });
});

describe("hasActiveSearch", () => {
  it("treats blank and whitespace-only text as no search", () => {
    expect(hasActiveSearch("")).toBe(false);
    expect(hasActiveSearch("   ")).toBe(false);
  });

  it("treats any non-blank text as a search", () => {
    expect(hasActiveSearch("runbook")).toBe(true);
  });
});

describe("countMatchingDocuments", () => {
  it("counts only the documents whose title matches, case-insensitively", () => {
    const documents = [
      doc("d1", "Incident runbook"),
      doc("d2", "Hiring plan"),
      doc("d3", "RUNBOOK archive"),
    ];
    expect(countMatchingDocuments(documents, "runbook")).toBe(2);
  });

  it("counts every document when no search narrows the list", () => {
    const documents = [doc("d1", "Incident runbook"), doc("d2", "Hiring plan")];
    expect(countMatchingDocuments(documents, "")).toBe(documents.length);
  });

  it("counts a document the reader found by its slug", () => {
    // The shared predicate matches title OR slug, and the slug is how these
    // artifacts are actually referenced. A title-only re-implementation would
    // pass every other case in this file and then tell a reader searching
    // "DOC-d1" that none of their documents match a row that does.
    expect(countMatchingDocuments([doc("d1", "Hiring plan")], "DOC-d1")).toBe(
      1
    );
  });

  it("counts zero when a search matches nothing", () => {
    expect(countMatchingDocuments([doc("d1", "Hiring plan")], "runbook")).toBe(
      0
    );
  });
});
