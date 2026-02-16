import type { ActivityResponse } from "@repo/api/src/types/activity";
import { toast } from "@repo/design-system/components/ui/sonner";
import { renderHook } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMergeNotification } from "./use-merge-notification";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
  },
}));

describe("useMergeNotification", () => {
  const mockRouterPush = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({ push: mockRouterPush } as any);
  });

  it("does not toast on initial page load (seeds existing events)", () => {
    const mockActivity: ActivityResponse = {
      activities: [
        {
          id: "event-1",
          type: "GITHUB_PR_MERGED",
          description: "Pull request merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "Test PR",
            artifactId: "abc",
            prUrl: "https://github.com/org/repo/pull/1",
          },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    renderHook(() => useMergeNotification(mockActivity, "proj-1", "team-1"));

    // Initial load should NOT toast — events are seeded as already seen
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("toasts for new events arriving after initial load", () => {
    const initialActivity: ActivityResponse = {
      activities: [
        {
          id: "event-1",
          type: "GITHUB_PR_MERGED",
          description: "Old PR",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: { prTitle: "Old PR", artifactId: "abc" },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    const { rerender } = renderHook(
      ({ activityData }) =>
        useMergeNotification(activityData, "proj-1", "team-1"),
      { initialProps: { activityData: initialActivity } }
    );

    expect(toast.success).not.toHaveBeenCalled();

    // Simulate new event arriving via polling
    const updatedActivity: ActivityResponse = {
      activities: [
        {
          id: "event-2",
          type: "GITHUB_PR_MERGED",
          description: "New PR merged",
          timestamp: new Date("2024-01-15T11:00:00Z"),
          metadata: {
            prTitle: "New PR",
            artifactId: "xyz",
          },
          actor: undefined,
        },
        ...initialActivity.activities,
      ],
      pagination: { page: 1, pageSize: 10, total: 2 },
    };

    rerender({ activityData: updatedActivity });

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("New PR", {
      description: "Pull request has been merged",
      action: {
        label: "View Artifact",
        onClick: expect.any(Function),
      },
    });
  });

  it("uses fallback title when prTitle is missing", () => {
    const initialActivity: ActivityResponse = {
      activities: [],
      pagination: { page: 1, pageSize: 10, total: 0 },
    };

    const { rerender } = renderHook(
      ({ activityData }) =>
        useMergeNotification(activityData, "proj-1", "team-1"),
      { initialProps: { activityData: initialActivity } }
    );

    const updatedActivity: ActivityResponse = {
      activities: [
        {
          id: "event-3",
          type: "GITHUB_PR_MERGED",
          description: "Pull request merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: { artifactId: "abc" },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    rerender({ activityData: updatedActivity });

    expect(toast.success).toHaveBeenCalledWith("Pull request merged", {
      description: "Pull request has been merged",
      action: {
        label: "View Artifact",
        onClick: expect.any(Function),
      },
    });
  });

  it("prevents duplicate toasts for same event across re-renders", () => {
    const initialActivity: ActivityResponse = {
      activities: [],
      pagination: { page: 1, pageSize: 10, total: 0 },
    };

    const { rerender } = renderHook(
      ({ activityData }) =>
        useMergeNotification(activityData, "proj-1", "team-1"),
      { initialProps: { activityData: initialActivity } }
    );

    const updatedActivity: ActivityResponse = {
      activities: [
        {
          id: "event-4",
          type: "GITHUB_PR_MERGED",
          description: "Duplicate PR",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: { prTitle: "Duplicate PR", artifactId: "abc" },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    rerender({ activityData: updatedActivity });
    expect(toast.success).toHaveBeenCalledTimes(1);

    // Re-render with same data
    rerender({ activityData: updatedActivity });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("ignores non-GITHUB_PR_MERGED events", () => {
    const initialActivity: ActivityResponse = {
      activities: [],
      pagination: { page: 1, pageSize: 10, total: 0 },
    };

    const { rerender } = renderHook(
      ({ activityData }) =>
        useMergeNotification(activityData, "proj-1", "team-1"),
      { initialProps: { activityData: initialActivity } }
    );

    const updatedActivity: ActivityResponse = {
      activities: [
        {
          id: "event-5",
          type: "GITHUB_PR_CREATED",
          description: "Pull request created",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: { prTitle: "New PR", artifactId: "abc" },
          actor: undefined,
        },
        {
          id: "event-6",
          type: "GITHUB_ACTION_COMPLETED",
          description: "Action completed",
          timestamp: new Date("2024-01-15T10:05:00Z"),
          metadata: {},
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 2 },
    };

    rerender({ activityData: updatedActivity });

    expect(toast.success).not.toHaveBeenCalled();
  });

  it("handles undefined activityData gracefully", () => {
    renderHook(() => useMergeNotification(undefined, "proj-1", "team-1"));

    expect(toast.success).not.toHaveBeenCalled();
  });

  it("navigates to artifact route when action button clicked", () => {
    const initialActivity: ActivityResponse = {
      activities: [],
      pagination: { page: 1, pageSize: 10, total: 0 },
    };

    const { rerender } = renderHook(
      ({ activityData }) =>
        useMergeNotification(activityData, "proj-1", "team-1"),
      { initialProps: { activityData: initialActivity } }
    );

    const updatedActivity: ActivityResponse = {
      activities: [
        {
          id: "event-7",
          type: "GITHUB_PR_MERGED",
          description: "PR merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "Navigation Test",
            artifactId: "abc",
            slug: "abc",
          },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    rerender({ activityData: updatedActivity });

    // Get the onClick handler from the toast call
    const toastCall = vi.mocked(toast.success).mock.calls[0];
    const actionConfig = toastCall?.[1]?.action as
      | { label: string; onClick: (e: React.MouseEvent) => void }
      | undefined;
    const onClick = actionConfig?.onClick;

    const mockEvent = {
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;
    onClick?.(mockEvent);

    expect(mockEvent.preventDefault).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith("/implementation-plans/abc");
  });

  it("falls back to project route when slug is unavailable", () => {
    const initialActivity: ActivityResponse = {
      activities: [],
      pagination: { page: 1, pageSize: 10, total: 0 },
    };

    const { rerender } = renderHook(
      ({ activityData }) =>
        useMergeNotification(activityData, "proj-1", "team-1"),
      { initialProps: { activityData: initialActivity } }
    );

    const updatedActivity: ActivityResponse = {
      activities: [
        {
          id: "event-8",
          type: "GITHUB_PR_MERGED",
          description: "PR merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "Fallback Test",
            artifactId: "unknown",
          },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    rerender({ activityData: updatedActivity });

    const toastCall = vi.mocked(toast.success).mock.calls[0];
    const actionConfig = toastCall?.[1]?.action as
      | { label: string; onClick: (e: React.MouseEvent) => void }
      | undefined;
    const onClick = actionConfig?.onClick;
    const mockEvent = {
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;
    onClick?.(mockEvent);

    expect(mockRouterPush).toHaveBeenCalledWith(
      "/teams/team-1/projects/proj-1"
    );
  });
});
