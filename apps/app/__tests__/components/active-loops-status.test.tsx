import { LoopStatus } from "@repo/api/src/types/loop";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useLoopsByProject: vi.fn(() => ({ data: [], isLoading: false })),
}));

import { useLoopsByProject } from "@repo/app/loops/hooks/use-loops";
import { createMockLoopWithUser } from "@repo/app/shared/test-fixtures/loops";
import { ActiveLoopsStatus } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/active-loops-status";

const ONE_LOOP_RUNNING = /1 loop running/;
const TWO_LOOPS_RUNNING = /2 loops running/;

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

  it("renders '1 loop running' for a single active loop", () => {
    vi.mocked(useLoopsByProject).mockReturnValue({
      data: [
        createMockLoopWithUser({
          id: "loop-1",
          status: LoopStatus.Running,
          command: "PLAN",
        }),
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useLoopsByProject>);

    render(<ActiveLoopsStatus projectId="proj-1" />);

    expect(screen.getByText(ONE_LOOP_RUNNING)).toBeInTheDocument();
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

  it("renders '2 loops running' for multiple active loops", () => {
    vi.mocked(useLoopsByProject).mockReturnValue({
      data: [
        createMockLoopWithUser({
          id: "loop-5",
          status: LoopStatus.Running,
          command: "PLAN",
        }),
        createMockLoopWithUser({
          id: "loop-6",
          status: LoopStatus.Pending,
          command: "EXECUTE",
        }),
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useLoopsByProject>);

    render(<ActiveLoopsStatus projectId="proj-1" />);

    expect(screen.getByText(TWO_LOOPS_RUNNING)).toBeInTheDocument();
  });
});
