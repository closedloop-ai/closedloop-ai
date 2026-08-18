/**
 * @file agents-view.test.tsx
 * @description Unit tests for the desktop AgentsView renderer component
 * (FEA-2923 / T-10.11 / T-5.2).
 *
 * FEA-3994: the Agents Workspace is now always-on (its Labs flag was graduated
 * and removed), so the view mounts the shared `AgentsGroupedList`
 * unconditionally — there is no longer a flag-off null guard to exercise.
 *
 * The shared workspace components (`AgentsGroupedList`, hooks, etc.) require
 * a running API and auth context to function. To keep this a pure unit test
 * we mock every package boundary that would make a network call, and supply a
 * minimal stub `AgentComponentsDataSource` via the `dataSource` test-seam prop.
 */
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the module under test so
// Vitest's hoisting guarantees they are in place when the test file is loaded.
// ---------------------------------------------------------------------------

// Mock the shared workspace list component to a simple test marker. This
// prevents the test from needing a full React-Query + auth + API setup. The
// stub RENDERS its `pluginsFooter` prop so the desktop adapter's footer wiring
// (FEA-4085: desktop keeps its plugin management panel reachable under the
// Plugins tab) is observable — a prop-blind stub could never prove it.
vi.mock("@repo/app/agents/components/workspace/agents-grouped-list", () => ({
  AgentsGroupedList: ({
    pluginsFooter,
  }: {
    pluginsFooter?: React.ReactNode;
  }) => (
    <div data-testid="agents-grouped-list">
      AgentsGroupedList
      {pluginsFooter}
    </div>
  ),
}));

// The desktop plugin management panel injected as the list's `pluginsFooter`.
// Stubbed to a marker so the wiring is asserted without the IPC/render graph.
vi.mock("../plugins-panel", () => ({
  PluginsPanel: () => (
    <div data-testid="plugins-panel-marker">PluginsPanel</div>
  ),
}));

// The provider just needs to render its children; the test data source is
// supplied via the `dataSource` prop on AgentsView, not through the provider.
vi.mock("@repo/app/agents/data-source/provider", () => ({
  AgentComponentsDataSourceProvider: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <>{children}</>,
}));

// route-table helpers used by AgentsView; only agentDetailHref is needed.
vi.mock("../../../navigation/route-table", () => ({
  agentDetailHref: (slug: string) => `#/agents/${slug}`,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER the mocks are declared.
// ---------------------------------------------------------------------------

import { AgentsView } from "../agents-view";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal stub data source — satisfies the type without any network calls. */
function makeStubDataSource(): AgentComponentsDataSource {
  return {
    scope: "agent-components:test-stub",
    list: () => Promise.resolve({ items: [], total: 0 }),
    detail: () => Promise.reject(new Error("not implemented")),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentsView (T-10.11)", () => {
  it("renders AgentsGroupedList unconditionally (always-on, FEA-3994)", () => {
    render(<AgentsView dataSource={makeStubDataSource()} />);

    expect(screen.getByTestId("agents-grouped-list")).toBeDefined();
  });

  it("injects the plugin management panel as the list's pluginsFooter (FEA-4085 keeps desktop pack management reachable)", () => {
    render(<AgentsView dataSource={makeStubDataSource()} />);

    // The desktop adapter passes `<PluginsPanel />` as `pluginsFooter`; the
    // stubbed list renders that prop, so the marker proves the wiring survives.
    expect(screen.getByTestId("plugins-panel-marker")).toBeDefined();
  });
});
