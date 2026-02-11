import type { ActivityResponse } from "@repo/api/src/types/activity";
import { toast } from "@repo/design-system/components/ui/sonner";
import { renderHook } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMergeNotification } from "./use-merge-notification";

// Mock functions need to be created in the factory to avoid hoisting issues
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
  },
}));

vi.mock("@/lib/artifact-navigation", () => ({
  getArtifactRoute: vi.fn((artifact: { documentSlug: string }) => {
    if (artifact.documentSlug === "abc") {
      return "/implementation-plans/abc";
    }
    return null;
  }),
}));

describe("useMergeNotification", () => {
  const mockRouterPush = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({ push: mockRouterPush } as any);
  });

  it("triggers toast on new GITHUB_PR_MERGED event", () => {
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

    expect(toast.success).toHaveBeenCalledWith("Test PR", {
      description: "Pull request has been merged",
      action: {
        label: "View Artifact",
        onClick: expect.any(Function),
      },
    });
  });

  it("uses fallback title when prTitle is missing", () => {
    const mockActivity: ActivityResponse = {
      activities: [
        {
          id: "event-2",
          type: "GITHUB_PR_MERGED",
          description: "Pull request merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            artifactId: "abc",
            prUrl: "https://github.com/org/repo/pull/2",
          },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    renderHook(() => useMergeNotification(mockActivity, "proj-1", "team-1"));

    expect(toast.success).toHaveBeenCalledWith("Pull request merged", {
      description: "Pull request has been merged",
      action: {
        label: "View Artifact",
        onClick: expect.any(Function),
      },
    });
  });

  it("prevents duplicate toasts for same event", () => {
    const mockActivity: ActivityResponse = {
      activities: [
        {
          id: "event-3",
          type: "GITHUB_PR_MERGED",
          description: "Pull request merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "Duplicate PR",
            artifactId: "abc",
          },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    const { rerender } = renderHook(() =>
      useMergeNotification(mockActivity, "proj-1", "team-1")
    );

    expect(toast.success).toHaveBeenCalledTimes(1);

    // Re-render with same activity data
    rerender();

    // Should still only be called once (duplicate prevention)
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("shows toast for new event after initial render", () => {
    const initialActivity: ActivityResponse = {
      activities: [
        {
          id: "event-4",
          type: "GITHUB_PR_MERGED",
          description: "First PR merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "First PR",
            artifactId: "abc",
          },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    const { rerender } = renderHook(
      ({ activityData }) =>
        useMergeNotification(activityData, "proj-1", "team-1"),
      {
        initialProps: { activityData: initialActivity },
      }
    );

    expect(toast.success).toHaveBeenCalledTimes(1);

    // Add a new event
    const updatedActivity: ActivityResponse = {
      activities: [
        {
          id: "event-5",
          type: "GITHUB_PR_MERGED",
          description: "Second PR merged",
          timestamp: new Date("2024-01-15T11:00:00Z"),
          metadata: {
            prTitle: "Second PR",
            artifactId: "xyz",
          },
          actor: undefined,
        },
        ...initialActivity.activities,
      ],
      pagination: { page: 1, pageSize: 10, total: 2 },
    };

    rerender({ activityData: updatedActivity });

    // Should be called twice total (once for each unique event)
    expect(toast.success).toHaveBeenCalledTimes(2);
  });

  it("ignores non-GITHUB_PR_MERGED events", () => {
    const mockActivity: ActivityResponse = {
      activities: [
        {
          id: "event-6",
          type: "GITHUB_PR_CREATED",
          description: "Pull request created",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "New PR",
            artifactId: "abc",
          },
          actor: undefined,
        },
        {
          id: "event-7",
          type: "GITHUB_ACTION_COMPLETED",
          description: "Action completed",
          timestamp: new Date("2024-01-15T10:05:00Z"),
          metadata: {},
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 2 },
    };

    renderHook(() => useMergeNotification(mockActivity, "proj-1", "team-1"));

    expect(toast.success).not.toHaveBeenCalled();
  });

  it("handles undefined activityData gracefully", () => {
    renderHook(() => useMergeNotification(undefined, "proj-1", "team-1"));

    expect(toast.success).not.toHaveBeenCalled();
  });

  it("navigates to artifact route when action button clicked", () => {
    const mockActivity: ActivityResponse = {
      activities: [
        {
          id: "event-8",
          type: "GITHUB_PR_MERGED",
          description: "PR merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "Navigation Test",
            artifactId: "abc",
            documentSlug: "abc",
          },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    renderHook(() => useMergeNotification(mockActivity, "proj-1", "team-1"));

    // Get the onClick handler from the toast call
    const toastCall = vi.mocked(toast.success).mock.calls[0];
    const actionConfig = toastCall?.[1]?.action as
      | { label: string; onClick: (e: React.MouseEvent) => void }
      | undefined;
    const onClick = actionConfig?.onClick;

    // Simulate clicking the action button
    const mockEvent = {
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;
    onClick?.(mockEvent);

    expect(mockEvent.preventDefault).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith("/implementation-plans/abc");
  });

  it("falls back to project route when artifact route is unavailable", () => {
    const mockActivity: ActivityResponse = {
      activities: [
        {
          id: "event-9",
          type: "GITHUB_PR_MERGED",
          description: "PR merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "Fallback Test",
            artifactId: "unknown", // No route defined for this ID
          },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    renderHook(() => useMergeNotification(mockActivity, "proj-1", "team-1"));

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
