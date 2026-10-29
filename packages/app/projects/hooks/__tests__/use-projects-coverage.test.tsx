import { Priority } from "@repo/api/src/types/common";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import {
  useCreateProject,
  useProject,
  useProjectStatusHandler,
  useProjects,
  useProjectsByTeam,
  useUpdateProject,
  useUpdateProjectTargetDate,
} from "@repo/app/projects/hooks/use-projects";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mocks.apiClient,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiClient.get.mockResolvedValue([]);
});

describe("project query and mutation hooks", () => {
  test("normalizes list filters into stable query strings", async () => {
    const wrapper = createWrapperWithClient(createTestQueryClient());
    const unfiltered = renderHook(() => useProjects(), { wrapper });
    const filtered = renderHook(
      () =>
        useProjects("team-1", undefined, {
          status: [ProjectStatus.InProgress, ProjectStatus.InProgress],
          excludeStatus: [ProjectStatus.Archived, ProjectStatus.Completed],
        }),
      { wrapper }
    );
    const byTeam = renderHook(
      () => useProjectsByTeam("team-2", undefined, { status: [] }),
      { wrapper }
    );
    const disabledTeam = renderHook(() => useProjectsByTeam(""), { wrapper });
    const disabledDetail = renderHook(() => useProject(""), { wrapper });

    await waitFor(() => expect(unfiltered.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(filtered.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(byTeam.result.current.isSuccess).toBe(true));
    expect(mocks.apiClient.get).toHaveBeenCalledWith("/projects");
    expect(mocks.apiClient.get).toHaveBeenCalledWith(
      "/projects?teamId=team-1&status=IN_PROGRESS&excludeStatus=ARCHIVED%2CCOMPLETED"
    );
    expect(mocks.apiClient.get).toHaveBeenCalledWith("/projects?teamId=team-2");
    expect(disabledTeam.result.current.fetchStatus).toBe("idle");
    expect(disabledDetail.result.current.fetchStatus).toBe("idle");
    expect(mocks.apiClient.get).toHaveBeenCalledTimes(3);
  });

  test("serializes optional create dates and invalidates a returned team", async () => {
    const project = makeProject();
    mocks.apiClient.post.mockResolvedValue(project);
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateProject(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await act(() =>
      result.current.mutateAsync({
        name: "New",
        teamIds: ["team-1"],
        targetDate: new Date("2026-09-01T00:00:00Z"),
      })
    );
    expect(mocks.apiClient.post).toHaveBeenCalledWith("/projects", {
      name: "New",
      teamIds: ["team-1"],
      targetDate: "2026-09-01T00:00:00.000Z",
    });
    expect(invalidate.mock.calls.map(([options]) => options)).toEqual([
      { queryKey: projectKeys.lists() },
      { queryKey: projectKeys.recent("team-1") },
    ]);

    mocks.apiClient.post.mockResolvedValue(makeProject({ teams: [] }));
    await act(() =>
      result.current.mutateAsync({ name: "No date", teamIds: ["team-1"] })
    );
    expect(mocks.apiClient.post).toHaveBeenLastCalledWith("/projects", {
      name: "No date",
      teamIds: ["team-1"],
      targetDate: undefined,
    });
    expect(invalidate.mock.calls.map(([options]) => options)).toEqual([
      { queryKey: projectKeys.lists() },
      { queryKey: projectKeys.recent("team-1") },
      { queryKey: projectKeys.lists() },
    ]);
  });

  test("serializes nullable update dates and invalidates optional identities", async () => {
    mocks.apiClient.put.mockResolvedValue(makeProject());
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useUpdateProject(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await act(() =>
      result.current.mutateAsync({
        id: "project-1",
        name: "Updated",
        targetDate: null,
        lastIndexedAt: new Date("2026-08-20T00:00:00Z"),
      })
    );
    // Pins current behavior; looks odd because null becomes undefined and may
    // be omitted by JSON serialization instead of clearing the server date.
    expect(mocks.apiClient.put).toHaveBeenCalledWith("/projects/project-1", {
      name: "Updated",
      targetDate: undefined,
      lastIndexedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(invalidate.mock.calls.map(([options]) => options)).toEqual([
      { queryKey: projectKeys.lists() },
      { queryKey: projectKeys.detail("project-1") },
      { queryKey: projectKeys.bySlug("project") },
      { queryKey: projectKeys.recent("team-1") },
    ]);

    mocks.apiClient.put.mockResolvedValue(
      makeProject({ slug: null, teams: [] })
    );
    await act(() => result.current.mutateAsync({ id: "project-1" }));
    expect(mocks.apiClient.put).toHaveBeenLastCalledWith(
      "/projects/project-1",
      {}
    );
    expect(invalidate.mock.calls.map(([options]) => options)).toEqual([
      { queryKey: projectKeys.lists() },
      { queryKey: projectKeys.detail("project-1") },
      { queryKey: projectKeys.bySlug("project") },
      { queryKey: projectKeys.recent("team-1") },
      { queryKey: projectKeys.lists() },
      { queryKey: projectKeys.detail("project-1") },
    ]);
  });

  // ISS-11198: a write refused as stale re-reads the project, so the inline
  // field is handed the value that beat it instead of retrying a stale guard.
  test("re-reads the project when the write is refused", async () => {
    mocks.apiClient.put.mockRejectedValue(new Error("stale_project_name"));
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useUpdateProject(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await act(() =>
      result.current
        .mutateAsync({ id: "project-1", name: "B", expectedName: "A" })
        .catch(() => undefined)
    );

    expect(invalidate.mock.calls.map(([options]) => options)).toEqual([
      { queryKey: projectKeys.lists() },
      { queryKey: projectKeys.detail("project-1") },
    ]);
    expect(mocks.toastError).toHaveBeenCalledOnce();
  });

  test("toasts nothing for a refusal whose field still owns its feedback", async () => {
    mocks.apiClient.put.mockRejectedValue(new Error("refused"));
    const queryClient = createTestQueryClient();
    const { result } = renderHook(() => useUpdateProject(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await act(() =>
      result.current
        .mutateAsync({
          id: "project-1",
          name: "Updated",
          recoverableErrorOwner: () => true,
        })
        .catch(() => undefined)
    );

    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  test("toasts a target-date refusal once, from the inner update only", async () => {
    mocks.apiClient.put.mockRejectedValue(new Error("refused"));
    const queryClient = createTestQueryClient();
    const { result } = renderHook(() => useUpdateProjectTargetDate(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await act(() =>
      result.current
        .mutateAsync({
          projectId: "project-1",
          targetDate: new Date("2026-10-22T00:00:00Z"),
        })
        .catch(() => undefined)
    );

    expect(mocks.toastError).toHaveBeenCalledOnce();
  });

  test("restores the shared toast when a target-date feedback owner unmounts", async () => {
    mocks.apiClient.put.mockRejectedValue(new Error("refused"));
    const queryClient = createTestQueryClient();
    const { result } = renderHook(() => useUpdateProjectTargetDate(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await act(() =>
      result.current
        .mutateAsync({
          projectId: "project-1",
          recoverableErrorOwner: () => false,
          targetDate: new Date("2026-10-22T00:00:00Z"),
        })
        .catch(() => undefined)
    );

    expect(mocks.toastError).toHaveBeenCalledOnce();
  });
});

describe("project status handler", () => {
  test("archives with an undo action and calls the archive callback", async () => {
    mocks.apiClient.put.mockResolvedValue(makeProject());
    const onArchived = vi.fn();
    const { result } = renderHook(
      () => useProjectStatusHandler({ onArchived }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );
    act(() =>
      result.current.handleUpdateStatus(
        "project-1",
        ProjectStatus.Archived,
        ProjectStatus.InProgress
      )
    );

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Project archived",
        expect.objectContaining({ action: expect.any(Object) })
      )
    );
    expect(onArchived).toHaveBeenCalledWith("project-1");
    const options = mocks.toastSuccess.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    act(() => options.action.onClick());
    await waitFor(() => expect(mocks.apiClient.put).toHaveBeenCalledTimes(2));
    expect(mocks.apiClient.put).toHaveBeenLastCalledWith(
      "/projects/project-1",
      { status: ProjectStatus.InProgress }
    );
  });

  test("unarchives with optional undo or a plain success message", async () => {
    mocks.apiClient.put.mockResolvedValue(makeProject());
    const wrapper = createWrapperWithClient(createTestQueryClient());
    const withUndo = renderHook(
      () => useProjectStatusHandler({ showUndoOnUnarchive: true }),
      { wrapper }
    );
    act(() =>
      withUndo.result.current.handleUpdateStatus(
        "project-1",
        ProjectStatus.InProgress,
        ProjectStatus.Archived
      )
    );
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Project unarchived",
        expect.objectContaining({ action: expect.any(Object) })
      )
    );

    mocks.toastSuccess.mockClear();
    const plain = renderHook(() => useProjectStatusHandler(), { wrapper });
    act(() =>
      plain.result.current.handleUpdateStatus(
        "project-2",
        ProjectStatus.InProgress,
        ProjectStatus.Archived
      )
    );
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Project unarchived")
    );
  });
});

function makeProject(
  overrides: Partial<ProjectWithDetails> = {}
): ProjectWithDetails {
  const now = new Date("2026-08-20T00:00:00Z");
  return {
    id: "project-1",
    organizationId: "org-1",
    name: "Project",
    description: null,
    priority: Priority.Medium,
    status: ProjectStatus.InProgress,
    assigneeId: null,
    createdById: "user-1",
    slug: "project",
    targetDate: null,
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
    completionPercentage: 0,
    teams: [{ id: "team-1", name: "Team" }],
    ...overrides,
  };
}
