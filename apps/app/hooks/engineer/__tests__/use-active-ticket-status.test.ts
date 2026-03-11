import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseQuery = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  queryOptions: (opts: unknown) => opts,
}));

vi.mock("@/lib/engineer/queries/symphony", () => ({
  symphonyStatusOptions: (ticketId: string, repoPath: string | null) => ({
    queryKey: ["symphony-status", ticketId, repoPath],
    queryFn: vi.fn(),
    enabled: !!repoPath,
  }),
}));

import { useActiveTicketStatus } from "../use-active-ticket-status";

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    ticketId: "AI-100",
    repoPath: "/repo" as string | null,
    isLaunching: false,
    isResuming: false,
    ...overrides,
  };
}

describe("useActiveTicketStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseQuery.mockReturnValue({ data: undefined });
  });

  it("reports isWaitingForSymphony before first status arrives", () => {
    mockUseQuery.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useActiveTicketStatus(makeProps()));

    expect(result.current.isWaitingForSymphony).toBe(true);
    expect(result.current.isLaunchingOrAccepting).toBe(true);
  });

  it("clears isWaitingForSymphony once status arrives", () => {
    mockUseQuery.mockReturnValue({
      data: { status: "AWAITING_USER" },
    });

    const { result } = renderHook(() => useActiveTicketStatus(makeProps()));

    expect(result.current.isWaitingForSymphony).toBe(false);
    expect(result.current.isAwaitingUser).toBe(true);
  });

  it("does NOT flash isWaitingForSymphony when status transiently drops to undefined", () => {
    // First render: valid status arrives
    mockUseQuery.mockReturnValue({
      data: { status: "AWAITING_USER" },
    });

    const { result, rerender } = renderHook(() =>
      useActiveTicketStatus(makeProps())
    );

    expect(result.current.isWaitingForSymphony).toBe(false);
    expect(result.current.isAwaitingUser).toBe(true);

    // Second render: poll returns undefined (transient relay failure)
    mockUseQuery.mockReturnValue({ data: undefined });
    rerender();

    // Key assertion: should NOT go back to "waiting" / "launching"
    expect(result.current.isWaitingForSymphony).toBe(false);
    expect(result.current.isLaunchingOrAccepting).toBe(false);
  });

  it("does NOT flash isWaitingForSymphony when status has null status field", () => {
    // First render: valid status
    mockUseQuery.mockReturnValue({
      data: { status: "COMPLETED" },
    });

    const { result, rerender } = renderHook(() =>
      useActiveTicketStatus(makeProps())
    );

    expect(result.current.isCompleted).toBe(true);

    // Second render: poll returns object with null status
    mockUseQuery.mockReturnValue({ data: { status: null } });
    rerender();

    expect(result.current.isWaitingForSymphony).toBe(false);
    expect(result.current.isLaunchingOrAccepting).toBe(false);
  });

  it("does not show waiting when repoPath is null", () => {
    mockUseQuery.mockReturnValue({ data: undefined });

    const { result } = renderHook(() =>
      useActiveTicketStatus(makeProps({ repoPath: null }))
    );

    expect(result.current.isWaitingForSymphony).toBe(false);
  });

  it("includes isLaunching in isLaunchingOrAccepting", () => {
    mockUseQuery.mockReturnValue({
      data: { status: "AWAITING_USER" },
    });

    const { result } = renderHook(() =>
      useActiveTicketStatus(makeProps({ isLaunching: true }))
    );

    expect(result.current.isLaunchingOrAccepting).toBe(true);
  });

  it("includes isResuming in isLaunchingOrAccepting", () => {
    mockUseQuery.mockReturnValue({
      data: { status: "AWAITING_USER" },
    });

    const { result } = renderHook(() =>
      useActiveTicketStatus(makeProps({ isResuming: true }))
    );

    expect(result.current.isLaunchingOrAccepting).toBe(true);
  });

  it("derives isCoding only when executing AND plan accepted", () => {
    localStorage.setItem("plan-accepted:AI-100", "true");
    mockUseQuery.mockReturnValue({
      data: { status: "IN_PROGRESS" },
    });

    const { result } = renderHook(() => useActiveTicketStatus(makeProps()));

    expect(result.current.isCoding).toBe(true);
    expect(result.current.isExecuting).toBe(true);
  });

  it("isCoding is false when executing but plan not accepted", () => {
    mockUseQuery.mockReturnValue({
      data: { status: "IN_PROGRESS" },
    });

    const { result } = renderHook(() => useActiveTicketStatus(makeProps()));

    expect(result.current.isCoding).toBe(false);
    expect(result.current.isExecuting).toBe(true);
  });

  it("exposes taskProgress from symphony status", () => {
    const progress = { pending: 2, completed: 3, total: 5 };
    mockUseQuery.mockReturnValue({
      data: { status: "IN_PROGRESS", taskProgress: progress },
    });

    const { result } = renderHook(() => useActiveTicketStatus(makeProps()));

    expect(result.current.taskProgress).toEqual(progress);
  });
});
