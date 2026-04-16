import type { ActivityResponse } from "@repo/api/src/types/activity";
import { toast } from "@repo/design-system/components/ui/sonner";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMergeNotification } from "./use-merge-notification";

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueries: vi.fn(() => []),
  };
});

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: vi.fn(() => ({
    get: vi.fn(),
  })),
}));

vi.mock("@/hooks/queries/use-documents", () => ({
  documentKeys: {
    previewDeployment: (id: string) => [
      "documents",
      "detail",
      id,
      "preview-deployment",
    ],
  },
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
  },
}));

// Import after mocks — vi.mock is hoisted, so this gets the mocked version
import { useQueries } from "@tanstack/react-query";

describe("useMergeNotification", () => {
  const mockWindowOpen = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock window.open
    window.open = mockWindowOpen;
    // Mock useQueries to return empty array by default (no preview deployments)
    vi.mocked(useQueries).mockReturnValue([]);
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
            documentId: "abc",
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
          metadata: { prTitle: "Old PR", documentId: "abc" },
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
            documentId: "xyz",
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
          metadata: { documentId: "abc" },
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
          metadata: { prTitle: "Duplicate PR", documentId: "abc" },
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
          metadata: { prTitle: "New PR", documentId: "abc" },
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

  it("opens artifact route in new tab when action button clicked (no preview deployment)", () => {
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
            documentId: "abc",
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
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/implementation-plans/abc",
      "_blank"
    );
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
            documentId: "unknown",
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

    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/teams/team-1/projects/proj-1",
      "_blank"
    );
  });

  it("shows preview deployment URL when available", () => {
    vi.mocked(useQueries).mockReturnValue([
      {
        data: {
          id: "link-1",
          organizationId: "org-1",
          workstreamId: "ws-1",
          projectId: null,
          type: "PREVIEW_DEPLOYMENT",
          title: "Preview Deployment",
          externalUrl: "https://preview.example.com",
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        isLoading: false,
        error: null,
      },
    ]);

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
          id: "event-9",
          type: "GITHUB_PR_MERGED",
          description: "PR merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "Preview Test",
            documentId: "abc",
            slug: "abc",
          },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    };

    rerender({ activityData: updatedActivity });

    expect(toast.success).toHaveBeenCalledWith("Preview Test", {
      description: "Preview deployment: https://preview.example.com",
      action: {
        label: "View Preview",
        onClick: expect.any(Function),
      },
    });
  });

  it("opens preview deployment URL in new tab when action button clicked", () => {
    vi.mocked(useQueries).mockReturnValue([
      {
        data: {
          id: "link-1",
          organizationId: "org-1",
          workstreamId: "ws-1",
          projectId: null,
          type: "PREVIEW_DEPLOYMENT",
          title: "Preview Deployment",
          externalUrl: "https://preview.example.com",
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        isLoading: false,
        error: null,
      },
    ]);

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
          id: "event-10",
          type: "GITHUB_PR_MERGED",
          description: "PR merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "Preview URL Test",
            documentId: "abc",
            slug: "abc",
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

    expect(mockEvent.preventDefault).toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "https://preview.example.com",
      "_blank"
    );
  });

  it("fetches preview deployments for multiple merge events simultaneously", () => {
    vi.mocked(useQueries).mockReturnValue([
      {
        data: {
          id: "link-1",
          organizationId: "org-1",
          workstreamId: "ws-1",
          projectId: null,
          type: "PREVIEW_DEPLOYMENT",
          title: "Preview Deployment 1",
          externalUrl: "https://preview1.example.com",
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        isLoading: false,
        error: null,
      },
      {
        data: {
          id: "link-2",
          organizationId: "org-1",
          workstreamId: "ws-1",
          projectId: null,
          type: "PREVIEW_DEPLOYMENT",
          title: "Preview Deployment 2",
          externalUrl: "https://preview2.example.com",
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        isLoading: false,
        error: null,
      },
    ]);

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
          id: "event-11",
          type: "GITHUB_PR_MERGED",
          description: "First PR merged",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          metadata: {
            prTitle: "First PR",
            documentId: "artifact-1",
            slug: "artifact-1",
          },
          actor: undefined,
        },
        {
          id: "event-12",
          type: "GITHUB_PR_MERGED",
          description: "Second PR merged",
          timestamp: new Date("2024-01-15T10:05:00Z"),
          metadata: {
            prTitle: "Second PR",
            documentId: "artifact-2",
            slug: "artifact-2",
          },
          actor: undefined,
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 2 },
    };

    rerender({ activityData: updatedActivity });

    // Both toasts should be created
    expect(toast.success).toHaveBeenCalledTimes(2);

    // First toast should have first preview deployment
    expect(toast.success).toHaveBeenCalledWith("First PR", {
      description: "Preview deployment: https://preview1.example.com",
      action: {
        label: "View Preview",
        onClick: expect.any(Function),
      },
    });

    // Second toast should have second preview deployment
    expect(toast.success).toHaveBeenCalledWith("Second PR", {
      description: "Preview deployment: https://preview2.example.com",
      action: {
        label: "View Preview",
        onClick: expect.any(Function),
      },
    });
  });
});
