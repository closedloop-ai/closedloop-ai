import type { GenerationStatus } from "@repo/api/src/types/artifact";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { GenerationStatusIndicator } from "../generation-status-indicator";

const EXECUTING_PLAN_REGEX =
  /Executing plan and creating PR\.\.\. - View workflow/i;

describe("GenerationStatusIndicator", () => {
  test("renders nothing when generationStatus is undefined", () => {
    const { container } = render(
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
    const { container } = render(
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
    render(<GenerationStatusIndicator generationStatus={generationStatus} />);
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
    render(<GenerationStatusIndicator generationStatus={generationStatus} />);
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
    render(<GenerationStatusIndicator generationStatus={generationStatus} />);
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
    render(<GenerationStatusIndicator generationStatus={generationStatus} />);
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
    render(<GenerationStatusIndicator generationStatus={generationStatus} />);
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
    const { container } = render(
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
    const { container } = render(
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
    render(<GenerationStatusIndicator generationStatus={generationStatus} />);
    expect(screen.getByText("Generation failed")).toBeInTheDocument();
  });

  test("creates clickable link when htmlUrl is provided", () => {
    const generationStatus: GenerationStatus = {
      status: "RUNNING",
      command: "execute",
      htmlUrl: "https://github.com/test/workflow/123",
      startedAt: new Date(),
      completedAt: null,
      correlationId: "test-123",
    };
    const { container } = render(
      <GenerationStatusIndicator generationStatus={generationStatus} />
    );

    const link = container.querySelector("a");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/test/workflow/123"
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
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
    const { container } = render(
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
      const { container, unmount } = render(
        <GenerationStatusIndicator generationStatus={generationStatus} />
      );
      // Query within the specific container to avoid finding elements from previous renders
      const text = container.querySelector("span:last-child");
      expect(text?.textContent).toBe(expectedMessage);
      unmount();
    }
  });
});
