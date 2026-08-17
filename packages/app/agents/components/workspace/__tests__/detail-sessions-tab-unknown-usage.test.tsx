/**
 * ISS-5363 (wongk review): the component-detail Sessions tab must not deny
 * sessions the payload never measured.
 *
 * `AgentComponentDetail.sessions` is nullable on the wire, and `componentMetrics`
 * renders `—` for it. The tab collapsed the same value with `?? 0` and then
 * rendered "No sessions yet" — a confident denial sitting directly under a dash,
 * off one payload. This pins the three empty states apart at the RENDER
 * boundary, so a future edit that reintroduces the coercion fails here.
 */
import type { AgentComponent } from "@repo/api/src/types/agent-component";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DetailSessionsTab } from "../detail-sessions-tab";

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function renderTab(sessionsMetric: number | null | undefined) {
  const component = {
    id: "component-1",
    name: "Test component",
    sessions: sessionsMetric,
  } as AgentComponent;
  return render(<DetailSessionsTab component={component} sessions={[]} />, {
    wrapper: ({ children }) => (
      <AppCoreStoryProviders enabledFlags={[]}>
        {children}
      </AppCoreStoryProviders>
    ),
  });
}

describe("DetailSessionsTab — unmeasured session count (ISS-5363)", () => {
  it("does not claim 'No sessions yet' when the count was never measured", () => {
    renderTab(null);

    expect(screen.queryByText("No sessions yet")).toBeNull();
    expect(screen.getByText("Sessions unavailable")).toBeInTheDocument();
  });

  it("does not claim 'No sessions yet' when a skewed payload omits the count", () => {
    renderTab(undefined);

    expect(screen.queryByText("No sessions yet")).toBeNull();
    expect(screen.getByText("Sessions unavailable")).toBeInTheDocument();
  });

  it("still states the true zero plainly when the count WAS measured as zero", () => {
    renderTab(0);

    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(screen.queryByText("Sessions unavailable")).toBeNull();
  });

  it("keeps the details-unavailable copy when a real count exists but no rows do", () => {
    renderTab(4);

    expect(screen.getByText("Session details unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No sessions yet")).toBeNull();
  });
});
