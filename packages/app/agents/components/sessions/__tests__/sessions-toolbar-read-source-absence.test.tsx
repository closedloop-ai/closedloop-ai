import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { DEFAULT_SESSION_FACET_FILTERS } from "../../../lib/session-filter-adapter";
import { SessionsToolbar } from "../sessions-toolbar";

/**
 * ISS-6005 scope 4 (operator direction): the read-source ("Cloud") pill is a
 * STRICT DROP from the Sessions toolbar, on both surfaces. This replaces the
 * ISS-5477 forwarding tests, which pinned the removed pill — a deliberate
 * contract change, named in the PR.
 *
 * Structural absence, proven by counterfactual during development: re-adding
 * the `ReadSourceBadge` render line to `sessions-toolbar.tsx` turns the
 * `queryByTestId("read-source-badge")` assertion red. The badge component and
 * the cutover DECISION machinery (ISS-5714) survive for their other mounts
 * (desktop dashboard header, Branches) — this asserts only that the Sessions
 * toolbar renders no such pill, and accepts no prop that could.
 */
describe("SessionsToolbar read-source pill removal", () => {
  it("renders no read-source badge", () => {
    render(
      <AppCoreStoryProviders>
        <SessionsToolbar
          dateRange="7d"
          filters={DEFAULT_SESSION_FACET_FILTERS}
          onDateRangeChange={vi.fn()}
          onFiltersChange={vi.fn()}
          onToggleColumn={vi.fn()}
          visibleColumns={new Set<string>()}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.queryByTestId("read-source-badge")).toBeNull();
    expect(screen.queryByText("Cloud")).toBeNull();
  });

  it("declares no read-source props on its contract", () => {
    // A compile-time statement kept as a runtime no-op: assigning the removed
    // prop names must fail `tsc`. If someone re-adds the props, this line is
    // where the re-addition has to be made deliberate.
    type ToolbarProps = Parameters<typeof SessionsToolbar>[0];
    const hasReadSourceProp: "readSource" extends keyof ToolbarProps
      ? true
      : false = false;
    expect(hasReadSourceProp).toBe(false);
  });
});
