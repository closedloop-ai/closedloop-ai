import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * FEA-4019: the WEB Agents adapter renders the full desktop tab set — Tools,
 * MCPs, and Hooks as first-class top-level type tabs by DEFAULT, with no
 * feature flag. This test drives the real web container
 * (`AgentsGroupedListContainer`) so it asserts on the actual web surface, not
 * just the shared component in isolation. The GitHub-integration / org-slug
 * web-only dependencies are mocked; the real shared `AgentsGroupedList` renders
 * against a seeded data source that includes tool/mcp/hook rows.
 */

// The web navigation ports delegate to next/navigation in apps/app tests (see
// vitest.setup.ts), so `useTabParam` inside the shared list reads the tab from
// this mocked router/searchParams. A static empty query = the default ("All")
// tab; the type-tab bar still renders every configured top-level tab.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/org-test/agents",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orgSlug: "org-test" }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "org-test",
}));

// FEA-4098 (Slice 3): the container no longer resolves any GitHub connection
// state (the Owner-column Connect-GitHub CTA was removed), so the github-status
// and connect-url mocks are gone with it.

// FEA-4085: the web adapter must NOT mount the Packs distribution catalog under
// the Plugins tab. Stub the (still-shipped) MemberPacksDashboard with a probe so
// the boundary test below can prove it never renders on the web surface — the
// container must pass no `pluginsFooter`.
vi.mock("../member-packs-dashboard", () => ({
  MemberPacksDashboard: () => <div data-testid="member-packs-dashboard" />,
}));

describe("AgentsGroupedListContainer (web adapter)", () => {
  it("renders the full desktop tab set (Tools/MCPs/Hooks) by default with no flag", async () => {
    const { AgentsGroupedListContainer } = await import(
      "../agents-grouped-list-container"
    );

    render(
      <Wrapper>
        <AgentsGroupedListContainer />
      </Wrapper>
    );

    // Existing core tabs.
    expect(
      await screen.findByRole("radio", { name: RE_AGENTS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_PLUGINS_TAB })
    ).toBeInTheDocument();

    // FEA-4019: Tools / MCPs / Hooks now first-class on the WEB surface.
    expect(screen.getByRole("radio", { name: RE_MCP_TAB })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_TOOLS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_HOOKS_TAB })
    ).toBeInTheDocument();
  });

  it("shows installed plugin inventory but never the Packs distribution catalog on the Plugins tab (FEA-4085)", async () => {
    const user = userEvent.setup();
    const { AgentsGroupedListContainer } = await import(
      "../agents-grouped-list-container"
    );

    render(
      <Wrapper>
        <AgentsGroupedListContainer />
      </Wrapper>
    );

    // Open the Plugins type-tab — the surface the catalog used to bolt onto.
    await user.click(
      await screen.findByRole("radio", { name: RE_PLUGINS_TAB })
    );

    // The installed plugin row renders (inventory is still there)…
    expect(await screen.findByText("Installed Plugin")).toBeInTheDocument();

    // …but the Packs distribution catalog does NOT: the web container passes no
    // `pluginsFooter`, so MemberPacksDashboard never mounts on this tab.
    expect(
      screen.queryByTestId("member-packs-dashboard")
    ).not.toBeInTheDocument();
  });
});

// Exact plural aria-labels (kindMeta().plural) for the type tabs under test.
// FEA-4019 renamed the MCP tab plural to "MCPs" (distinct from "Tools").
const RE_AGENTS_TAB = /agents/i;
const RE_PLUGINS_TAB = /plugins/i;
const RE_MCP_TAB = /^MCPs$/;
const RE_TOOLS_TAB = /^Tools$/;
const RE_HOOKS_TAB = /^Hooks$/;

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

const FIXTURE: AgentComponent[] = [
  makeComponent({
    id: "uuid-sub-1",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
  }),
  makeComponent({
    id: "uuid-mcp-1",
    name: "Linear MCP",
    kind: AgentComponentKind.Mcp,
  }),
  makeComponent({
    id: "uuid-tool-1",
    name: "Bash Tool",
    kind: AgentComponentKind.Tool,
  }),
  makeComponent({
    id: "uuid-hook-1",
    name: "PreCommit Hook",
    kind: AgentComponentKind.Hook,
  }),
  makeComponent({
    id: "uuid-plugin-1",
    name: "Installed Plugin",
    kind: AgentComponentKind.Plugin,
  }),
];

function testDataSource(): AgentComponentsDataSource {
  return {
    scope: "agent-components:http",
    list: () =>
      Promise.resolve({
        items: FIXTURE,
        total: FIXTURE.length,
      } satisfies AgentComponentListResponse),
    detail: () => Promise.reject(new Error("detail unused")),
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  // No enabledFlags — proves the web adapter shows Tools/MCPs/Hooks WITHOUT any
  // opt-in flag (FEA-4019).
  return (
    <AppCoreStoryProviders>
      <AgentComponentsDataSourceProvider dataSource={testDataSource()}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}
