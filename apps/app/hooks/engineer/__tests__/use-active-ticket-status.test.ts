import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseQuery = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  queryOptions: (opts: unknown) => opts,
}));

vi.mock("@/lib/engineer/queries/closedloop", () => ({
  closedloopStatusOptions: (ticketId: string, repoPath: string | null) => ({
    queryKey: ["closedloop-status", ticketId, repoPath],
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

  it("reports isWaitingForClosedLoop before first status arrives", () => {
    mockUseQuery.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useActiveTicketStatus(makeProps()));

    expect(result.current.isWaitingForClosedLoop).toBe(true);
    expect(result.current.isLaunchingOrAccepting).toBe(true);
  });

  it("clears isWaitingForClosedLoop once status arrives", () => {
    mockUseQuery.mockReturnValue({
      data: { status: "AWAITING_USER" },
    });

    const { result } = renderHook(() => useActiveTicketStatus(makeProps()));

    expect(result.current.isWaitingForClosedLoop).toBe(false);
    expect(result.current.isAwaitingUser).toBe(true);
  });

  it("does NOT flash isWaitingForClosedLoop when status transiently drops to undefined", () => {
    // First render: valid status arrives
    mockUseQuery.mockReturnValue({
      data: { status: "AWAITING_USER" },
    });

    const { result, rerender } = renderHook(() =>
      useActiveTicketStatus(makeProps())
    );

    expect(result.current.isWaitingForClosedLoop).toBe(false);
    expect(result.current.isAwaitingUser).toBe(true);

    // Second render: poll returns undefined (transient relay failure)
    mockUseQuery.mockReturnValue({ data: undefined });
    rerender();

    // Key assertion: should NOT go back to "waiting" / "launching"
    expect(result.current.isWaitingForClosedLoop).toBe(false);
    expect(result.current.isLaunchingOrAccepting).toBe(false);
  });

  it("does NOT flash isWaitingForClosedLoop when status has null status field", () => {
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

    expect(result.current.isWaitingForClosedLoop).toBe(false);
    expect(result.current.isLaunchingOrAccepting).toBe(false);
  });

  it("does not show waiting when repoPath is null", () => {
    mockUseQuery.mockReturnValue({ data: undefined });

    const { result } = renderHook(() =>
      useActiveTicketStatus(makeProps({ repoPath: null }))
    );

    expect(result.current.isWaitingForClosedLoop).toBe(false);
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

  it("resets status latch when repoPath changes (session boundary)", () => {
    // First session: status arrives
    mockUseQuery.mockReturnValue({ data: { status: "COMPLETED" } });
    const props = { ...makeProps(), repoPath: "/repo-a" as string | null };

    const { result, rerender } = renderHook(
      (p: ReturnType<typeof makeProps>) => useActiveTicketStatus(p),
      { initialProps: props }
    );
    expect(result.current.isWaitingForClosedLoop).toBe(false);

    // Session cleared → new session with different repoPath, no status yet
    mockUseQuery.mockReturnValue({ data: undefined });
    rerender({ ...props, repoPath: "/repo-b" });

    // Latch should have reset, so isWaitingForClosedLoop fires for the new session
    expect(result.current.isWaitingForClosedLoop).toBe(true);
  });

  it("resets status latch when a new launch begins on the same session", () => {
    // Initial: status was received (e.g. AWAITING_USER after planning)
    mockUseQuery.mockReturnValue({ data: { status: "AWAITING_USER" } });
    const props = makeProps({ isLaunching: false });

    const { result, rerender } = renderHook(
      (p: ReturnType<typeof makeProps>) => useActiveTicketStatus(p),
      { initialProps: props }
    );
    expect(result.current.isWaitingForClosedLoop).toBe(false);

    // User accepts plan → new launch starts, poll briefly returns no status
    mockUseQuery.mockReturnValue({ data: undefined });
    rerender({ ...props, isLaunching: true });

    // isLaunching is true so isLaunchingOrAccepting is true regardless,
    // but the latch itself should have reset
    expect(result.current.isLaunchingOrAccepting).toBe(true);

    // Launch completes, still no status from new run
    rerender({ ...props, isLaunching: false });

    // Without reset this would be false (stale latch); with reset it's true
    expect(result.current.isWaitingForClosedLoop).toBe(true);
  });

  it("resets status latch when resume begins", () => {
    mockUseQuery.mockReturnValue({ data: { status: "COMPLETED" } });
    const props = makeProps({ isResuming: false });

    const { result, rerender } = renderHook(
      (p: ReturnType<typeof makeProps>) => useActiveTicketStatus(p),
      { initialProps: props }
    );
    expect(result.current.isWaitingForClosedLoop).toBe(false);

    // Resume starts, poll briefly empty
    mockUseQuery.mockReturnValue({ data: undefined });
    rerender({ ...props, isResuming: true });

    // Resume ends, still waiting for first status
    rerender({ ...props, isResuming: false });
    expect(result.current.isWaitingForClosedLoop).toBe(true);
  });
});
