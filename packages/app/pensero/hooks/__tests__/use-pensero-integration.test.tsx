/**
 * ISS-8007 / #6030 — the Pensero credential mutations opt out of the shared
 * QueryClient's default error toast.
 *
 * The card reports failures itself, deliberately: the server's own sentence
 * ("must be an absolute https:// URL with no query string, fragment, or
 * embedded username/password") is the actionable one, and `getFriendlyError`
 * replaces it with generic copy. Without the opt-out an admin gets BOTH toasts
 * for one failure, which is what whitlockk and codex flagged.
 *
 * Every case runs against a real `makeQueryClient()` — the same factory the web
 * shell builds its client from — so the default handler these hooks are opting
 * out of is genuinely installed. A hand-rolled `new QueryClient()` has no
 * default `mutations.onError` at all, and every assertion below would pass
 * against a hook that had never set the flag.
 */

import { PENSERO_INTEGRATION_PATH } from "@repo/api/src/types/pensero-integration";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useRemovePenseroCredential,
  useSetPenseroCredential,
} from "../use-pensero-integration";

const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mockToastError,
    info: vi.fn(),
    success: vi.fn(),
  },
}));

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const TOKEN = "tk_public:sk_secret";
const REJECTION = "Pensero token must look like tk_<public>:sk_<secret>";

function withSharedQueryClient() {
  const queryClient = makeQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSetPenseroCredential", () => {
  it("writes to the shared credential path", async () => {
    mockApiClient.put.mockResolvedValue({
      baseUrl: null,
      isSet: true,
      lastFour: "cret",
      setAt: "2026-01-01T00:00:00.000Z",
    });

    const { result } = renderHook(() => useSetPenseroCredential(), {
      wrapper: withSharedQueryClient(),
    });

    act(() => {
      result.current.mutate({ baseUrl: null, token: TOKEN });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith(PENSERO_INTEGRATION_PATH, {
      baseUrl: null,
      token: TOKEN,
    });
  });

  it("leaves the failure toast to the card instead of adding a second one", async () => {
    mockApiClient.put.mockRejectedValue(new Error(REJECTION));

    const { result } = renderHook(() => useSetPenseroCredential(), {
      wrapper: withSharedQueryClient(),
    });

    act(() => {
      result.current.mutate({ baseUrl: null, token: TOKEN });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).not.toHaveBeenCalled();
    // The rejection still reaches the caller, which is what lets the card show
    // the server's own message. Suppressing the toast must not swallow the error.
    expect((result.current.error as Error).message).toBe(REJECTION);
  });
});

describe("useRemovePenseroCredential", () => {
  it("deletes through the shared credential path", async () => {
    mockApiClient.delete.mockResolvedValue({ deleted: true });

    const { result } = renderHook(() => useRemovePenseroCredential(), {
      wrapper: withSharedQueryClient(),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.delete).toHaveBeenCalledWith(PENSERO_INTEGRATION_PATH);
  });

  it("leaves the failure toast to the card instead of adding a second one", async () => {
    mockApiClient.delete.mockRejectedValue(new Error(REJECTION));

    const { result } = renderHook(() => useRemovePenseroCredential(), {
      wrapper: withSharedQueryClient(),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).not.toHaveBeenCalled();
  });
});

/**
 * The control that makes the two `not.toHaveBeenCalled()` assertions above mean
 * something. It drives a mutation with NO meta through the same client, the same
 * toast mock, and the same rejection: if the default handler were not installed
 * — a broken mock, a changed factory — this would go red and the suppression
 * cases would be exposed as vacuous rather than staying green.
 */
describe("the default handler this opts out of", () => {
  it("toasts a rejected mutation that has not set the flag", async () => {
    const client = makeQueryClient();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => Promise.reject(new Error(REJECTION)),
    });

    await mutation.execute(undefined).catch(() => undefined);

    expect(mockToastError).toHaveBeenCalledOnce();
  });
});
