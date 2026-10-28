import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { AGENT_OPS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/agent-ops-complete-surface-flag";
import { makeComponent } from "@repo/app/agents/components/workspace/agent-component-fixtures";
import {
  AGENTS_LIST_SURFACE_V2_TEST_ID,
  AGENTS_PLUGIN_MANAGEMENT_TEST_ID,
} from "@repo/app/agents/components/workspace/agents-list-surface-v2";
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9398 — the desktop Agents branch selected by `agent-ops-complete-surface`.
 *
 * The gate chooses between two whole components, so both are driven here from
 * one baseline: OFF must render exactly what ships today, ON must render the
 * shared `AgentsListSurfaceV2`. The v1 list is mocked to a marker and the v2
 * surface is left REAL, which is what makes the two distinguishable and what
 * makes the ON case a genuine mount rather than an assertion about props.
 *
 * That real mount is the point. A shared component newly hosted on a second
 * shell breaks on providers the first shell happened to supply, and this repo
 * has shipped that defect; a test that stubbed the surface would prove nothing
 * about it. Anything the surface reaches for that is not provided throws out of
 * `render` and fails these cases.
 *
 * WHAT THIS DOES NOT PROVE, and where that is proven instead. The harness here
 * supplies the app-core ports, so this says nothing about whether the REAL
 * desktop provider graph reaches them — that is
 * `apps/desktop/test/e2e/agents-list-surface-v2.spec.ts`, which drives the
 * shipped shell over a seeded SQLite corpus. This file is also what the e2e
 * spec's pinned literals lean on: it imports the flag key and both test ids for
 * real, so a rename reddens here rather than silently in a spec that restated
 * them.
 */

// The plugin-management bridge is real desktop IPC; stubbed to a marker so the
// capability's WIRING is asserted without the pack catalog's request graph.
const PLUGINS_PANEL_MARKER = "plugins-panel-marker";
vi.mock("../plugins-panel", () => ({
  PluginsPanel: () => (
    <div data-testid={PLUGINS_PANEL_MARKER}>PluginsPanel</div>
  ),
}));

const V1_LIST_MARKER = "agents-grouped-list";
vi.mock("@repo/app/agents/components/workspace/agents-grouped-list", () => ({
  AgentsGroupedList: () => <div data-testid={V1_LIST_MARKER}>v1</div>,
}));

vi.mock("../../../navigation/route-table", () => ({
  agentDetailHref: (slug: string) => `#/agents/${slug}`,
}));

import { AgentsView } from "../agents-view";

const PLUGIN_ROW_NAME = "iss-9398/release-notes";
const PLUGIN_ROW_SLUG = "plugin::iss-9398-release-notes";
const PLUGINS_TAB_LABEL = "Plugins";

function pluginInventorySource(): AgentComponentsDataSource {
  const plugin = makeComponent({
    id: "uuid-iss-9398-plugin",
    invocations: 4,
    kind: AgentComponentKind.Plugin,
    name: PLUGIN_ROW_NAME,
    sessions: 1,
    slug: PLUGIN_ROW_SLUG,
  });
  return {
    detail: () => Promise.reject(new Error("detail unused in mount tests")),
    honorsDateWindow: false,
    list: () => Promise.resolve({ items: [plugin], total: 1 }),
    scope: "agent-components:test",
  };
}

function renderAgentsView(enabledFlags: readonly string[]) {
  return render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <AgentsView dataSource={pluginInventorySource()} />
    </AppCoreStoryProviders>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktop AgentsView branch selection (ISS-9398)", () => {
  it("keeps the existing workspace with the gate closed", async () => {
    renderAgentsView([]);

    expect(await screen.findByTestId(V1_LIST_MARKER)).toBeTruthy();
    expect(screen.queryByTestId(AGENTS_LIST_SURFACE_V2_TEST_ID)).toBeNull();
  });

  it("mounts the real complete surface with the gate open", async () => {
    renderAgentsView([AGENT_OPS_COMPLETE_SURFACE_FLAG_KEY]);

    expect(
      await screen.findByTestId(AGENTS_LIST_SURFACE_V2_TEST_ID)
    ).toBeTruthy();
    // The v1 marker's absence is what makes the two branches exclusive rather
    // than one being additive.
    expect(screen.queryByTestId(V1_LIST_MARKER)).toBeNull();
  });

  it("declares its plugin-management bridge, which the surface places under the Plugins tab", async () => {
    renderAgentsView([AGENT_OPS_COMPLETE_SURFACE_FLAG_KEY]);

    await screen.findByText(PLUGIN_ROW_NAME);
    // Absent on the default tab, so the assertion below is the SURFACE's
    // placement rule and not a panel the host renders unconditionally.
    expect(screen.queryByTestId(AGENTS_PLUGIN_MANAGEMENT_TEST_ID)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: PLUGINS_TAB_LABEL }));

    expect(
      await screen.findByTestId(AGENTS_PLUGIN_MANAGEMENT_TEST_ID)
    ).toBeTruthy();
    expect(screen.getByTestId(PLUGINS_PANEL_MARKER)).toBeTruthy();
  });
});

/**
 * The route the host supplies, asserted by VALUE.
 *
 * The capability-parity ledger reads attribute PRESENCE, so it cannot see which
 * field the href is built from — and `agentDetailHref(item.id)` instead of
 * `item.slug` sends every desktop row to a detail endpoint that resolves by
 * identity slug, with nothing else in the suite going red. The mocked
 * `agentDetailHref` above makes the composed value observable.
 */
describe("desktop AgentsView row route (ISS-9398)", () => {
  it("links a row by the component's identity slug, not its DB id", async () => {
    renderAgentsView([AGENT_OPS_COMPLETE_SURFACE_FLAG_KEY]);

    const link = await screen.findByRole("link", { name: PLUGIN_ROW_NAME });
    expect(link.getAttribute("href")).toBe(`#/agents/${PLUGIN_ROW_SLUG}`);
  });
});
