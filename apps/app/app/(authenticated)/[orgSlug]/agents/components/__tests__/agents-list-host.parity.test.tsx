import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
  type AgentComponentQueryFilters,
} from "@repo/api/src/types/agent-component";
import {
  FIXTURE_COMPONENTS,
  makeComponent,
  USAGE_FIXTURE_COMPONENTS,
} from "@repo/app/agents/components/workspace/agent-component-fixtures";
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-4496: cross-surface parity coverage for the WEB Agents list adapter.
 *
 * The sibling `agents-list-host.test.tsx` proves the web container
 * renders the full desktop tab set and never mounts the Packs catalog footer,
 * but it does not exercise the core list behaviors — rows-from-data, the
 * loading-vs-true-empty disambiguation, or a primary row interaction — through
 * the REAL web `AgentsListHost`. This suite drives that real web
 * adapter against a seeded data source and asserts the SAME list behavior the
 * desktop `agents-view-parity.test.tsx` asserts on the desktop surface, so the
 * "renders consistently on both surfaces" parity claim is covered on the web
 * half too.
 *
 * ISS-9625: the seeded inventory comes from the SHARED
 * `agent-component-fixtures` module the desktop half already reads. It used to
 * be a hand-rolled copy here, which made the pair's "both surfaces" claim
 * nominal — the two halves asserted analogous behavior against two
 * independently-declared populations, so a change to one surface's record was
 * invisible to the other. Expected values stay INDEPENDENT LITERALS in each
 * suite (per `agent-breadcrumb-honesty-parity.ts`): shared seed, unshared
 * expectation, so moving the record reddens both halves instead of neither.
 */

// apps/app bridges the `@repo/navigation` ports back to `next/navigation` (see
// `apps/app/vitest.setup.ts`), so the shared list's URL-param-backed tab state
// (`useTabParam` → `useSearchParamsValue` read + `useNavigation().replace`
// write) is driven by THIS mock, not the `AppCoreStoryProviders` memory adapter.
// A static mock would make tab clicks a no-op; to exercise the tab interaction
// on the real web surface we back the mock with a mutable search-param store
// whose `replace` parses the next URL and re-renders subscribers.

// A minimal reactive search-param store for the next/navigation mock: `replace`/
// `push` parse the target href's query and notify subscribers, and the mocked
// `useSearchParams` subscribes via `useSyncExternalStore` so a tab-driven URL
// change re-renders the list. Kept local to this parity suite.
function createNavSearchStore() {
  let params = new URLSearchParams();
  const listeners = new Set<() => void>();
  let snapshot = params;
  const applyHref = (href: string) => {
    const q = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    params = new URLSearchParams(q);
    snapshot = params;
    for (const l of listeners) {
      l();
    }
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  const getSnapshot = () => snapshot;
  const useSnapshot = () =>
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const reset = () => {
    params = new URLSearchParams();
    snapshot = params;
    for (const l of listeners) {
      l();
    }
  };
  return { applyHref, useSnapshot, reset };
}

const navSearchStore = createNavSearchStore();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => navSearchStore.applyHref(href),
    replace: (href: string) => navSearchStore.applyHref(href),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/org-test/agents",
  // Reactive read: subscribes to the store so a `replace(...)` that changes the
  // `?kind=` param re-renders the list into the newly-selected tab.
  useSearchParams: () => navSearchStore.useSnapshot(),
  useParams: () => ({ orgSlug: "org-test" }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "org-test",
}));

const RE_ALL_TAB = /^All$/;
const RE_COMMANDS_TAB = /commands/i;
const RE_SKILLS_TAB = /skills/i;
const RE_LOADING = /loading components/i;
const RE_NO_MATCH = /no components match/i;
const RE_NO_COMPONENTS_YET = /no components yet/i;
const RE_NO_SKILLS = /no skills yet/i;
const RE_USAGE_ORCHESTRATOR_ROW = /Usage Orchestrator/;
const RE_USAGE_COMMAND_ROW = /Usage Command/;

function listDataSource(
  items: AgentComponent[] = FIXTURE_COMPONENTS,
  onList?: (filters: AgentComponentQueryFilters) => void
): AgentComponentsDataSource {
  return {
    scope: "agent-components:http",
    honorsDateWindow: true,
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

describe("AgentsListHost web list parity (ISS-4496)", () => {
  // The nav search store is module-scoped (the vi.mock factory closes over it),
  // so reset the URL param state between tests to avoid a prior test's selected
  // tab leaking into the next mount.
  beforeEach(() => {
    navSearchStore.reset();
  });

  it("renders inventory rows from the seeded data source (real web adapter)", async () => {
    const { AgentsListHost } = await import("../agents-list-host");

    render(
      <Wrapper dataSource={listDataSource()}>
        <AgentsListHost />
      </Wrapper>
    );

    expect(
      await screen.findByText("My Orchestrator Agent")
    ).toBeInTheDocument();
    expect(screen.getByText("Code Review Command")).toBeInTheDocument();
    expect(screen.getByText("Python Expert Skill")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: RE_ALL_TAB })).toBeInTheDocument();
  }, 15_000);

  it("routes each row to the org-scoped detail href by slug", async () => {
    const { AgentsListHost } = await import("../agents-list-host");

    render(
      <Wrapper dataSource={listDataSource()}>
        <AgentsListHost />
      </Wrapper>
    );

    // The web container builds `/{orgSlug}/agents/{encodeURIComponent(slug)}`.
    // The row name anchor carries that href — keyed by the org-identity slug,
    // NOT the DB id — so the detail endpoint resolves by identity.
    const link = await screen.findByRole("link", {
      name: "My Orchestrator Agent",
    });
    expect(link).toHaveAttribute(
      "href",
      "/org-test/agents/subagent%3A%3Aorchestrator"
    );
  }, 15_000);

  it("distinguishes loading from a true-empty inventory", async () => {
    const { AgentsListHost } = await import("../agents-list-host");

    const neverResolves: AgentComponentsDataSource = {
      scope: "agent-components:http",
      honorsDateWindow: true,
      list: () => new Promise(() => undefined),
      detail: () => new Promise(() => undefined),
    };

    const { unmount } = render(
      <Wrapper dataSource={neverResolves}>
        <AgentsListHost />
      </Wrapper>
    );

    // In flight → loading affordance, never the empty state (an outage must not
    // read as "no agents").
    expect(screen.getByText(RE_LOADING)).toBeInTheDocument();
    expect(screen.queryByText(RE_NO_MATCH)).not.toBeInTheDocument();
    expect(screen.queryByText(RE_NO_COMPONENTS_YET)).not.toBeInTheDocument();
    unmount();

    // Settled empty inventory → the true-empty ("No components yet.") state, and
    // never the loading affordance.
    render(
      <Wrapper dataSource={listDataSource([])}>
        <AgentsListHost />
      </Wrapper>
    );

    await waitFor(() =>
      expect(screen.getByText(RE_NO_COMPONENTS_YET)).toBeInTheDocument()
    );
    expect(screen.queryByText(RE_LOADING)).not.toBeInTheDocument();
  });

  it("filters rows to the selected kind when a type tab is clicked (primary interaction)", async () => {
    const user = userEvent.setup();
    const { AgentsListHost } = await import("../agents-list-host");

    render(
      <Wrapper dataSource={listDataSource()}>
        <AgentsListHost />
      </Wrapper>
    );

    await screen.findByText("My Orchestrator Agent");

    await user.click(screen.getByRole("radio", { name: RE_COMMANDS_TAB }));

    await waitFor(() => {
      expect(screen.getByText("Code Review Command")).toBeInTheDocument();
      expect(
        screen.queryByText("My Orchestrator Agent")
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Python Expert Skill")).not.toBeInTheDocument();
    });
  });

  /**
   * ISS-9625 — the usage/invocation cell of the collector→render lattice, on
   * the WEB adapter. Every other assertion in this suite is about identity,
   * navigation, or empty/loading state, so an adapter that mounted the shared
   * catalog with the count columns dropped or the two rows' usage transposed
   * would keep the whole file green. Until this landed neither surface adapter
   * asserted a single usage number; that coverage lived only in `packages/app`'s
   * own lane, which is neither surface's.
   *
   * The Metric column is deliberately NOT in scope: `MetricCell` reads only
   * `locPerDollar` and `AgentsTable` never reads the `metricMode` prop it still
   * declares (ISS-4667/4866/5366 retired the second mode and its picker), so a
   * mode-varying assertion here could not fail (whitlockk review on PR #6863).
   *
   * The seed is the SHARED `USAGE_FIXTURE_COMPONENTS`, so moving a count reddens
   * this half and the desktop half together. Its two rows carry DISTINCT counts
   * on purpose — a shared value would let a transposition satisfy per-row
   * assertions — and the summary is asserted as an independent literal
   * (731 + 482), never re-derived from the fixture, so a row listed but excluded
   * from the aggregate cannot pass.
   */
  it("renders each component's own usage counts and an aggregate that reconciles", async () => {
    const { AgentsListHost } = await import("../agents-list-host");

    render(
      <Wrapper dataSource={listDataSource(USAGE_FIXTURE_COMPONENTS)}>
        <AgentsListHost />
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
    expect(within(orchestratorRow).getByText("731")).toBeInTheDocument();
    expect(within(orchestratorRow).getByText("17")).toBeInTheDocument();

    const commandRow = screen.getByRole("row", { name: RE_USAGE_COMMAND_ROW });
    expect(within(commandRow).getByText("482")).toBeInTheDocument();
    expect(within(commandRow).getByText("9")).toBeInTheDocument();

    // …and the Invocations summary reconciles with the population it describes.
    expect(within(invocationsCard()).getByText("1,213")).toBeInTheDocument();
  });

  it("shows the kind-named empty state (not the filter copy) for an empty tab", async () => {
    const user = userEvent.setup();
    const { AgentsListHost } = await import("../agents-list-host");

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
        <AgentsListHost />
      </Wrapper>
    );

    await screen.findByText("Solo Agent");
    await user.click(screen.getByRole("radio", { name: RE_SKILLS_TAB }));

    await waitFor(() =>
      expect(screen.getByText(RE_NO_SKILLS)).toBeInTheDocument()
    );
    expect(screen.queryByText(RE_NO_MATCH)).not.toBeInTheDocument();
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
