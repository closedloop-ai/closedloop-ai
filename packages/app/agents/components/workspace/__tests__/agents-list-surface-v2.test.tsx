import {
  type AgentComponent,
  AgentComponentKind,
} from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_PAGE_SIZE } from "@repo/api/src/utils/agent-component-page-data";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EXPECTED_TYPE_TAB_SEGMENTS } from "../../../__tests__/type-tab-strip-vocabulary";
import { makeComponent } from "../agent-component-fixtures";
import {
  AGENTS_LIST_SURFACE_V2_SCROLL_TEST_ID,
  AGENTS_LIST_SURFACE_V2_TEST_ID,
  AGENTS_PLUGIN_MANAGEMENT_TEST_ID,
  AgentsListSurfaceV2,
} from "../agents-list-surface-v2";
import { testDataSource, Wrapper } from "./agents-grouped-list-harness";

/**
 * ISS-9398 — the four things `AgentsListSurfaceV2` owns that a host used to be
 * able to answer, driven through the real surface.
 *
 * Deliberately NOT re-testing what `AgentsGroupedList`'s suites already cover on
 * the same shared parts — the grouping, the facet counts, the empty copy, the
 * type-tab permalink. Those are the surface's INPUTS, unchanged by this ticket.
 * What is new is who decides: whether pagination renders, whether a management
 * panel appears, which of the complete states is selected, and that the tab
 * vocabulary is the one vocabulary rather than a second copy.
 */

/**
 * The test ids, as the E2E specs spell them.
 *
 * Neither Playwright suite can import these. A `@repo/app/...` subpath does not
 * resolve under the web spec's ESM loader — it drags in this surface's
 * view-model hook and then `@repo/navigation/use-navigation`, whose named export
 * fails and aborts `playwright --list` for the WHOLE suite — and the Electron
 * suite has the same constraint recorded in its own header. So both specs
 * restate these as literals, and this is what stops the literals drifting:
 *
 *   - `e2e/agents-list-surface-v2.spec.ts`
 *   - `apps/desktop/test/e2e/agents-list-surface-v2.spec.ts`
 *
 * Renaming a constant without updating both specs fails HERE, in a fast jsdom
 * lane, rather than as a silent green E2E that asserts on a selector nothing
 * renders any more.
 */
describe("the test ids the E2E specs pin as literals", () => {
  it("still spell what both Playwright suites hardcode", () => {
    expect(AGENTS_LIST_SURFACE_V2_TEST_ID).toBe("agents-list-surface-v2");
    expect(AGENTS_PLUGIN_MANAGEMENT_TEST_ID).toBe("agents-plugin-management");
    expect(AGENTS_LIST_SURFACE_V2_SCROLL_TEST_ID).toBe(
      "agents-list-surface-v2-scroll"
    );
  });
});

const PLUGIN_PANEL_TEXT = "Desktop plugin management";
const PAGINATION_LABEL = "pagination";
const NEXT_PAGE_LABEL = "Go to next page";
const RE_LOADING = /loading components/i;
const RE_PLUGINS_TAB = /plugins/i;
/** The tab strip's own `aria-label`, which nothing else on the surface emits. */
const TYPE_TAB_GROUP_LABEL = "Component type";
const RE_PAGED_ROW = /^Paged Agent /;
const RE_LOAD_FAILED = /couldn't load components/i;
const RE_NO_COMPONENTS_YET = /no components yet/i;
/** Pinned as literals: reading them from the component under test proves nothing. */
const POPULATION_CAPTION = "matched by the current filters";
const LOADING_CAPTION = "Loading\u2026";
const UNAVAILABLE_CAPTION = "Unavailable";
const COMPONENTS_CARD_LABEL = "Components";

/** The Components card's own subtree, so a `0` in a table cell cannot answer. */
function componentsCard(): HTMLElement {
  const card = screen
    .getByText(COMPONENTS_CARD_LABEL)
    .closest("[data-slot='card']");
  if (!card) {
    throw new Error("Components summary card not found");
  }
  return card as HTMLElement;
}

/** Two full pages plus one row, so `totalPages` is unambiguously above one. */
const TWO_PAGES: AgentComponent[] = Array.from(
  { length: AGENT_COMPONENT_PAGE_SIZE + 1 },
  (_, index) =>
    makeComponent({
      id: `uuid-paged-${String(index)}`,
      kind: AgentComponentKind.Subagent,
      name: `Paged Agent ${String(index)}`,
      slug: `subagent::paged-${String(index)}`,
    })
);

const ONE_PLUGIN: AgentComponent[] = [
  makeComponent({
    id: "uuid-plugin-1",
    kind: AgentComponentKind.Plugin,
    name: "Installed Plugin",
    slug: "plugin::installed",
  }),
];

const componentHref = (item: AgentComponent) => `/agents/${item.slug}`;

/** The row links on the page currently rendered. */
function pagedRowNames(): (string | null)[] {
  return screen
    .getAllByRole("link", { name: RE_PAGED_ROW })
    .map((link) => link.textContent);
}

/**
 * The type strip's segment labels, read through the strip's OWN `radiogroup`.
 *
 * Unscoped, `getAllByRole("radio")` also collects the time-window control's four
 * segments, which are radios on the same toolbar — so the first draft of this
 * compared eight tabs against twelve radios and failed for the right reason by
 * luck. A locator has to name a container only the surface under test emits.
 */
function typeTabLabels(): (string | null)[] {
  return within(screen.getByRole("radiogroup", { name: TYPE_TAB_GROUP_LABEL }))
    .getAllByRole("radio")
    .map((tab) => tab.textContent);
}

describe("AgentsListSurfaceV2 plugin-management capability", () => {
  /**
   * A host WITH the bridge, and the same surface without it, on the same tab and
   * the same rows. The absence case needs the positive one beside it: an
   * assertion that the panel is missing would also pass on a surface that
   * rendered nothing at all.
   */
  it("renders a declaring host's panel under the Plugins tab", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper dataSource={testDataSource(ONE_PLUGIN)}>
        <AgentsListSurfaceV2
          getComponentHref={componentHref}
          persistKey="agents:test-desktop"
          pluginManagement={{
            renderPanel: () => <div>{PLUGIN_PANEL_TEXT}</div>,
          }}
        />
      </Wrapper>
    );

    await screen.findByText("Installed Plugin");
    // The panel is scoped to the Plugins tab, so it is absent on All …
    expect(screen.queryByText(PLUGIN_PANEL_TEXT)).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: RE_PLUGINS_TAB }));

    // … and present once that tab is the active one.
    await waitFor(() =>
      expect(screen.getByText(PLUGIN_PANEL_TEXT)).toBeInTheDocument()
    );
  });

  it("renders no management affordance at all for a host without the bridge", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper dataSource={testDataSource(ONE_PLUGIN)}>
        <AgentsListSurfaceV2
          getComponentHref={componentHref}
          persistKey="agents:test-web"
        />
      </Wrapper>
    );

    await screen.findByText("Installed Plugin");
    await user.click(screen.getByRole("radio", { name: RE_PLUGINS_TAB }));

    // The inventory itself is on screen, so the absence below is this host
    // withholding one capability rather than a surface that failed to render.
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: RE_PLUGINS_TAB })
      ).toBeInTheDocument()
    );
    expect(screen.getByText("Installed Plugin")).toBeInTheDocument();
    // A missing command is ABSENT, not a disabled control that looks available.
    // Asserted as the region's absence rather than by sweeping every button for
    // `disabled`: that sweep is satisfied by a rendered-and-ENABLED management
    // control — the opposite defect — and it cannot see `aria-disabled`.
    expect(screen.queryByText(PLUGIN_PANEL_TEXT)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(AGENTS_PLUGIN_MANAGEMENT_TEST_ID)
    ).not.toBeInTheDocument();
  });
});

describe("AgentsListSurfaceV2 pagination ownership", () => {
  it("renders the footer for a multi-page population and pages with it", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper dataSource={testDataSource(TWO_PAGES)}>
        <AgentsListSurfaceV2
          getComponentHref={componentHref}
          persistKey="agents:test-paged"
        />
      </Wrapper>
    );

    expect(
      await screen.findByRole("navigation", { name: PAGINATION_LABEL })
    ).toBeInTheDocument();
    const firstPage = pagedRowNames();
    expect(firstPage).toHaveLength(AGENT_COMPONENT_PAGE_SIZE);

    await user.click(screen.getByLabelText(NEXT_PAGE_LABEL));

    // Asserted as counts and disjointness rather than by naming a row: which row
    // lands where depends on the active sort's tiebreak among identical metrics,
    // and pinning one name would make this fail for a reason that is not the
    // paging. What must hold either way is that the second page is the REST of
    // the same population — the remaining row, and none of the first page's.
    await waitFor(() =>
      expect(pagedRowNames()).toHaveLength(
        TWO_PAGES.length - AGENT_COMPONENT_PAGE_SIZE
      )
    );
    const secondPage = pagedRowNames();
    expect(secondPage.filter((name) => firstPage.includes(name))).toStrictEqual(
      []
    );
  });

  it("renders no footer for a single-page population", async () => {
    render(
      <Wrapper dataSource={testDataSource(ONE_PLUGIN)}>
        <AgentsListSurfaceV2
          getComponentHref={componentHref}
          persistKey="agents:test-single"
        />
      </Wrapper>
    );

    // Anchored on a settled row: without this the absence would also hold while
    // the read was still in flight.
    await screen.findByText("Installed Plugin");
    expect(
      screen.queryByRole("navigation", { name: PAGINATION_LABEL })
    ).not.toBeInTheDocument();
  });

  it("renders no footer for a read that has not resolved", () => {
    render(
      <Wrapper
        dataSource={{
          detail: () => new Promise(() => undefined),
          honorsDateWindow: false,
          list: () => new Promise(() => undefined),
          scope: "test",
        }}
      >
        <AgentsListSurfaceV2
          getComponentHref={componentHref}
          persistKey="agents:test-loading"
        />
      </Wrapper>
    );

    // The loading affordance is the positive half, so the footer's absence is
    // not a surface that never mounted. It does NOT prove the `Ready` half of
    // the predicate: an unresolved read has no rows, so `totalPages` is 1 and
    // that conjunct alone would suppress the footer. The two halves are pinned
    // independently in `agents-list-surface-state.test.ts`.
    expect(screen.getByText(RE_LOADING)).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: PAGINATION_LABEL })
    ).not.toBeInTheDocument();
    // ISS-9931: this host does its own `CompleteSurfaceState` mapping, so the
    // legacy host's cases do not cover it.
    expect(componentsCard()).toHaveTextContent(LOADING_CAPTION);
    expect(componentsCard()).not.toHaveTextContent(POPULATION_CAPTION);
  });
});

describe("AgentsListSurfaceV2 summary strip, failed read and its control", () => {
  /**
   * A rejected inventory read must not fall through to an empty state — that
   * would tell every org "no agents" during an outage — and it must be
   * ANNOUNCED, which the paragraph this surface inherited never was.
   */
  it("announces the failure as a live region and shows no empty copy", async () => {
    render(
      <Wrapper
        dataSource={{
          detail: () => Promise.reject(new Error("detail unused")),
          honorsDateWindow: false,
          list: () => Promise.reject(new Error("inventory read rejected")),
          scope: "test",
        }}
      >
        <AgentsListSurfaceV2
          getComponentHref={componentHref}
          persistKey="agents:test-error"
        />
      </Wrapper>
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(RE_LOAD_FAILED);
    // The positive assertion above is what makes this one meaningful: the empty
    // copy is absent because the error state was selected, not because nothing
    // rendered.
    expect(screen.queryByText(RE_NO_COMPONENTS_YET)).not.toBeInTheDocument();
    expect(screen.queryByText(RE_LOADING)).not.toBeInTheDocument();
    // The zero must not sit beside this alert, on this host's `Error` mapping.
    expect(componentsCard()).toHaveTextContent(UNAVAILABLE_CAPTION);
    expect(componentsCard()).not.toHaveTextContent(POPULATION_CAPTION);
  });

  // The live-locator control for the two absences above: the same card, the same
  // host, over a population that really was counted.
  it("prints the measured count once the read settles", async () => {
    render(
      <Wrapper dataSource={testDataSource()}>
        <AgentsListSurfaceV2
          getComponentHref={componentHref}
          persistKey="agents:test-settled-strip"
        />
      </Wrapper>
    );

    await waitFor(() =>
      expect(componentsCard()).toHaveTextContent(POPULATION_CAPTION)
    );
    expect(componentsCard()).not.toHaveTextContent(LOADING_CAPTION);
    expect(componentsCard()).not.toHaveTextContent(UNAVAILABLE_CAPTION);
  });
});

describe("AgentsListSurfaceV2 type-tab vocabulary", () => {
  /**
   * The v2 surface and the `AgentsGroupedList` fork it is gated against read ONE
   * vocabulary module, so the two shells cannot show different tab sets and the
   * two branches of the gate cannot either.
   *
   * Compared against `type-tab-strip-vocabulary.ts` — a hand-written oracle that
   * imports nothing from production — for the reason that fixture states: a set
   * derived from `KIND_ORDER` would agree with `KIND_ORDER` by construction. The
   * sibling `agents-grouped-list.permalink.test.tsx` holds the v1 strip to the
   * same list.
   */
  it("renders exactly the segments the hand-written oracle pins", async () => {
    render(
      <Wrapper dataSource={testDataSource(ONE_PLUGIN)}>
        <AgentsListSurfaceV2
          getComponentHref={componentHref}
          persistKey="agents:test-tabs"
        />
      </Wrapper>
    );

    await screen.findByText("Installed Plugin");
    expect(typeTabLabels()).toStrictEqual(
      EXPECTED_TYPE_TAB_SEGMENTS.map((segment) => segment.label)
    );
  });
});
