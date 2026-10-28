import { LinkType } from "@repo/api/src/types/artifact";
import {
  DOCUMENT_ROUTE_PREFIX,
  DocumentType,
} from "@repo/api/src/types/document";
import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateIssueModal } from "../create-issue-modal";

const LINK_SUMMARY_TOAST =
  "Issue created, but some relationships failed to save.";
const ARTIFACT_TITLES = ["Alpha PRD", "Beta PRD", "Gamma PRD"];

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockNavigate = vi.fn();
const mockCreateDocumentMutate = vi.fn();
const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
};
const toastCalls: { kind: string; message: string }[] = [];

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ kind: "error", message }),
    success: (message: string) => toastCalls.push({ kind: "success", message }),
  },
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    replace: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => ({
    data: [{ id: "project-1", name: "Project One" }],
    isLoading: false,
  }),
}));

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeamMembers: () => ({ data: [], isLoading: false }),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [], isLoading: false }),
}));

// Issue creation is stubbed to succeed; `useCreateArtifactLink` stays real so
// the production client's default `mutations.onError` is live and a generic
// per-link toast would be counted (ISS-11741 decision 2).
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocumentsByProject: () => ({
    data: ARTIFACT_TITLES.map((title, index) =>
      createMockDocument({ id: `doc-${index + 1}`, title })
    ),
    isLoading: false,
  }),
  useCreateDocument: () => ({
    mutate: mockCreateDocumentMutate,
    isPending: false,
  }),
}));

function renderModal() {
  const client = makeQueryClient({ gcTime: 0 });
  const view = render(
    <CreateIssueModal
      onOpenChange={vi.fn()}
      open={true}
      projectId="project-1"
      teamId="team-1"
    />,
    { wrapper: createWrapperWithClient(client) }
  );
  return { client, unmount: view.unmount };
}

async function fillAndSelectAllArtifacts() {
  fireEvent.change(screen.getByPlaceholderText("Issue Title"), {
    target: { value: "Fix the thing" },
  });
  for (const title of ARTIFACT_TITLES) {
    screen.getByText("Select additional context...").click();
    await waitFor(() => {
      screen.getByText(title).click();
    });
    await screen.findAllByText(title);
  }
}

function pendingRequest() {
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

function linkRequestFor(sourceId: string) {
  return mockApiClient.post.mock.calls.find(
    ([path, body]) => path === "/artifact-links" && body.sourceId === sourceId
  );
}

describe("CreateIssueModal relationship link failure toasts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastCalls.length = 0;
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    mockCreateDocumentMutate.mockReset();
    mockCreateDocumentMutate.mockImplementation((_input, handlers) => {
      handlers?.onSuccess?.(
        createMockDocument({
          id: "issue-1",
          slug: "new-issue",
          type: DocumentType.Feature,
        })
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the summary exactly once when several links fail, and still navigates", async () => {
    mockApiClient.post.mockImplementation((_path, body) =>
      body.sourceId === "doc-2"
        ? Promise.resolve({ id: "link-2" })
        : Promise.reject(new ApiError("boom", 500))
    );
    const { client } = renderModal();
    await fillAndSelectAllArtifacts();

    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        `/acme/${DOCUMENT_ROUTE_PREFIX}/new-issue`
      )
    );
    // A mutation leaves `isMutating` only after its `onError` has run, so this
    // waits for every link's toast, not just the first rejection.
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(mockApiClient.post).toHaveBeenCalledTimes(3);
    for (const sourceId of ["doc-1", "doc-2", "doc-3"]) {
      expect(linkRequestFor(sourceId)?.[1]).toEqual({
        sourceId,
        targetId: "issue-1",
        linkType: LinkType.Produces,
      });
    }
    expect(toastCalls).toEqual([
      { kind: "error", message: LINK_SUMMARY_TOAST },
    ]);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it("adds no toast for a link that fails after the modal has navigated away", async () => {
    const late = pendingRequest();
    mockApiClient.post.mockImplementation((_path, body) => {
      if (body.sourceId === "doc-1") {
        return Promise.reject(new ApiError("boom", 500));
      }
      if (body.sourceId === "doc-3") {
        return late.promise;
      }
      return Promise.resolve({ id: "link-2" });
    });
    const { client, unmount } = renderModal();
    await fillAndSelectAllArtifacts();

    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        `/acme/${DOCUMENT_ROUTE_PREFIX}/new-issue`
      )
    );
    unmount();
    late.reject(new ApiError("late boom", 500));

    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(toastCalls).toEqual([
      { kind: "error", message: LINK_SUMMARY_TOAST },
    ]);
  });

  it("adds no toast when an earlier issue's link fails after a second issue was created", async () => {
    const late = pendingRequest();
    mockCreateDocumentMutate
      .mockImplementationOnce((_input, handlers) => {
        handlers?.onSuccess?.(
          createMockDocument({
            id: "issue-1",
            slug: "new-issue",
            type: DocumentType.Feature,
          })
        );
      })
      .mockImplementationOnce((_input, handlers) => {
        handlers?.onSuccess?.(
          createMockDocument({
            id: "issue-2",
            slug: "second-issue",
            type: DocumentType.Feature,
          })
        );
      });
    mockApiClient.post.mockImplementation((_path, body) => {
      if (body.targetId === "issue-2") {
        return Promise.resolve({ id: "link-b" });
      }
      // The pending link is not the last one started, so the last link's
      // success leaves the modal's shared observer idle and a second submit
      // can start while this request is still in flight.
      if (body.sourceId === "doc-1") {
        return late.promise;
      }
      if (body.sourceId === "doc-2") {
        return Promise.reject(new ApiError("boom", 500));
      }
      return Promise.resolve({ id: "link-3" });
    });
    const { client } = renderModal();
    await fillAndSelectAllArtifacts();
    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        `/acme/${DOCUMENT_ROUTE_PREFIX}/new-issue`
      )
    );

    // The modal reset its form on close; the second issue's links all save.
    await fillAndSelectAllArtifacts();
    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        `/acme/${DOCUMENT_ROUTE_PREFIX}/second-issue`
      )
    );
    late.reject(new ApiError("late boom", 500));

    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(toastCalls).toEqual([
      { kind: "error", message: LINK_SUMMARY_TOAST },
    ]);
  });

  it("shows no toast when every link saves", async () => {
    mockApiClient.post.mockResolvedValue({ id: "link" });
    const { client } = renderModal();
    await fillAndSelectAllArtifacts();

    fireEvent.click(screen.getByRole("button", { name: "Create Issue" }));

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        `/acme/${DOCUMENT_ROUTE_PREFIX}/new-issue`
      )
    );
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(mockApiClient.post).toHaveBeenCalledTimes(3);
    expect(toastCalls).toEqual([]);
  });
});
