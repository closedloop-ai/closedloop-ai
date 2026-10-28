import { SEARCH_SURFACE_V2_TEST_ID } from "@repo/app/search/components/search-surface-v2";
import type { SearchSurfaceResult } from "@repo/app/search/lib/search-surface-model";
import type { BothHostRenderContract } from "@repo/app/shared/testing/both-host-render-contract";
import { foundOrAbsent } from "@repo/app/shared/testing/both-host-render-contract";
import { screen } from "@testing-library/react";
import { FileTextIcon } from "lucide-react";

/**
 * ISS-9414 — what `SearchSurfaceV2` owes its reader on BOTH shells: AC1, the
 * same ordering, labels and destinations from the same fixture.
 *
 * The two shells render the same results into DIFFERENT containers on purpose —
 * a page renders a list of links, a palette renders a `cmdk` group — and each
 * resolves an href through its own navigation port. So "the rows are the same"
 * is exactly the claim that a single-shell suite cannot make and this one can.
 *
 * WHAT THE SUFFIX CHECK DOES AND DOES NOT COVER. It tolerates a host PREFIX
 * (web's org slug, desktop's `#`) so a real adapter difference is not read as a
 * divergence. The desktop half runs the real adapter and therefore does pin
 * that rewrite; the web half stubs the port, so web's org prefix is pinned by
 * `e2e/search-surface-v2.spec.ts`, not here.
 *
 * Each shell supplies only `mount`, in its own suite, under its own provider
 * stack and module graph.
 *
 * THE FIXTURE IS WRITTEN OUT, NOT DERIVED. It imports no label map, no icon
 * map, and no route builder from the code under test: a fixture that asks the
 * production mapping what a "Document" is called cannot fail when that mapping
 * changes, which is the one thing a labels contract exists to catch. The one
 * import from production here is the surface's root test id, because a locator
 * is how the check finds the surface, not part of what it asserts.
 */

export type SearchSurfaceBothHostFixture = {
  readonly results: readonly SearchSurfaceResult[];
};

/**
 * TWO results, not one: a shell that renders a single hard-coded row satisfies
 * a one-row fixture, and ORDER — half of AC1 — needs at least two to exist.
 *
 * The destinations are deliberately distinct at every suffix, so an
 * `endsWith` check cannot be satisfied by the wrong row's href, and neither is
 * a prefix of the other.
 */
export const CONTRACT_SEARCH_RESULTS: readonly SearchSurfaceResult[] = [
  {
    key: "contract-alpha",
    kindLabel: "Plan",
    title: "Both-host contract alpha",
    snippet: "the <b>alpha</b> match context",
    destination: "/plns/both-host-alpha",
    meta: "Updated 4 Sep 2026",
    icon: FileTextIcon,
  },
  {
    key: "contract-beta",
    kindLabel: "Session",
    title: "Both-host contract beta",
    snippet: "the <b>beta</b> match context",
    destination: "/sessions/both-host-beta",
    icon: FileTextIcon,
  },
];

/** The read behind a `Ready` render, so a shell cannot mount a different one. */
export const CONTRACT_READY_READ = {
  hasRun: true,
  isLoading: false,
  isUnavailable: false,
  unavailableReason: null,
  resultCount: CONTRACT_SEARCH_RESULTS.length,
} as const;

/**
 * Every result, in the fixture's order, linking where the fixture says.
 *
 * Reads the hrefs off the surface's OWN subtree rather than the document, so a
 * shell whose chrome happens to render other links nearby cannot pad the
 * sequence into agreement. `endsWith` rather than equality because the org
 * prefix and the hash prefix are precisely the host-boundary difference the
 * contract permits — the destination itself is not.
 */
async function destinationsInFixtureOrder({
  results,
}: SearchSurfaceBothHostFixture): Promise<string | undefined> {
  const surface = await foundOrAbsent(() =>
    screen.findByTestId(SEARCH_SURFACE_V2_TEST_ID)
  );
  if (surface === undefined) {
    return "the surface root is not on screen at all";
  }
  const rendered = [...surface.querySelectorAll("a[href]")].map(
    (anchor) => anchor.getAttribute("href") ?? ""
  );
  const expected = results.flatMap((result) =>
    result.destination === null ? [] : [result.destination]
  );
  if (rendered.length !== expected.length) {
    return `the surface rendered ${rendered.length} linked rows for ${expected.length} linkable results`;
  }
  for (const [index, destination] of expected.entries()) {
    const href = rendered[index] ?? "";
    if (!href.endsWith(destination)) {
      return `linked row ${index + 1} points at "${href}", which does not end in the fixture's destination "${destination}"`;
    }
  }
  return undefined;
}

/**
 * Every result names itself AND says what kind of thing it is, in the row that
 * links to it.
 *
 * `findByText` singular: a second element carrying this title is an ambiguous
 * match, which `foundOrAbsent` re-throws rather than laundering into the
 * absence sentence a divergence entry would accept. So one row losing its title
 * and another rendering it twice reddens twice over.
 *
 * The kind label is then read off THAT ROW, not off the document. A shell that
 * prints every label once in a legend would satisfy a document-wide check while
 * pairing every row with the wrong kind.
 */
async function everyResultNamedAndKinded({
  results,
}: SearchSurfaceBothHostFixture): Promise<string | undefined> {
  for (const result of results) {
    const title = await foundOrAbsent(() => screen.findByText(result.title));
    if (title === undefined) {
      return `no element names the result "${result.title}"`;
    }
    const row = title.closest("a[href]");
    if (row === null) {
      return `the title "${result.title}" is not inside a linked row`;
    }
    if (!(row.textContent ?? "").includes(result.kindLabel)) {
      return `the row for "${result.title}" does not carry its kind label "${result.kindLabel}"`;
    }
  }
  return undefined;
}

/**
 * The snippet's match markers become real `<mark>`s, in the row they belong to.
 *
 * Included because it is the one part of a row that is PARSED rather than
 * echoed, so it is where a shell could silently fall back to printing raw
 * `<b>` markers as text — visible to a reader, invisible to a title check.
 */
async function everySnippetHighlighted({
  results,
}: SearchSurfaceBothHostFixture): Promise<string | undefined> {
  for (const result of results) {
    const title = await foundOrAbsent(() => screen.findByText(result.title));
    if (title === undefined) {
      return `no element names the result "${result.title}"`;
    }
    const row = title.closest("a[href]");
    if (row === null) {
      return `the title "${result.title}" is not inside a linked row`;
    }
    if (row.querySelector("mark") === null) {
      return `the row for "${result.title}" renders no highlighted snippet run`;
    }
    if ((row.textContent ?? "").includes("<b>")) {
      return `the row for "${result.title}" printed the snippet's raw markers as text`;
    }
  }
  return undefined;
}

export const SEARCH_SURFACE_BOTH_HOST_CONTRACT: BothHostRenderContract<SearchSurfaceBothHostFixture> =
  {
    surface: "Search surface v2",
    cases: [
      {
        fixture: { results: CONTRACT_SEARCH_RESULTS },
        name: "links every result to its own destination, in the ranked order",
        renderProblem: destinationsInFixtureOrder,
      },
      {
        fixture: { results: CONTRACT_SEARCH_RESULTS },
        name: "names every result and its kind in the row that links to it",
        renderProblem: everyResultNamedAndKinded,
      },
      {
        fixture: { results: CONTRACT_SEARCH_RESULTS },
        name: "renders the snippet's match runs as highlights, not as markup",
        renderProblem: everySnippetHighlighted,
      },
    ],
  };
