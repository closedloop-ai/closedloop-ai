import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
} from "@repo/api/src/types/agent-component";
import { makeComponent } from "@repo/app/agents/components/workspace/agent-component-fixtures";
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
 * (`AgentsListHost`) so it asserts on the actual web surface, not
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

// FEA-4085 evacuated the Packs distribution catalog from the Plugins tab. This
// file used to stub a `MemberPacksDashboard` probe here to prove it never
// mounted; ISS-7068 deleted that component, which had been unreachable ever
// since (its successor is `MemberPacksView` at `/{orgSlug}/packs`). The web
// container passes no `pluginsFooter` and there is no longer a catalog
// component for one to carry, so the probe went with it.

describe("AgentsListHost (web adapter)", () => {
  it("renders the full desktop tab set (Tools/MCPs/Hooks) by default with no flag", async () => {
    const { AgentsListHost } = await import("../agents-list-host");

    render(
      <Wrapper>
        <AgentsListHost />
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
  }, 10_000);

  /**
   * The href contract, asserted where the REAL factory runs (whitlockk review on PR
   * #6803).
   *
   * It used to live in `../../__tests__/page.test.tsx`, which mocks this host
   * away to isolate the route gate — so it read its own mock's hardcoded href
   * and stayed green however the production factory behaved. It also asserted
   * the wrong rule: "a UUID, never a colon". `AgentsListHost` routes with
   * `encodeURIComponent(item.slug)`, and the detail route is `[slug]`, whose
   * param is the `kind::key` org-identity slug — so a colon is not the defect,
   * it is the shape.
   *
   * The fixture's `slug` is deliberately NOT its `id`: `makeComponent` falls
   * back to the id when no slug is given, which would let an href built from
   * `item.id` satisfy this assertion. With the two distinct, only the slug
   * passes — and the encoded form is what is pinned, because `::` must survive
   * as `%3A%3A` for `normalizeAgentSlug` to hand the API back the raw slug.
   */
  it("links each row to the detail route by encoded slug, not id", async () => {
    const { AgentsListHost } = await import("../agents-list-host");

    render(
      <Wrapper>
        <AgentsListHost />
      </Wrapper>
    );

    const link = await screen.findByRole("link", { name: RE_HREF_ROW });
    expect(link).toHaveAttribute(
      "href",
      "/org-test/agents/subagent%3A%3Ahref-probe"
    );
    // Not vacuous in the other direction: the id must not be what routed.
    expect(link.getAttribute("href")).not.toContain("uuid-href-1");
  });

  it("shows installed plugin inventory on the Plugins tab", async () => {
    const user = userEvent.setup();
    const { AgentsListHost } = await import("../agents-list-host");

    render(
      <Wrapper>
        <AgentsListHost />
      </Wrapper>
    );

    // Open the Plugins type-tab — the surface the catalog used to bolt onto.
    await user.click(
      await screen.findByRole("radio", { name: RE_PLUGINS_TAB })
    );

    // The installed plugin row renders: FEA-4085 took the catalog off this tab
    // without taking the inventory with it.
    expect(await screen.findByText("Installed Plugin")).toBeInTheDocument();
  });
});

// Exact plural aria-labels (kindMeta().plural) for the type tabs under test.
// FEA-4019 renamed the MCP tab plural to "MCPs" (distinct from "Tools").
const RE_AGENTS_TAB = /agents/i;
const RE_PLUGINS_TAB = /plugins/i;
const RE_MCP_TAB = /^MCPs$/;
const RE_TOOLS_TAB = /^Tools$/;
const RE_HOOKS_TAB = /^Hooks$/;
const RE_HREF_ROW = /Href Probe Agent/;

// ISS-9625: the component SHAPE comes from the shared fixture factory (the
// `packages/app/agents/AGENTS.md` contract), so a field added to
// `AgentComponent` lands in one place. The INVENTORY below stays local — it is
// this file's own claim about the tab set, not the cross-surface parity record.
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
  // ISS-9398: the href probe. `slug` is set explicitly and differs from `id`,
  // which is what makes the href assertion above able to fail — every other row
  // here lets `makeComponent` default the slug to the id, so an href built from
  // either would look the same.
  makeComponent({
    id: "uuid-href-1",
    slug: "subagent::href-probe",
    name: "Href Probe Agent",
    kind: AgentComponentKind.Subagent,
  }),
];

function testDataSource(): AgentComponentsDataSource {
  return {
    scope: "agent-components:http",
    honorsDateWindow: true,
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
