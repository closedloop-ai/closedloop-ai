/**
 * Tests for EventRow in loop-audit-log.tsx — error event diagnostic fields.
 *
 * Covers:
 * - Error row is expandable when diagnostics are present
 * - Error row is NOT expandable when no diagnostics
 * - Expanded content includes tokenUsage
 * - Expanded content includes diagnosticsVersion
 * - Expanded content includes logTail
 * - All three fields appear together in expanded content
 */

import type {
  LoopEvent,
  LoopEventsPaginatedResponse,
} from "@repo/api/src/types/loop";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

vi.mock("@/hooks/queries/use-loops", () => ({
  useLoopEventsPaginated: vi.fn(),
}));

// Mock date utilities to avoid locale-dependent output
vi.mock("@/lib/date-utils", () => ({
  formatRelativeTime: () => "just now",
  formatDateTime: () => "Jan 1, 2026 00:00:00",
}));

// --- Imports ---

import { useLoopEventsPaginated } from "@/hooks/queries/use-loops";
import { RUNNER_RATE_LIMIT_EVENT } from "../../../__tests__/fixtures/loops";
import { LoopAuditLog } from "../loop-audit-log";

// Top-level regex constants (Biome useTopLevelRegex)
const SOME_ERROR_REGEX = /SOME_ERROR/;
const CONTEXT_LIMIT_REGEX = /CONTEXT_LIMIT_EXCEEDED/;
const TOKENS_100_REGEX = /Tokens: 100 in \/ 50 out/;
const TOKENS_1200_REGEX = /Tokens: 1200 in \/ 600 out/;
const TOKENS_50_REGEX = /Tokens: 50 in \/ 25 out/;
const LOG_TAIL_REGEX = /Log tail:/;
const SOME_LOG_CONTENT_REGEX = /some log tail content/;
const LINE_A_REGEX = /line A/;
const DIAG_VERSION_200_REGEX = /Diagnostics version: 2\.0\.0/;
const DIAG_VERSION_300_REGEX = /Diagnostics version: 3\.0\.0/;
const RUNNER_RATE_LIMIT_SUMMARY_REGEX =
  /Claude rate limit: Claude rate limit reached\./;

function makeResponse(events: LoopEvent[]): {
  data: LoopEventsPaginatedResponse;
  isLoading: false;
  error: null;
} {
  return {
    data: { data: events, total: events.length },
    isLoading: false,
    error: null,
  };
}

const BASE_ERROR_EVENT: LoopEvent = {
  type: "error",
  code: "SOME_ERROR",
  message: "Something went wrong",
  timestamp: "2026-01-01T00:00:00.000Z",
};

const FULL_DIAG_ERROR_EVENT: LoopEvent = {
  type: "error",
  code: "CONTEXT_LIMIT_EXCEEDED",
  message: "Context limit hit",
  timestamp: "2026-01-01T00:00:00.000Z",
  tokenUsage: { inputTokens: 1200, outputTokens: 600 },
  diagnosticsVersion: "2.0.0",
  logTail: "line A\nline B\nline C",
};

// ---------------------------------------------------------------------------
// isExpandableEvent — error row expandability
// ---------------------------------------------------------------------------

describe("LoopAuditLog EventRow — error expandability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("error row without diagnostics is NOT expandable (click does not reveal content)", () => {
    vi.mocked(useLoopEventsPaginated).mockReturnValue(
      makeResponse([BASE_ERROR_EVENT]) as any
    );

    render(<LoopAuditLog loopId="loop-1" />);

    expect(screen.getByText(SOME_ERROR_REGEX)).toBeInTheDocument();

    // Clicking the row should not reveal token or log content for a plain error event
    fireEvent.click(
      screen.getByText(SOME_ERROR_REGEX).closest("tr") as Element
    );
    expect(screen.queryByText(LOG_TAIL_REGEX)).not.toBeInTheDocument();
  });

  it("error row renders runner failure reason from result subcode", () => {
    vi.mocked(useLoopEventsPaginated).mockReturnValue(
      makeResponse([RUNNER_RATE_LIMIT_EVENT]) as any
    );

    render(<LoopAuditLog loopId="loop-1" />);

    expect(
      screen.getByText(RUNNER_RATE_LIMIT_SUMMARY_REGEX)
    ).toBeInTheDocument();
  });

  it("error row with tokenUsage is expandable", () => {
    vi.mocked(useLoopEventsPaginated).mockReturnValue(
      makeResponse([
        {
          ...BASE_ERROR_EVENT,
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
        },
      ]) as any
    );

    render(<LoopAuditLog loopId="loop-1" />);

    const row = screen.getByText(SOME_ERROR_REGEX).closest("tr") as Element;
    fireEvent.click(row);

    expect(screen.getByText(TOKENS_100_REGEX)).toBeInTheDocument();
  });

  it("error row with logTail is expandable", () => {
    vi.mocked(useLoopEventsPaginated).mockReturnValue(
      makeResponse([
        { ...BASE_ERROR_EVENT, logTail: "some log tail content" },
      ]) as any
    );

    render(<LoopAuditLog loopId="loop-1" />);

    const row = screen.getByText(SOME_ERROR_REGEX).closest("tr") as Element;
    fireEvent.click(row);

    expect(screen.getByText(LOG_TAIL_REGEX)).toBeInTheDocument();
    expect(screen.getByText(SOME_LOG_CONTENT_REGEX)).toBeInTheDocument();
  });

  it("error row with diagnosticsVersion is expandable", () => {
    vi.mocked(useLoopEventsPaginated).mockReturnValue(
      makeResponse([
        { ...BASE_ERROR_EVENT, diagnosticsVersion: "3.0.0" },
      ]) as any
    );

    render(<LoopAuditLog loopId="loop-1" />);

    const row = screen.getByText(SOME_ERROR_REGEX).closest("tr") as Element;
    fireEvent.click(row);

    expect(screen.getByText(DIAG_VERSION_300_REGEX)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Expanded content — all diagnostic fields
// ---------------------------------------------------------------------------

describe("LoopAuditLog EventRow — expanded content includes all diagnostic fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expanded row shows all three fields when all are present", () => {
    vi.mocked(useLoopEventsPaginated).mockReturnValue(
      makeResponse([FULL_DIAG_ERROR_EVENT]) as any
    );

    render(<LoopAuditLog loopId="loop-1" />);

    const row = screen.getByText(CONTEXT_LIMIT_REGEX).closest("tr") as Element;
    fireEvent.click(row);

    expect(screen.getByText(TOKENS_1200_REGEX)).toBeInTheDocument();
    expect(screen.getByText(DIAG_VERSION_200_REGEX)).toBeInTheDocument();
    expect(screen.getByText(LOG_TAIL_REGEX)).toBeInTheDocument();
    expect(screen.getByText(LINE_A_REGEX)).toBeInTheDocument();
  });

  it("expanded row shows only tokenUsage when only that field is present", () => {
    vi.mocked(useLoopEventsPaginated).mockReturnValue(
      makeResponse([
        {
          ...BASE_ERROR_EVENT,
          tokenUsage: { inputTokens: 50, outputTokens: 25 },
        },
      ]) as any
    );

    render(<LoopAuditLog loopId="loop-1" />);

    const row = screen.getByText(SOME_ERROR_REGEX).closest("tr") as Element;
    fireEvent.click(row);

    expect(screen.getByText(TOKENS_50_REGEX)).toBeInTheDocument();
    expect(screen.queryByText(DIAG_VERSION_200_REGEX)).not.toBeInTheDocument();
    expect(screen.queryByText(LOG_TAIL_REGEX)).not.toBeInTheDocument();
  });
});
