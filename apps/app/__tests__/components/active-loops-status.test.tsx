/**
 * Unit tests for ActiveLoopsStatus component.
 * Verifies it renders status messages with user names and compute target context.
 */

import { LoopStatus } from "@repo/api/src/types/loop";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/queries/use-loops", () => ({
  useLoopsByProject: vi.fn(() => ({ data: [], isLoading: false })),
}));

import { ActiveLoopsStatus } from "@/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/active-loops-status";
import { useLoopsByProject } from "@/hooks/queries/use-loops";
import { createMockLoopWithUser } from "../fixtures/loops";

const MIKE_PLAN_LOCALLY = /Mike A creating plan locally/;
const JANE_EXECUTE_CLOUD = /Jane D executing in cloud/;

describe("ActiveLoopsStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when there are no active loops", () => {
    vi.mocked(useLoopsByProject).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useLoopsByProject>);

    const { container } = render(<ActiveLoopsStatus projectId="proj-1" />);

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while loading", () => {
    vi.mocked(useLoopsByProject).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useLoopsByProject>);

    const { container } = render(<ActiveLoopsStatus projectId="proj-1" />);

    expect(container.firstChild).toBeNull();
  });

  it("renders 'locally' for a local active loop with computeTarget", () => {
    vi.mocked(useLoopsByProject).mockReturnValue({
      data: [
        createMockLoopWithUser({
          id: "loop-1",
          status: LoopStatus.Running,
          command: "PLAN",
          user: {
            id: "user-1",
            firstName: "Mike",
            lastName: "A",
            avatarUrl: null,
            email: "mike@example.com",
          },
          computeTarget: {
            id: "ct-1",
            machineName: "Mikes-MacBook",
            isOnline: true,
          },
        }),
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useLoopsByProject>);

    render(<ActiveLoopsStatus projectId="proj-1" />);

    expect(screen.getByText(MIKE_PLAN_LOCALLY)).toBeInTheDocument();
  });

  it("renders 'in cloud' for a cloud active loop without computeTarget", () => {
    vi.mocked(useLoopsByProject).mockReturnValue({
      data: [
        createMockLoopWithUser({
          id: "loop-2",
          status: LoopStatus.Running,
          command: "EXECUTE",
          user: {
            id: "user-2",
            firstName: "Jane",
            lastName: "D",
            avatarUrl: null,
            email: "jane@example.com",
          },
          containerId: "arn:aws:ecs:us-east-1:123:task/abc",
        }),
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useLoopsByProject>);

    render(<ActiveLoopsStatus projectId="proj-1" />);

    expect(screen.getByText(JANE_EXECUTE_CLOUD)).toBeInTheDocument();
  });

  it("renders nothing when all loops have terminal statuses", () => {
    vi.mocked(useLoopsByProject).mockReturnValue({
      data: [
        createMockLoopWithUser({
          id: "loop-3",
          status: LoopStatus.Completed,
        }),
        createMockLoopWithUser({
          id: "loop-4",
          status: LoopStatus.Failed,
        }),
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useLoopsByProject>);

    const { container } = render(<ActiveLoopsStatus projectId="proj-1" />);

    expect(container.firstChild).toBeNull();
  });

  it("renders multiple active loops", () => {
    vi.mocked(useLoopsByProject).mockReturnValue({
      data: [
        createMockLoopWithUser({
          id: "loop-5",
          status: LoopStatus.Running,
          command: "PLAN",
          user: {
            id: "user-1",
            firstName: "Mike",
            lastName: "A",
            avatarUrl: null,
            email: "mike@example.com",
          },
          computeTarget: {
            id: "ct-1",
            machineName: "Mikes-MacBook",
            isOnline: true,
          },
        }),
        createMockLoopWithUser({
          id: "loop-6",
          status: LoopStatus.Pending,
          command: "EXECUTE",
          user: {
            id: "user-2",
            firstName: "Jane",
            lastName: "D",
            avatarUrl: null,
            email: "jane@example.com",
          },
        }),
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useLoopsByProject>);

    render(<ActiveLoopsStatus projectId="proj-1" />);

    expect(screen.getByText(MIKE_PLAN_LOCALLY)).toBeInTheDocument();
    expect(screen.getByText(JANE_EXECUTE_CLOUD)).toBeInTheDocument();
  });
});
