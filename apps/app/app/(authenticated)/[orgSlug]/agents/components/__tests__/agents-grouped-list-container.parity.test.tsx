import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
  type AgentComponentQueryFilters,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-4496: cross-surface parity coverage for the WEB Agents list adapter.
 *
 * The sibling `agents-grouped-list-container.test.tsx` proves the web container
 * renders the full desktop tab set and never mounts the Packs catalog footer,
 * but it does not exercise the core list behaviors — rows-from-data, the
 * loading-vs-true-empty disambiguation, or a primary row interaction — through
 * the REAL web `AgentsGroupedListContainer`. This suite drives that real web
 * adapter against a seeded data source and asserts the SAME list behavior the
 * desktop `agents-view-parity.test.tsx` asserts on the desktop surface, so the
 * "renders consistently on both surfaces" parity claim is covered on the web
 * half too.
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

function makeComponent(overrides: Partial<AgentComponent>): AgentComponent {
  return {
    id: overrides.id ?? "uuid-default",
    slug: overrides.slug ?? overrides.id ?? "subagent::uuid-default",
    name: overrides.name ?? "Default Component",
    kind: overrides.kind ?? AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    locPerDollar: 2.5,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const FIXTURE_COMPONENTS: AgentComponent[] = [
  makeComponent({
    id: "uuid-sub-1",
    slug: "subagent::orchestrator",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
  }),
  makeComponent({
    id: "uuid-cmd-1",
    slug: "command::code-review",
    name: "Code Review Command",
    kind: AgentComponentKind.Command,
  }),
  makeComponent({
    id: "uuid-skill-1",
    slug: "skill::python",
    name: "Python Expert Skill",
    kind: AgentComponentKind.Skill,
  }),
];

function listDataSource(
  items: AgentComponent[] = FIXTURE_COMPONENTS,
  onList?: (filters: AgentComponentQueryFilters) => void
): AgentComponentsDataSource {
  return {
    scope: "agent-components:http",
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

describe("AgentsGroupedListContainer web list parity (ISS-4496)", () => {
  // The nav search store is module-scoped (the vi.mock factory closes over it),
  // so reset the URL param state between tests to avoid a prior test's selected
  // tab leaking into the next mount.
  beforeEach(() => {
    navSearchStore.reset();
  });

  it("renders inventory rows from the seeded data source (real web adapter)", async () => {
    const { AgentsGroupedListContainer } = await import(
      "../agents-grouped-list-container"
    );

    render(
      <Wrapper dataSource={listDataSource()}>
        <AgentsGroupedListContainer />
      </Wrapper>
    );

    expect(
      await screen.findByText("My Orchestrator Agent")
    ).toBeInTheDocument();
    expect(screen.getByText("Code Review Command")).toBeInTheDocument();
    expect(screen.getByText("Python Expert Skill")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: RE_ALL_TAB })).toBeInTheDocument();
  });

  it("routes each row to the org-scoped detail href by slug", async () => {
    const { AgentsGroupedListContainer } = await import(
      "../agents-grouped-list-container"
    );

    render(
      <Wrapper dataSource={listDataSource()}>
        <AgentsGroupedListContainer />
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
  });

  it("distinguishes loading from a true-empty inventory", async () => {
    const { AgentsGroupedListContainer } = await import(
      "../agents-grouped-list-container"
    );

    const neverResolves: AgentComponentsDataSource = {
      scope: "agent-components:http",
      list: () => new Promise(() => undefined),
      detail: () => new Promise(() => undefined),
    };

    const { unmount } = render(
      <Wrapper dataSource={neverResolves}>
        <AgentsGroupedListContainer />
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
        <AgentsGroupedListContainer />
      </Wrapper>
    );

    await waitFor(() =>
      expect(screen.getByText(RE_NO_COMPONENTS_YET)).toBeInTheDocument()
    );
    expect(screen.queryByText(RE_LOADING)).not.toBeInTheDocument();
  });

  it("filters rows to the selected kind when a type tab is clicked (primary interaction)", async () => {
    const user = userEvent.setup();
    const { AgentsGroupedListContainer } = await import(
      "../agents-grouped-list-container"
    );

    render(
      <Wrapper dataSource={listDataSource()}>
        <AgentsGroupedListContainer />
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

  it("shows the kind-named empty state (not the filter copy) for an empty tab", async () => {
    const user = userEvent.setup();
    const { AgentsGroupedListContainer } = await import(
      "../agents-grouped-list-container"
    );

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
        <AgentsGroupedListContainer />
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
