import type { ImportGoogleDocsResponse } from "@repo/api/src/types/google";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getFriendlyError } from "../../../shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "../../../shared/api/api-timeout";
import { makeQueryClient } from "../../../shared/query/query-client";
import { createWrapperWithClient } from "../../../shared/test-utils";
import { GoogleImportModal } from "../google-import-modal";

const IMPORT_FAILURE_TITLE = "Couldn't import from Google Drive";
const VALID_FOLDER_ID = "1A2B3C4D5E6F7G8H9I0J1K2L3M4N";
const FOLDER_ID_LABEL = /google drive folder id/i;
const TARGET_PROJECT_NAME = /target project/i;
const IMPORT_BUTTON_NAME = /^import$/i;

type ToastCall = { kind: string; message: string; options?: unknown };

const { mockApiClient, toastCalls } = vi.hoisted(() => ({
  mockApiClient: { delete: vi.fn(), get: vi.fn(), post: vi.fn() },
  toastCalls: [] as ToastCall[],
}));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("../../../projects/hooks/use-projects", () => ({
  useProjects: () => ({
    data: [{ id: "proj-1", name: "Project One" }],
    isLoading: false,
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string, options?: unknown) =>
      toastCalls.push({ kind: "error", message, options }),
    success: (message: string, options?: unknown) =>
      toastCalls.push({ kind: "success", message, options }),
    warning: (message: string, options?: unknown) =>
      toastCalls.push({ kind: "warning", message, options }),
  },
}));

// Radix Select does not open its portal-rendered options under jsdom, so mock
// it as a native <select> that still drives onValueChange.
vi.mock("@repo/design-system/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    onValueChange: (v: string) => void;
    value?: string;
  }) => (
    <select
      aria-label="Target Project"
      onChange={(e) => onValueChange(e.target.value)}
      value={value ?? ""}
    >
      <option value="">Select a project</option>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

/**
 * The real import hook under the PRODUCTION client factory, so the shared
 * default `mutations.onError` is live and a second, generic toast would be
 * counted (ISS-11741 decision 3).
 */
function renderModal() {
  const client = makeQueryClient({ gcTime: 0 });
  const view = render(
    <GoogleImportModal onOpenChange={vi.fn()} open={true} />,
    { wrapper: createWrapperWithClient(client) }
  );
  return { client, view };
}

async function fillAndImport() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(FOLDER_ID_LABEL), VALID_FOLDER_ID);
  await user.selectOptions(
    screen.getByRole("combobox", { name: TARGET_PROJECT_NAME }),
    "proj-1"
  );
  await user.click(screen.getByRole("button", { name: IMPORT_BUTTON_NAME }));
}

function pendingRequest() {
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

/** An `ApiError` shaped as the API client builds it from a `{ error }` body. */
function serverRejection(status: number, message: string) {
  return new ApiError(message, status, {
    data: { error: message, success: false },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  toastCalls.length = 0;
});

describe("GoogleImportModal failure toast", () => {
  it("toasts a failed import exactly once, with the error message as the description", async () => {
    mockApiClient.post.mockRejectedValue(
      serverRejection(404, "Drive folder not found")
    );
    const { client } = renderModal();

    await fillAndImport();

    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(toastCalls).toEqual([
      {
        kind: "error",
        message: IMPORT_FAILURE_TITLE,
        options: { description: "Drive folder not found" },
      },
    ]);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/integrations/google/import",
      { folderId: VALID_FOLDER_ID, projectId: "proj-1" },
      expect.anything()
    );
  });

  it("omits the description when the server sent no message", async () => {
    // What the API client throws for a failed response with no `error` field:
    // its own fallback message, which is not the server's.
    mockApiClient.post.mockRejectedValue(
      new ApiError("API request failed", 500, { data: { success: false } })
    );
    const { client } = renderModal();

    await fillAndImport();

    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(toastCalls).toEqual([
      { kind: "error", message: IMPORT_FAILURE_TITLE, options: undefined },
    ]);
  });

  it("keeps the shared timeout copy when the client stopped waiting", async () => {
    // ISS-11741, Daveth's ruling on PR 8262: the import creates documents as
    // it goes, so a client deadline must not read as a failed import; it keeps
    // ISS-5013's "we stopped waiting" toast instead of the fixed title.
    const timeout = new ApiError(
      API_TIMEOUT_ERROR_MESSAGE,
      API_NO_RESPONSE_STATUS,
      { code: API_TIMEOUT_ERROR_CODE }
    );
    mockApiClient.post.mockRejectedValue(timeout);
    const { client } = renderModal();

    await fillAndImport();

    await waitFor(() => expect(client.isMutating()).toBe(0));
    const friendly = getFriendlyError(timeout);
    expect(toastCalls).toEqual([
      {
        kind: "error",
        message: friendly.title,
        options: { description: friendly.description },
      },
    ]);
  });

  it("still toasts exactly once when the import fails after the dialog closed", async () => {
    const request = pendingRequest();
    mockApiClient.post.mockReturnValue(request.promise);
    const { client, view } = renderModal();

    await fillAndImport();
    await waitFor(() => expect(client.isMutating()).toBe(1));
    // Closing runs the modal's reset effect (`importMutation.reset()`), which
    // drops any per-call callback but not the hook-level `onError`.
    view.rerender(<GoogleImportModal onOpenChange={vi.fn()} open={false} />);
    request.reject(serverRejection(429, "Drive quota exceeded"));

    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(toastCalls).toEqual([
      {
        kind: "error",
        message: IMPORT_FAILURE_TITLE,
        options: { description: "Drive quota exceeded" },
      },
    ]);
  });

  it("keeps the success toast unchanged", async () => {
    const response: ImportGoogleDocsResponse = {
      importedCount: 1,
      totalDocsInFolder: 1,
      artifacts: [{ id: "doc-1", slug: "PRD-1", title: "Alpha Doc" }],
      failures: [],
    };
    mockApiClient.post.mockResolvedValue(response);
    const { client } = renderModal();

    await fillAndImport();

    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(toastCalls).toEqual([
      {
        kind: "success",
        message: "Successfully imported 1 document",
        options: undefined,
      },
    ]);
  });
});
