/**
 * @file agents-view.test.tsx
 * @description Unit tests for the desktop AgentsView renderer component
 * (FEA-2923 / T-10.11 / T-5.2).
 *
 * Two assertions per the task:
 * 1. When the AGENTS_FEATURE_FLAG_KEY flag is on, the component mounts the
 *    shared `AgentsGroupedList` via a minimal injected test data source.
 * 2. When the flag is off, the component renders null immediately (the
 *    `hiddenNavIds` guard supplements the runtime null guard; both must hold).
 *
 * The shared workspace components (`AgentsGroupedList`, hooks, etc.) require
 * a running API and auth context to function. To keep this a pure unit test
 * we mock every package boundary that would make a network call, and supply a
 * minimal stub `AgentComponentsDataSource` via the `dataSource` test-seam prop.
 */
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the module under test so
// Vitest's hoisting guarantees they are in place when the test file is loaded.
// ---------------------------------------------------------------------------

// Mock the feature-flag hook so tests control the flag value directly.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: vi.fn(),
}));

// Mock the shared workspace list component to a simple test marker. This
// prevents the test from needing a full React-Query + auth + API setup.
vi.mock("@repo/app/agents/components/workspace/agents-grouped-list", () => ({
  AgentsGroupedList: () => (
    <div data-testid="agents-grouped-list">AgentsGroupedList</div>
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

import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
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
  it("renders AgentsGroupedList when the AGENTS_FEATURE_FLAG_KEY flag is on", () => {
    vi.mocked(useFeatureFlagEnabled).mockReturnValue(true);

    render(<AgentsView dataSource={makeStubDataSource()} />);

    expect(screen.getByTestId("agents-grouped-list")).toBeDefined();
    // The mock is called with the agents feature flag key specifically.
    expect(useFeatureFlagEnabled).toHaveBeenCalledWith(AGENTS_FEATURE_FLAG_KEY);
  });

  it("renders null when AGENTS_FEATURE_FLAG_KEY returns false", () => {
    vi.mocked(useFeatureFlagEnabled).mockReturnValue(false);

    const { container } = render(
      <AgentsView dataSource={makeStubDataSource()} />
    );

    // Nothing should be rendered — the flag guard returns null immediately.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("agents-grouped-list")).toBeNull();
  });
});
