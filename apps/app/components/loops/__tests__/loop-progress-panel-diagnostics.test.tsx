/**
 * Tests for ErrorEvent in loop-progress-panel.tsx — diagnostic fields rendering.
 *
 * Covers:
 * - renders tokenUsage when present
 * - renders diagnosticsVersion when present
 * - renders log tail trigger button when logTail is present
 * - log tail content is hidden until trigger is clicked
 * - no diagnostic elements rendered when fields are absent
 */

import type { LoopEvent } from "@repo/api/src/types/loop";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

vi.mock("@/hooks/queries/use-loop-polling", () => ({
  useLoopPolling: vi.fn(),
}));

vi.mock("@/hooks/queries/use-loop-stream", () => ({
  useLoopStream: vi.fn(),
}));

// --- Imports ---

import { useLoopPolling } from "@/hooks/queries/use-loop-polling";
import { useLoopStream } from "@/hooks/queries/use-loop-stream";
import { LoopProgressPanel } from "../loop-progress-panel";

// Top-level regex constants (Biome useTopLevelRegex)
const TOKEN_USAGE_REGEX = /1\.5k in \/ 800 out/;
const DIAG_VERSION_REGEX = /Diagnostics version: 1\.2\.3/;
const DIAG_VERSION_ANY_REGEX = /Diagnostics version:/;
const LOG_TAIL_BUTTON_REGEX = /log tail/i;
const LINE_ONE_REGEX = /line 1/;
const TOKEN_IN_REGEX = /\d+(\.\d+)?[kM]? in/;

type MockPolling = {
  events: LoopEvent[];
  isComplete: boolean;
  loopStatus: null;
  loopTokensInput: number;
  loopTokensOutput: number;
};

type MockStream = {
  events: LoopEvent[];
  isComplete: boolean;
  status: "connected";
};

function setupMocks(events: LoopEvent[]) {
  const polling: MockPolling = {
    events,
    isComplete: events.some(
      (e) =>
        e.type === "error" || e.type === "completed" || e.type === "cancelled"
    ),
    loopStatus: null,
    loopTokensInput: 0,
    loopTokensOutput: 0,
  };
  const stream: MockStream = {
    events: [],
    isComplete: false,
    status: "connected",
  };
  vi.mocked(useLoopPolling).mockReturnValue(polling as any);
  vi.mocked(useLoopStream).mockReturnValue(stream as any);
}

const ERROR_EVENT_NO_DIAG: LoopEvent = {
  type: "error",
  code: "SOME_ERROR",
  message: "Something went wrong",
  timestamp: "2026-01-01T00:00:00.000Z",
};

const ERROR_EVENT_WITH_DIAG: LoopEvent = {
  type: "error",
  code: "CONTEXT_LIMIT_EXCEEDED",
  message: "Hit token limit",
  timestamp: "2026-01-01T00:00:00.000Z",
  tokenUsage: { inputTokens: 1500, outputTokens: 800 },
  diagnosticsVersion: "1.2.3",
  logTail: "line 1\nline 2\nline 3",
};

// ---------------------------------------------------------------------------
// ErrorEvent — diagnostic field rendering
// ---------------------------------------------------------------------------

describe("ErrorEvent in LoopProgressPanel — tokenUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders tokenUsage when present", () => {
    setupMocks([ERROR_EVENT_WITH_DIAG]);
    render(<LoopProgressPanel loopId="loop-1" />);

    expect(
      screen.getAllByText(TOKEN_USAGE_REGEX).length
    ).toBeGreaterThanOrEqual(1);
  });

  it("does not render token usage line when tokenUsage is absent", () => {
    setupMocks([ERROR_EVENT_NO_DIAG]);
    render(<LoopProgressPanel loopId="loop-1" />);

    // "Tokens:" should not appear in the error event area for events without tokenUsage
    // (The footer always shows tokens, but this checks the event area)
    const errorDiv = screen.getByText("Error: SOME_ERROR").closest("div");
    expect(errorDiv?.textContent).not.toMatch(TOKEN_IN_REGEX);
  });
});

describe("ErrorEvent in LoopProgressPanel — diagnosticsVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders diagnosticsVersion when present", () => {
    setupMocks([ERROR_EVENT_WITH_DIAG]);
    render(<LoopProgressPanel loopId="loop-1" />);

    expect(screen.getByText(DIAG_VERSION_REGEX)).toBeInTheDocument();
  });

  it("does not render diagnosticsVersion when absent", () => {
    setupMocks([ERROR_EVENT_NO_DIAG]);
    render(<LoopProgressPanel loopId="loop-1" />);

    expect(screen.queryByText(DIAG_VERSION_ANY_REGEX)).not.toBeInTheDocument();
  });
});

describe("ErrorEvent in LoopProgressPanel — logTail collapsible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders log tail trigger button when logTail is present", () => {
    setupMocks([ERROR_EVENT_WITH_DIAG]);
    render(<LoopProgressPanel loopId="loop-1" />);

    expect(
      screen.getByRole("button", { name: LOG_TAIL_BUTTON_REGEX })
    ).toBeInTheDocument();
  });

  it("log tail content is hidden before clicking the trigger", () => {
    setupMocks([ERROR_EVENT_WITH_DIAG]);
    render(<LoopProgressPanel loopId="loop-1" />);

    // Content should not be visible initially
    expect(screen.queryByText("line 1")).not.toBeInTheDocument();
  });

  it("log tail content is shown after clicking the trigger", () => {
    setupMocks([ERROR_EVENT_WITH_DIAG]);
    render(<LoopProgressPanel loopId="loop-1" />);

    const trigger = screen.getByRole("button", { name: LOG_TAIL_BUTTON_REGEX });
    fireEvent.click(trigger);

    expect(screen.getByText(LINE_ONE_REGEX)).toBeInTheDocument();
  });

  it("does not render log tail trigger when logTail is absent", () => {
    setupMocks([ERROR_EVENT_NO_DIAG]);
    render(<LoopProgressPanel loopId="loop-1" />);

    expect(
      screen.queryByRole("button", { name: LOG_TAIL_BUTTON_REGEX })
    ).not.toBeInTheDocument();
  });
});
