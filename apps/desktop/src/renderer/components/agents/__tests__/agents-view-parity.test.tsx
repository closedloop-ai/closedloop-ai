/**
 * ISS-4496: cross-surface parity coverage for the desktop Agents view.
 *
 * The sibling `agents-view.test.tsx` / `agent-detail-view.test.tsx` suites mock
 * the shared `@repo/app` list + detail down to markers so they can assert the
 * desktop adapter's OWN wiring (pluginsFooter injection, install IPC) without a
 * React-Query/data-source graph. That means nothing there proves the desktop
 * adapter actually renders the SAME shared inventory + detail the web adapter
 * mounts.
 *
 * This suite closes that gap: it renders the REAL shared `AgentsGroupedList`
 * (through the real `AgentsView`) and the REAL shared `AgentDetail` (through the
 * real `AgentDetailView`) against a seeded `AgentComponentsDataSource`, and
 * asserts the same observable list/detail/empty/interaction behavior the web
 * suites assert on the web surface. The two adapters drive one shared
 * component, so this is the desktop half of the "renders consistently on both
 * surfaces" parity claim.
 *
 * The desktop renderer vitest config has no global jsdom setup, so — like the
 * existing `branch-detail-back-navigation.test.tsx` — this file installs the
 * `matchMedia` + `ResizeObserver` shims the shared GridTable auto-layout reads.
 */

import {
  type AgentComponent,
  type AgentComponentDetail,
  AgentComponentKind,
  type AgentComponentListResponse,
  type AgentComponentQueryFilters,
} from "@repo/api/src/types/agent-component";
import {
  FIXTURE_COMPONENTS,
  makeComponent,
  makeDetail,
  USAGE_FIXTURE_COMPONENTS,
} from "@repo/app/agents/components/workspace/agent-component-fixtures";
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { ApiError } from "@repo/app/shared/api/api-error";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The desktop analytics panel reads `window.desktopApi.db` IPC and is out of
// scope for the shared-detail parity assertions — stub it to a marker exactly as
// the sibling `agent-detail-view.test.tsx` does, keeping the shared `AgentDetail`
// REAL (unmocked) so the parity claim is about the shared body.
vi.mock("../optimization-analytics-panel", () => ({
  OptimizationAnalyticsPanel: () => <div data-testid="opt-panel" />,
}));

// Topbar breadcrumb publisher — inert, mirrors the sibling suite.
vi.mock("../../../navigation/detail-title-context", () => ({
  usePublishDetailTitle: () => {
    // no-op
  },
}));

// The desktop plugin management panel injected as the list's `pluginsFooter`.
// Stubbed to a marker so the parity list can be exercised without the plugin
// IPC/render graph (the desktop pluginsFooter wiring itself is covered in
// `agents-view.test.tsx`).
vi.mock("../plugins-panel", () => ({
  PluginsPanel: () => (
    <div data-testid="plugins-panel-marker">PluginsPanel</div>
  ),
}));

import { AgentDetailView } from "../agent-detail-view";
import { AgentsView } from "../agents-view";

// Top-level regex constants (biome/performance/useTopLevelRegex)

const RE_ALL_TAB = /^All$/;
const RE_COMMANDS_TAB = /commands/i;
const RE_SKILLS_TAB = /skills/i;
const RE_LOADING = /loading components/i;
const RE_NO_MATCH = /no components match/i;
const RE_NO_COMPONENTS_YET = /no components yet/i;
const RE_NO_SKILLS = /no skills yet/i;
const RE_NOT_FOUND = /component not found/i;
const RE_UNAVAILABLE = /component unavailable/i;
const RE_ALLOWED_TOOLS = /allowed tools/i;
/**
 * ISS-4805: any rendered text still rooted on the capturing machine. Asserting
 * the ABSENCE of this shape (rather than of one literal) is what makes the
 * disclosure guard hold for a path the fixture did not anticipate.
 */
const RE_MACHINE_ROOTED_PATH = /(^|\s)(\/Users\/|\/home\/|~\/|[A-Za-z]:\\)/;
const RE_BACK_TO_AGENTS = /back to agents/i;
const RE_USAGE_ORCHESTRATOR_ROW = /Usage Orchestrator/;
const RE_USAGE_COMMAND_ROW = /Usage Command/;

// Data sources — the fixture factory + inventory are shared with the web
// workspace suite via `@repo/app/.../agent-component-fixtures` so the two parity
// claims cannot drift; each surface keeps its OWN `agent-components:local` scope.

function listDataSource(
  items: AgentComponent[] = FIXTURE_COMPONENTS,
  onList?: (filters: AgentComponentQueryFilters) => void
): AgentComponentsDataSource {
  return {
    scope: "agent-components:local",
    honorsDateWindow: false,
    list: (filters) => {
      onList?.(filters);
      return Promise.resolve({
        items,
        total: items.length,
      } satisfies AgentComponentListResponse);
    },
    detail: () =>
      Promise.reject(new Error("detail unused in list parity tests")),
  };
}

function detailDataSource(
  detail: AgentComponentDetail
): AgentComponentsDataSource {
  return {
    scope: "agent-components:local",
    honorsDateWindow: false,
    list: () => Promise.reject(new Error("list unused in detail parity tests")),
    detail: () => Promise.resolve(detail),
  };
}

function Wrapper({
  children,
  dataSource,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
}) {
  return (
    <AppCoreStoryProviders>
      <AgentComponentsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

// jsdom shims — the desktop renderer config has no global setup, so install the
// browser globals the shared GridTable auto-layout reads (matches the existing
// branch-detail-back-navigation.test.tsx pattern).

let restoreResizeObserver: (() => void) | undefined;
let restoreMatchMedia: (() => void) | undefined;

function installResizeObserver(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    },
  });
  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
      return;
    }
    Object.defineProperty(globalThis, "ResizeObserver", originalDescriptor);
  };
}

function installMatchMedia(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "matchMedia"
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(window, "matchMedia");
      return;
    }
    Object.defineProperty(window, "matchMedia", originalDescriptor);
  };
}

beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
  restoreMatchMedia = installMatchMedia();
});

afterEach(() => {
  cleanup();
  restoreResizeObserver?.();
  restoreResizeObserver = undefined;
  restoreMatchMedia?.();
  restoreMatchMedia = undefined;
  vi.restoreAllMocks();
});

// Desktop LIST parity — the real shared AgentsGroupedList, mounted through the
// real desktop AgentsView adapter.

describe("Desktop AgentsView list parity (ISS-4496)", () => {
  it("renders inventory rows from the seeded data source (real shared list)", async () => {
    render(
      <Wrapper dataSource={listDataSource()}>
        <AgentsView dataSource={listDataSource()} />
      </Wrapper>
    );

    // Every seeded component name renders — the same rows the web adapter shows.
    expect(await screen.findByText("My Orchestrator Agent")).toBeDefined();
    expect(screen.getByText("Code Review Command")).toBeDefined();
    expect(screen.getByText("Python Expert Skill")).toBeDefined();

    // And the core type-tab bar renders (parity with the web tab set).
    expect(screen.getByRole("radio", { name: RE_ALL_TAB })).toBeDefined();
  });

  it("distinguishes loading from a true-empty inventory", async () => {
    // A never-resolving source keeps the query pending → the loading affordance,
    // NOT the empty state (an outage must never read as "no agents").
    const neverResolves: AgentComponentsDataSource = {
      scope: "agent-components:local",
      honorsDateWindow: false,
      list: () => new Promise(() => undefined),
      detail: () => new Promise(() => undefined),
    };

    const { unmount } = render(
      <Wrapper dataSource={neverResolves}>
        <AgentsView dataSource={neverResolves} />
      </Wrapper>
    );

    expect(screen.getByText(RE_LOADING)).toBeDefined();
    expect(screen.queryByText(RE_NO_MATCH)).toBeNull();
    expect(screen.queryByText(RE_NO_COMPONENTS_YET)).toBeNull();
    unmount();

    // A settled EMPTY inventory drives the empty state, never the loading one.
    render(
      <Wrapper dataSource={listDataSource([])}>
        <AgentsView dataSource={listDataSource([])} />
      </Wrapper>
    );

    await waitFor(() =>
      expect(screen.getByText(RE_NO_COMPONENTS_YET)).toBeDefined()
    );
    expect(screen.queryByText(RE_LOADING)).toBeNull();
  });

  it("filters rows to the selected kind when a type tab is clicked (primary interaction)", async () => {
    render(
      <Wrapper dataSource={listDataSource()}>
        <AgentsView dataSource={listDataSource()} />
      </Wrapper>
    );

    await screen.findByText("My Orchestrator Agent");

    fireEvent.click(screen.getByRole("radio", { name: RE_COMMANDS_TAB }));

    await waitFor(() => {
      expect(screen.getByText("Code Review Command")).toBeDefined();
      expect(screen.queryByText("My Orchestrator Agent")).toBeNull();
      expect(screen.queryByText("Python Expert Skill")).toBeNull();
    });
  });

  /**
   * ISS-9625 — the usage/invocation cell of the collector→render lattice, on
   * the DESKTOP adapter; the web half asserts the same shape through
   * `AgentsListHost`. Every other assertion in this suite is about
   * identity, navigation, or empty/loading state, so an adapter that mounted the
   * shared catalog with the count columns dropped or the two rows' usage
   * transposed would keep the whole file green. Until this landed neither
   * surface adapter asserted a single usage number; that coverage lived only in
   * `packages/app`'s own lane, which is neither surface's.
   *
   * The Metric column is deliberately NOT in scope: `MetricCell` reads only
   * `locPerDollar` and `AgentsTable` never reads the `metricMode` prop it still
   * declares (ISS-4667/4866/5366 retired the second mode and its picker), so a
   * mode-varying assertion here could not fail (whitlockk review on PR #6863).
   *
   * The seed is the SHARED `USAGE_FIXTURE_COMPONENTS`, so moving a count reddens
   * this half and the web half together. Its two rows carry DISTINCT counts on
   * purpose — a shared value would let a transposition satisfy per-row
   * assertions — and the summary is asserted as an independent literal
   * (731 + 482), never re-derived from the fixture, so a row listed but excluded
   * from the aggregate cannot pass.
   */
  it("renders each component's own usage counts and an aggregate that reconciles", async () => {
    render(
      <Wrapper dataSource={listDataSource(USAGE_FIXTURE_COMPONENTS)}>
        <AgentsView dataSource={listDataSource(USAGE_FIXTURE_COMPONENTS)} />
      </Wrapper>
    );

    // Settle on the cheap text query before the by-name row lookup: resolving a
    // row's accessible name walks its whole subtree, so awaiting on THAT is what
    // makes the query flaky on a loaded machine.
    await screen.findByText("Usage Orchestrator");

    // Each row carries ITS OWN counts — scoped to the row so a number belonging
    // to the sibling component cannot answer the assertion.
    const orchestratorRow = screen.getByRole("row", {
      name: RE_USAGE_ORCHESTRATOR_ROW,
    });
    expect(within(orchestratorRow).getByText("731")).toBeDefined();
    expect(within(orchestratorRow).getByText("17")).toBeDefined();

    const commandRow = screen.getByRole("row", { name: RE_USAGE_COMMAND_ROW });
    expect(within(commandRow).getByText("482")).toBeDefined();
    expect(within(commandRow).getByText("9")).toBeDefined();

    // …and the Invocations summary reconciles with the population it describes.
    expect(within(invocationsCard()).getByText("1,213")).toBeDefined();
  });

  it("shows the kind-named empty state (not the filter copy) for an empty tab", async () => {
    // Only a Subagent exists — selecting Skills has no rows and no active
    // facet/search filter, so the empty copy names the kind rather than telling
    // the user to clear a filter they never set.
    const onlySubagent = [
      makeComponent({
        id: "uuid-sub-1",
        slug: "subagent::solo",
        name: "Solo Agent",
        kind: AgentComponentKind.Subagent,
      }),
    ];

    render(
      <Wrapper dataSource={listDataSource(onlySubagent)}>
        <AgentsView dataSource={listDataSource(onlySubagent)} />
      </Wrapper>
    );

    await screen.findByText("Solo Agent");
    fireEvent.click(screen.getByRole("radio", { name: RE_SKILLS_TAB }));

    await waitFor(() => expect(screen.getByText(RE_NO_SKILLS)).toBeDefined());
    expect(screen.queryByText(RE_NO_MATCH)).toBeNull();
  });
});

// Desktop DETAIL parity — the real shared AgentDetail, mounted through the real
// desktop AgentDetailView adapter.

describe("Desktop AgentDetailView detail parity (ISS-4496)", () => {
  it("renders the resolved component with a key derived field (Properties path)", async () => {
    render(
      <Wrapper dataSource={detailDataSource(makeDetail())}>
        <AgentDetailView
          agentSlug="subagent::orchestrator"
          backHref="#/agents"
        />
      </Wrapper>
    );

    // The component name lands in the header…
    expect(
      await screen.findByText("My Orchestrator Agent", { selector: "p" })
    ).toBeDefined();
    // …and a derived Properties field (the definition path) renders — the same
    // shared body the web detail route mounts.
    expect(screen.getByText(".claude/agents/orchestrator.md")).toBeDefined();
  });

  // ISS-4805 parity: the desktop renderer mounts the SAME shared header, so it
  // must make the same claim about where a definition lives — the portable tail
  // of a machine-absolute path, never the machine-rooted prefix. Pinned on this
  // adapter too because a redaction that held only on web would still publish
  // the capturing user's home directory to every desktop reader.
  it("renders only the portable tail of a machine-absolute definition path", async () => {
    render(
      <Wrapper
        dataSource={detailDataSource(
          makeDetail({
            properties: {
              path: "/Users/someone/Code/proj/.claude/agents/orchestrator.md",
              format: "md",
            },
          })
        )}
      >
        <AgentDetailView
          agentSlug="subagent::orchestrator"
          backHref="#/agents"
        />
      </Wrapper>
    );

    expect(
      await screen.findByText("My Orchestrator Agent", { selector: "p" })
    ).toBeDefined();
    expect(screen.getByText(".claude/agents/orchestrator.md")).toBeDefined();
    expect(screen.queryByText(RE_MACHINE_ROOTED_PATH)).toBeNull();
  });

  it("renders per-kind definition detail for a Subagent (allowed tools)", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Subagent,
      properties: {
        path: ".claude/agents/orchestrator.md",
        format: "md",
        allowedTools: ["Read", "Edit"],
      },
    });

    render(
      <Wrapper dataSource={detailDataSource(detail)}>
        <AgentDetailView
          agentSlug="subagent::orchestrator"
          backHref="#/agents"
        />
      </Wrapper>
    );

    await screen.findByText("My Orchestrator Agent", { selector: "p" });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByText(RE_ALLOWED_TOOLS)).toBeDefined();
    expect(screen.getByText("Read", { exact: true })).toBeDefined();
    expect(screen.getByText("Edit", { exact: true })).toBeDefined();
  });

  it("renders the not-found state (not 'unavailable') on a genuine 404", async () => {
    const notFound: AgentComponentsDataSource = {
      scope: "agent-components:local",
      honorsDateWindow: false,
      list: () => Promise.reject(new Error("list unused")),
      detail: () => Promise.reject(new ApiError("Not Found", 404)),
    };

    render(
      <Wrapper dataSource={notFound}>
        <AgentDetailView agentSlug="subagent::gone" backHref="#/agents" />
      </Wrapper>
    );

    await waitFor(() => expect(screen.getByText(RE_NOT_FOUND)).toBeDefined());
    // A missing component must not masquerade as a transient outage.
    expect(screen.queryByText(RE_UNAVAILABLE)).toBeNull();
    // The desktop back href threads into the shared not-found "Back to Agents".
    expect(
      screen.getByRole("link", { name: RE_BACK_TO_AGENTS }).getAttribute("href")
    ).toBe("#/agents");
  });

  it("renders the distinct 'unavailable' state on a transient provider error", async () => {
    const providerDown: AgentComponentsDataSource = {
      scope: "agent-components:local",
      honorsDateWindow: false,
      list: () => Promise.reject(new Error("list unused")),
      detail: () => Promise.reject(new ApiError("Service Unavailable", 503)),
    };

    render(
      <Wrapper dataSource={providerDown}>
        <AgentDetailView
          agentSlug="subagent::orchestrator"
          backHref="#/agents"
        />
      </Wrapper>
    );

    await waitFor(() => expect(screen.getByText(RE_UNAVAILABLE)).toBeDefined());
    // A transient blip must NOT claim the component doesn't exist.
    expect(screen.queryByText(RE_NOT_FOUND)).toBeNull();
  });
});

/**
 * The Invocations summary card's own subtree, scoped exactly as the sibling
 * exactness suite scopes it (`agents-grouped-list.invocations-exactness.test.tsx`).
 * The Components, Authors, and LOC/$ cards render their own numbers into the same
 * row, so a page-wide text query for the total could be answered by a different
 * card — which would make the reconciliation assertion mean nothing.
 */
function invocationsCard(): HTMLElement {
  const card = screen
    .getByRole("button", { name: "About Invocations" })
    .closest("[data-slot='card']");
  if (!(card instanceof HTMLElement)) {
    throw new Error("Could not find the Invocations summary card");
  }
  return card;
}
