import { fireEvent, screen, within } from "@testing-library/react";
import {
  type BothHostRenderContract,
  foundOrAbsent,
} from "../../shared/testing/both-host-render-contract";
import { HELP_SURFACE_V2_PAGE_ERROR_TEST_ID } from "../components/help-reader";
import {
  HELP_SURFACE_V2_SEARCH_FAILED_TEST_ID,
  HELP_SURFACE_V2_TEST_ID,
  HELP_SURFACE_V2_UNAVAILABLE_TEST_ID,
} from "../lib/docs-help-test-ids";

/**
 * ISS-10005 — the states every shell that mounts Help owes its reader, asserted
 * against each shell's REAL mount from inside that shell's own suite.
 *
 * The surface's own suite proves it renders when handed a `DocsHelpSource`. It
 * cannot prove the shell's ADAPTER produces one — bundle status, nav tree, page
 * fetch and docs URL are host code over a transport `packages/app` never sees,
 * and a host that stopped supplying any of them leaves that suite green.
 *
 * ISS-10006 ADDED THE WEB RUNNER, and it passes every case with no `divergence`
 * entry: Help has no device-only capability, so there is nothing for web to be
 * excused from. The two hosts differ only below this contract, in the transport
 * — four IPC calls over a packed snapshot, three HTTP reads against the
 * deployment — which is exactly the seam this file exists to hold constant.
 */

/** What one host's docs bundle answers with. */
export type DocsHelpHostFixture = {
  /** `status.available` — whether this host has a readable bundle at all. */
  readonly available: boolean;
  /** The `nav` result, as it arrives — shapes included that the guard refuses. */
  readonly navGroups: unknown;
  /** The `getPage` result for whatever the host selects. */
  readonly page: unknown;
  /**
   * ISS-10044 — the page transport REJECTS instead of answering. A separate
   * field rather than a sentinel in `page`, because what a host must reproduce
   * here is a rejected promise, and no `page` value can be one.
   */
  readonly pageRejects?: boolean;
  /** The same, for the search transport. */
  readonly searchRejects?: boolean;
};

const NO_RESULTS_COPY = /No results for/;
/**
 * The not-found TITLE, which the surface owns. ISS-10006 made the sentence under
 * it host-supplied — desktop says "the bundled docs snapshot", web says "the
 * documentation we're serving" — so a contract matching on that sentence would
 * be asserting one host's vocabulary against both.
 */
const PAGE_MISSING_COPY = /^Page not found$/;
const SEARCH_INPUT_LABEL = "Search documentation";
const SEARCH_QUERY = "kubernetes";

/**
 * Type a query into the pane's own search box and let the host's debounce run.
 * The rejection both search cases exercise only exists once a query goes out,
 * so it cannot be reached by mounting a fixture alone.
 */
async function runSearch(): Promise<void> {
  const input = await foundOrAbsent(() =>
    screen.findByLabelText(SEARCH_INPUT_LABEL)
  );
  if (input === undefined) {
    return;
  }
  fireEvent.change(input, { target: { value: SEARCH_QUERY } });
}
const READABLE_PAGE_TITLE = "Loops";
const READABLE_NAV_ROW = "Overview";
const VIEW_ONLINE_NAME = /View online/;
const UNREADABLE_GROUP_NAME = "Reference";

/**
 * Every element handed over must sit inside the surface's own root, or the shell
 * is still rendering its own copy of a body this ticket moved.
 */
async function problemUnlessInsideSurface(
  elements: readonly HTMLElement[]
): Promise<string | undefined> {
  const root = await foundOrAbsent(() =>
    screen.findByTestId(HELP_SURFACE_V2_TEST_ID)
  );
  if (root === undefined) {
    return "nothing rendered the surface's own root, so the shell is still composing this body itself";
  }
  return elements.every((element) => root.contains(element))
    ? undefined
    : "the body rendered outside the surface's own root";
}

function readableNavGroups(): unknown[] {
  return [
    {
      group: "Getting Started",
      pages: [{ path: "getting-started/overview", title: READABLE_NAV_ROW }],
    },
    {
      group: "Concepts",
      pages: [{ path: "concepts/loops", title: READABLE_PAGE_TITLE }],
    },
  ];
}

function readablePage(): unknown {
  return {
    kind: "found",
    page: {
      body: "## Lifecycle\n\nHow a loop runs.",
      headings: [{ level: 2, slug: "lifecycle", text: "Lifecycle" }],
      path: "getting-started/overview",
      title: READABLE_PAGE_TITLE,
    },
  };
}

export const HELP_BOTH_HOST_CONTRACT: BothHostRenderContract<DocsHelpHostFixture> =
  {
    cases: [
      {
        fixture: {
          available: true,
          navGroups: readableNavGroups(),
          page: readablePage(),
        },
        name: "a readable bundle renders the nav tree and a page in the surface's own root",
        renderProblem: async () => {
          const row = await foundOrAbsent(() =>
            screen.findByText(READABLE_NAV_ROW)
          );
          if (row === undefined) {
            return `no nav row named ${READABLE_NAV_ROW} ever rendered`;
          }
          const heading = await foundOrAbsent(() =>
            screen.findByRole("heading", {
              level: 1,
              name: READABLE_PAGE_TITLE,
            })
          );
          if (heading === undefined) {
            return `the reader never showed a page titled ${READABLE_PAGE_TITLE}`;
          }
          // Containment, not a scoped query: the superseded body composes the
          // SAME nav pane and reader, so what distinguishes this ticket is that
          // both rendered INSIDE the surface's own root.
          return await problemUnlessInsideSurface([row, heading]);
        },
      },
      {
        fixture: {
          available: true,
          // ISS-10005 AC2. A group that predates `pages` is what the nav tree
          // calls `.map` on during render, and what the host's own default-page
          // pick indexes into — unguarded, either one takes the route down.
          // Placed FIRST on purpose: that is the position that reaches both.
          navGroups: [{ group: "Reference" }, ...readableNavGroups()],
          page: readablePage(),
        },
        name: "an unreadable nav group is dropped and the rest of the docs survive",
        renderProblem: async () => {
          const row = await foundOrAbsent(() =>
            screen.findByText(READABLE_NAV_ROW)
          );
          if (row === undefined) {
            return "an unreadable group cost the reader the groups that were intact";
          }
          // "It did not crash" is not observable on its own — prove the shell is
          // still answering by requiring the reader beside it to have rendered.
          const heading = await foundOrAbsent(() =>
            screen.findByRole("heading", {
              level: 1,
              name: READABLE_PAGE_TITLE,
            })
          );
          if (heading === undefined) {
            return "the reader stopped rendering beside an unreadable nav group";
          }
          if (screen.queryByText(UNREADABLE_GROUP_NAME) !== null) {
            return `the unreadable group ${UNREADABLE_GROUP_NAME} was rendered anyway`;
          }
          return await problemUnlessInsideSurface([row, heading]);
        },
      },
      {
        fixture: {
          available: true,
          navGroups: readableNavGroups(),
          page: { kind: "missing" },
        },
        name: "a page the snapshot does not hold still says so in its own words",
        renderProblem: async () => {
          // ISS-10044's positive sibling. The failure case below asserts the
          // not-found sentence is ABSENT, and without this nothing shows that
          // locator ever matches — a host that had quietly stopped rendering
          // not-found at all would satisfy the failure case on its own.
          const notFound = await foundOrAbsent(() =>
            screen.findByText(PAGE_MISSING_COPY)
          );
          if (notFound === undefined) {
            return "a genuinely absent page rendered no not-found copy";
          }
          if (screen.queryByTestId(HELP_SURFACE_V2_PAGE_ERROR_TEST_ID)) {
            return "a genuinely absent page was reported as a failed read";
          }
          return await problemUnlessInsideSurface([notFound]);
        },
      },
      {
        fixture: {
          available: true,
          navGroups: readableNavGroups(),
          page: readablePage(),
          pageRejects: true,
        },
        name: "a page read that never came back is not reported as a page the snapshot lacks",
        renderProblem: async () => {
          const failure = await foundOrAbsent(() =>
            screen.findByTestId(HELP_SURFACE_V2_PAGE_ERROR_TEST_ID)
          );
          if (failure === undefined) {
            return "a rejected page read rendered no failure state";
          }
          // The whole defect: `page` above IS readable, so any not-found
          // sentence here is a claim about the snapshot manufactured from a
          // request that never returned.
          if (screen.queryByText(PAGE_MISSING_COPY) !== null) {
            return "a rejected page read was presented as a page missing from the snapshot";
          }
          const link = await foundOrAbsent(() =>
            within(failure).findByRole("link", { name: VIEW_ONLINE_NAME })
          );
          if (link === undefined) {
            return "the failure state offered no way to read the docs online";
          }
          return await problemUnlessInsideSurface([failure]);
        },
      },
      {
        fixture: {
          available: true,
          navGroups: readableNavGroups(),
          page: readablePage(),
          searchRejects: true,
        },
        name: "a search that never ran is not reported as a query that matched nothing",
        renderProblem: async () => {
          await runSearch();
          const failure = await foundOrAbsent(() =>
            screen.findByTestId(HELP_SURFACE_V2_SEARCH_FAILED_TEST_ID)
          );
          if (failure === undefined) {
            return "a rejected search rendered no failure state";
          }
          if (screen.queryByText(NO_RESULTS_COPY) !== null) {
            return "a rejected search was presented as a query that matched nothing";
          }
          const link = await foundOrAbsent(() =>
            within(failure).findByRole("link", { name: VIEW_ONLINE_NAME })
          );
          if (link === undefined) {
            return "the failed search offered no way to reach the docs online";
          }
          return await problemUnlessInsideSurface([failure]);
        },
      },
      {
        fixture: {
          available: true,
          navGroups: readableNavGroups(),
          page: readablePage(),
        },
        name: "a search that ran and matched nothing still says so in its own words",
        renderProblem: async () => {
          // The positive sibling for the case above: without it, a host that had
          // stopped rendering the no-results line at all would satisfy that
          // case's absence assertion on its own.
          await runSearch();
          const empty = await foundOrAbsent(() =>
            screen.findByText(NO_RESULTS_COPY)
          );
          if (empty === undefined) {
            return "a search that genuinely matched nothing rendered no no-results copy";
          }
          if (screen.queryByTestId(HELP_SURFACE_V2_SEARCH_FAILED_TEST_ID)) {
            return "a search that ran was reported as a search that failed";
          }
          return await problemUnlessInsideSurface([empty]);
        },
      },
      {
        fixture: { available: false, navGroups: [], page: { kind: "missing" } },
        name: "an unavailable bundle offers the online escape hatch instead of an empty tree",
        renderProblem: async () => {
          const notice = await foundOrAbsent(() =>
            screen.findByTestId(HELP_SURFACE_V2_UNAVAILABLE_TEST_ID)
          );
          if (notice === undefined) {
            return "an unavailable bundle rendered no unavailable notice";
          }
          const link = await foundOrAbsent(() =>
            screen.findByRole("link", { name: VIEW_ONLINE_NAME })
          );
          if (link === undefined || !notice.contains(link)) {
            return "the unavailable notice offered no way to read the docs online";
          }
          return await problemUnlessInsideSurface([notice]);
        },
      },
    ],
    surface: "HelpSurfaceV2",
  };
