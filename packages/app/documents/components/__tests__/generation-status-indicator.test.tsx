import type { GenerationStatus } from "@repo/api/src/types/document";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { GenerationStatusIndicator } from "../generation-status-indicator";

const EXECUTING_PLAN_REGEX = /Executing plan and creating PR\.\.\./i;

/**
 * Renders inside the memory navigation adapter so the component's `useOrgPath`
 * builder and port `Link` resolve. The org slug drives the expected
 * `/test-org/...` hrefs below.
 */
function renderWithNav(ui: ReactElement) {
  const nav = createMemoryNavigation({ orgSlug: "test-org" });
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
    ),
  });
}

describe("GenerationStatusIndicator", () => {
  test("renders nothing when generationStatus is undefined", () => {
    const { container } = renderWithNav(
      <GenerationStatusIndicator generationStatus={undefined} />
    );
    expect(container.firstChild).toBeNull();
  });

  test("does not render indicator when status is NONE", () => {
    const generationStatus: GenerationStatus = {
      status: "NONE",
      command: null,
      htmlUrl: null,
      startedAt: null,
      completedAt: null,
      correlationId: null,
    };
    const { container } = renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders spinner for PENDING state", () => {
    const generationStatus: GenerationStatus = {
      status: "PENDING",
      command: "plan",
      htmlUrl: null,
      startedAt: null,
      completedAt: null,
      correlationId: "test-123",
    };
    renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );
    expect(screen.getByText("Waiting to start...")).toBeInTheDocument();
  });

  test("renders spinner for QUEUED state with execute command", () => {
    const generationStatus: GenerationStatus = {
      status: "QUEUED",
      command: "execute",
      htmlUrl: null,
      startedAt: null,
      completedAt: null,
      correlationId: "test-123",
    };
    renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );
    expect(screen.getByText("Queued for execution...")).toBeInTheDocument();
  });

  test("renders spinner for QUEUED state with plan command", () => {
    const generationStatus: GenerationStatus = {
      status: "QUEUED",
      command: "plan",
      htmlUrl: null,
      startedAt: null,
      completedAt: null,
      correlationId: "test-123",
    };
    renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );
    expect(screen.getByText("Queued for generation...")).toBeInTheDocument();
  });

  test("renders spinner for RUNNING state with execute command", () => {
    const generationStatus: GenerationStatus = {
      status: "RUNNING",
      command: "execute",
      htmlUrl: "https://github.com/test/workflow/123",
      startedAt: new Date(),
      completedAt: null,
      correlationId: "test-123",
    };
    renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );
    expect(
      screen.getByText("Executing plan and creating PR...")
    ).toBeInTheDocument();
  });

  test("renders spinner for RUNNING state with plan command", () => {
    const generationStatus: GenerationStatus = {
      status: "RUNNING",
      command: "plan",
      htmlUrl: "https://github.com/test/workflow/123",
      startedAt: new Date(),
      completedAt: null,
      correlationId: "test-123",
    };
    renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );
    expect(screen.getByText("Generating...")).toBeInTheDocument();
  });

  test("renders CheckCircle icon for SUCCESS", () => {
    const generationStatus: GenerationStatus = {
      status: "SUCCESS",
      command: "execute",
      htmlUrl: "https://github.com/test/workflow/123",
      startedAt: new Date(),
      completedAt: new Date(),
      correlationId: "test-123",
    };
    const { container } = renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );
    // Check for the svg element (lucide-react icons render as svg)
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    // SUCCESS status doesn't show a message in getStatusMessage (returns empty string)
    expect(container.querySelector(".text-green-600")).toBeInTheDocument();
  });

  test("renders XCircleIcon for FAILURE with execute command", () => {
    const generationStatus: GenerationStatus = {
      status: "FAILURE",
      command: "execute",
      htmlUrl: "https://github.com/test/workflow/123",
      startedAt: new Date(),
      completedAt: new Date(),
      correlationId: "test-123",
    };
    const { container } = renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );
    expect(screen.getByText("Plan execution failed")).toBeInTheDocument();
    // Check for text-red-600 class on the link/span element
    expect(container.querySelector(".text-red-600")).toBeInTheDocument();
  });

  test("renders XCircleIcon for FAILURE with plan command", () => {
    const generationStatus: GenerationStatus = {
      status: "FAILURE",
      command: "plan",
      htmlUrl: "https://github.com/test/workflow/123",
      startedAt: new Date(),
      completedAt: new Date(),
      correlationId: "test-123",
    };
    renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );
    expect(screen.getByText("Generation failed")).toBeInTheDocument();
  });

  test("renders status text (not a link) when htmlUrl is provided but source is not loop", () => {
    const generationStatus: GenerationStatus = {
      status: "RUNNING",
      command: "execute",
      htmlUrl: "https://github.com/test/workflow/123",
      startedAt: new Date(),
      completedAt: null,
      correlationId: "test-123",
    };
    const { container } = renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );

    expect(container.querySelector("a")).not.toBeInTheDocument();
    expect(
      within(container).getByText("Executing plan and creating PR...")
    ).toBeInTheDocument();
  });

  test("creates clickable internal link when source is loop with loopId", () => {
    const generationStatus: GenerationStatus = {
      status: "RUNNING",
      command: "execute",
      htmlUrl: null,
      startedAt: new Date(),
      completedAt: null,
      correlationId: "test-123",
      source: "loop",
      loopId: "loop-xyz",
    };
    const { container } = renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );

    const link = container.querySelector("a");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/test-org/loops/loop-xyz");
    const ariaLabel = link?.getAttribute("aria-label");
    expect(ariaLabel).toMatch(EXECUTING_PLAN_REGEX);
  });

  test("does not create link when htmlUrl is null", () => {
    const generationStatus: GenerationStatus = {
      status: "RUNNING",
      command: "execute",
      htmlUrl: null,
      startedAt: new Date(),
      completedAt: null,
      correlationId: "test-123",
    };
    const { container } = renderWithNav(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );

    // Should not render a link element
    expect(container.querySelector("a")).not.toBeInTheDocument();

    // Text should still be rendered as a span within this container
    expect(
      within(container).getByText("Executing plan and creating PR...")
    ).toBeInTheDocument();
  });

  test("shows correct status message for each status + command combination", () => {
    const testCases: Array<{
      status: GenerationStatus["status"];
      command: GenerationStatus["command"];
      expectedMessage: string;
    }> = [
      {
        status: "PENDING",
        command: "plan",
        expectedMessage: "Waiting to start...",
      },
      {
        status: "QUEUED",
        command: "execute",
        expectedMessage: "Queued for execution...",
      },
      {
        status: "QUEUED",
        command: "plan",
        expectedMessage: "Queued for generation...",
      },
      {
        status: "RUNNING",
        command: "execute",
        expectedMessage: "Executing plan and creating PR...",
      },
      {
        status: "RUNNING",
        command: "plan",
        expectedMessage: "Generating...",
      },
      {
        status: "FAILURE",
        command: "execute",
        expectedMessage: "Plan execution failed",
      },
      {
        status: "FAILURE",
        command: "plan",
        expectedMessage: "Generation failed",
      },
    ];

    for (const { status, command, expectedMessage } of testCases) {
      const generationStatus: GenerationStatus = {
        status,
        command,
        htmlUrl: null,
        startedAt: null,
        completedAt: null,
        correlationId: "test-123",
      };
      const { container, unmount } = renderWithNav(
        <GenerationStatusIndicator generationStatus={generationStatus} />
      );
      // Query within the specific container to avoid finding elements from previous renders
      const text = container.querySelector("span:last-child");
      expect(text?.textContent).toBe(expectedMessage);
      unmount();
    }
  });
});
