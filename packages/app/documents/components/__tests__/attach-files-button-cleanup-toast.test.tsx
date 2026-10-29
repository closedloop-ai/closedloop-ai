import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachFilesButton } from "../attach-files-button";

const { mockApiClient, mockUploadToS3, toastCalls } = vi.hoisted(() => ({
  mockApiClient: { delete: vi.fn(), get: vi.fn(), post: vi.fn() },
  mockUploadToS3: vi.fn(),
  toastCalls: [] as { kind: string; message: string }[],
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/app/shared/lib/s3-upload", () => ({
  uploadToS3: (...args: unknown[]) => mockUploadToS3(...args),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ kind: "error", message }),
    success: (message: string) => toastCalls.push({ kind: "success", message }),
  },
}));

/**
 * The real attachment hooks under the PRODUCTION client factory, so the
 * shared default `mutations.onError` is live and a toast for the cleanup
 * delete would be counted (ISS-11741 decision 4).
 */
function renderAndPickFile() {
  const client = makeQueryClient({ gcTime: 0 });
  const { container } = render(<AttachFilesButton documentId="document-1" />, {
    wrapper: createWrapperWithClient(client),
  });
  const input = container.querySelector(
    'input[type="file"]'
  ) as HTMLInputElement;
  const file = new File(["x"], "report.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
  return { client };
}

beforeEach(() => {
  vi.clearAllMocks();
  toastCalls.length = 0;
  mockApiClient.post.mockResolvedValue({
    attachmentId: "attachment-1",
    uploadUrl: "https://s3.example.test/upload",
  });
});

describe("AttachFilesButton cleanup after a failed upload", () => {
  it("shows only the upload failure when the cleanup delete also fails", async () => {
    mockUploadToS3.mockRejectedValue(new Error("Upload failed: 503"));
    mockApiClient.delete.mockRejectedValue(new ApiError("boom", 500));
    const { client } = renderAndPickFile();

    await waitFor(() =>
      expect(mockApiClient.delete).toHaveBeenCalledWith(
        "/documents/document-1/attachments/attachment-1"
      )
    );
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(toastCalls).toEqual([
      { kind: "error", message: "Upload failed: 503" },
    ]);
  });

  it("shows only the upload failure when the cleanup delete succeeds", async () => {
    mockUploadToS3.mockRejectedValue(new Error("Upload failed: 503"));
    mockApiClient.delete.mockResolvedValue({ deleted: true });
    const { client } = renderAndPickFile();

    await waitFor(() => expect(mockApiClient.delete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(toastCalls).toEqual([
      { kind: "error", message: "Upload failed: 503" },
    ]);
  });
});
