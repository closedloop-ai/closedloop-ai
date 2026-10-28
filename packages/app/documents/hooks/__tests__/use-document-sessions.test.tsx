import { createWrapper } from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentSessions } from "../use-document-sessions";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.get }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useDocumentSessions", () => {
  it("reads the document-scoped endpoint", async () => {
    mocks.get.mockResolvedValue({ detail: {}, trace: {} });
    const { result } = renderHook(() => useDocumentSessions("document-a"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.get).toHaveBeenCalledWith("/documents/document-a/sessions");
  });

  it("does not carry one document's session data to another", async () => {
    mocks.get.mockImplementation((path: string) => Promise.resolve({ path }));
    const { result, rerender } = renderHook(
      ({ id }) => useDocumentSessions(id),
      { initialProps: { id: "document-a" }, wrapper: createWrapper() }
    );
    await waitFor(() =>
      expect(result.current.data).toEqual({
        path: "/documents/document-a/sessions",
      })
    );
    rerender({ id: "document-b" });
    await waitFor(() =>
      expect(result.current.data).toEqual({
        path: "/documents/document-b/sessions",
      })
    );
  });
});
