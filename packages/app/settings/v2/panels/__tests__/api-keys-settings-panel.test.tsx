import { type ApiKey, ApiKeyScope } from "@repo/api/src/types/api-key";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../shared/api/api-error";
import { makeQueryClient } from "../../../../shared/query/query-client";
import { createWrapperWithClient } from "../../../../shared/test-utils";
import { ApiKeysSettingsPanel } from "../api-keys-settings-panel";

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
};

const toastCalls: { kind: string; message: string }[] = [];

vi.mock("../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// The third-party credential cards read their own endpoints and the Settings
// view model; their behavior is covered in `api-keys/__tests__`. Stubbed here
// so every `get` and toast count below is the platform-keys table's alone.
vi.mock("../api-keys/api-keys-credential-cards", () => ({
  ApiKeysCredentialCards: () => <div data-testid="api-keys-credential-cards" />,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ kind: "error", message }),
    success: (message: string) => toastCalls.push({ kind: "success", message }),
  },
}));

// A value shaped like a real minted key so a leak into any sink is detectable,
// without ever being asserted with a containment matcher — Vitest renders the
// received value into the reporter on failure, which would publish the secret
// into stdout and the JSON report. Every check below compares booleans.
const MINTED_SECRET = "sk_live_testonlyf00dfacecafebabe0123456789abcdef";

function activeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: null,
    id: "key-1",
    keyPrefix: "sk_live_",
    lastUsedAt: null,
    name: "CI pipeline",
    organizationId: "org-1",
    revokedAt: null,
    scopes: [ApiKeyScope.Read, ApiKeyScope.Write, ApiKeyScope.Delete],
    userId: "user-1",
    ...overrides,
  };
}

/**
 * The PRODUCTION client factory, not a bare `QueryClient` (#6392, codex P1).
 *
 * `makeQueryClient` installs the default `mutations.onError` that toasts every
 * rejected mutation, and that handler runs BEFORE `mutateAsync` rejects into
 * the panel's `catch`. A bare client omits it, so every toast-count assertion
 * below was counting only the panel's own toast and could not have caught the
 * duplicate — or, on the stale-revoke path, the CONTRADICTORY — second toast
 * production actually rendered. `gcTime: 0` so an unmounted tree drops its
 * cache between renders in the same test.
 */
function renderPanel() {
  return render(<ApiKeysSettingsPanel />, {
    wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
  });
}

function panelState(): string | null {
  const node = document.querySelector("[data-settings-panel-data-state]");
  return node?.getAttribute("data-settings-panel-data-state") ?? null;
}

describe("ApiKeysSettingsPanel read states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastCalls.length = 0;
  });

  it("renders a failed list read as failed, not as an empty key list", async () => {
    mockApiClient.get.mockRejectedValue(new ApiError("boom", 500));

    renderPanel();

    await waitFor(() => expect(panelState()).toBe("failed"));
    expect(screen.queryByText("No API keys yet")).not.toBeInTheDocument();
  });

  it("renders a genuinely empty list as empty", async () => {
    mockApiClient.get.mockResolvedValue([]);

    renderPanel();

    await waitFor(() => expect(panelState()).toBe("empty"));
    expect(screen.getByText("No API keys yet")).toBeInTheDocument();
  });

  it("renders a refusal and an unresolved role as DIFFERENT states", async () => {
    mockApiClient.get.mockRejectedValue(new ApiError("denied", 403));
    const denied = renderPanel();
    await waitFor(() => expect(panelState()).toBe("forbidden"));
    denied.unmount();

    mockApiClient.get.mockRejectedValue(new ApiError("role unresolved", 503));
    renderPanel();
    await waitFor(() => expect(panelState()).toBe("unavailable"));
  });

  it("mounts the third-party credential cards beside the platform keys", () => {
    mockApiClient.get.mockResolvedValue([]);

    renderPanel();

    expect(screen.getByTestId("api-keys-credential-cards")).toBeInTheDocument();
  });

  it("lists the keys the server returned when the read succeeds", async () => {
    mockApiClient.get.mockResolvedValue([activeKey()]);

    renderPanel();

    expect(await screen.findByText("CI pipeline")).toBeInTheDocument();
    expect(panelState()).toBeNull();
  });
});

describe("ApiKeysSettingsPanel secret handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastCalls.length = 0;
  });

  it("shows a new key's secret once at creation and never re-reads it", async () => {
    const user = userEvent.setup();
    mockApiClient.get.mockResolvedValue([]);
    mockApiClient.post.mockResolvedValue({
      ...activeKey(),
      plaintext: MINTED_SECRET,
    });

    renderPanel();
    await waitFor(() => expect(panelState()).toBe("empty"));

    await user.click(screen.getByRole("button", { name: "Create key" }));
    await user.type(screen.getByLabelText("Name"), "CI pipeline");
    await user.click(screen.getByRole("button", { name: "Create" }));

    const field = await screen.findByLabelText<HTMLInputElement>("API key");
    expect(field.value === MINTED_SECRET).toBe(true);

    await user.click(
      screen.getByLabelText("I have stored this key somewhere safe")
    );
    await user.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(screen.queryByLabelText("API key")).not.toBeInTheDocument()
    );
    // The list read is the only remaining source, and it never carries a
    // secret: nothing re-requests the key and nothing re-renders it.
    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML.includes(MINTED_SECRET)).toBe(false);
  });

  it("puts no part of the secret into a console sink or a toast", async () => {
    const user = userEvent.setup();
    const consoleSpies = (
      ["debug", "error", "info", "log", "warn"] as const
    ).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined)
    );
    mockApiClient.get.mockResolvedValue([]);
    mockApiClient.post.mockResolvedValue({
      ...activeKey(),
      plaintext: MINTED_SECRET,
    });

    renderPanel();
    await waitFor(() => expect(panelState()).toBe("empty"));
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await user.type(screen.getByLabelText("Name"), "CI pipeline");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByLabelText("API key");

    const consoleLeaked = consoleSpies.some((spy) =>
      spy.mock.calls.some((call) =>
        call.some((argument) =>
          JSON.stringify(argument)?.includes(MINTED_SECRET)
        )
      )
    );
    const toastLeaked = toastCalls.some((call) =>
      call.message.includes(MINTED_SECRET)
    );

    expect(consoleLeaked).toBe(false);
    expect(toastLeaked).toBe(false);
    for (const spy of consoleSpies) {
      spy.mockRestore();
    }
  });

  it("keeps the create failure message free of anything the server returned", async () => {
    const user = userEvent.setup();
    mockApiClient.get.mockResolvedValue([]);
    mockApiClient.post.mockRejectedValue(
      new ApiError(`leaked ${MINTED_SECRET}`, 500)
    );

    renderPanel();
    await waitFor(() => expect(panelState()).toBe("empty"));
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await user.type(screen.getByLabelText("Name"), "CI pipeline");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(toastCalls.length).toBe(1));
    expect(toastCalls[0].message.includes(MINTED_SECRET)).toBe(false);
    expect(toastCalls[0].message).toBe("Couldn't create that API key");
  });
});

describe("ApiKeysSettingsPanel revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastCalls.length = 0;
  });

  it.each([404, 409])(
    "recovers from a key another actor already revoked (%i) instead of reporting a failure",
    async (status) => {
      const user = userEvent.setup();
      mockApiClient.get.mockResolvedValue([activeKey()]);
      mockApiClient.delete.mockRejectedValue(new ApiError("API key", status));

      renderPanel();
      await screen.findByText("CI pipeline");

      await user.click(
        screen.getByRole("button", { name: "Revoke CI pipeline" })
      );
      await user.click(screen.getByRole("button", { name: "Revoke" }));

      await waitFor(() => expect(toastCalls.length).toBe(1));
      expect(toastCalls[0]).toEqual({
        kind: "success",
        message: "That key was already revoked",
      });
      // The stale row is re-read rather than left asserting the key is active.
      await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(2));
    }
  );

  it("reports a genuine revoke failure as a failure and still re-reads", async () => {
    const user = userEvent.setup();
    mockApiClient.get.mockResolvedValue([activeKey()]);
    mockApiClient.delete.mockRejectedValue(new ApiError("boom", 500));

    renderPanel();
    await screen.findByText("CI pipeline");

    await user.click(
      screen.getByRole("button", { name: "Revoke CI pipeline" })
    );
    await user.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(toastCalls.length).toBe(1));
    expect(toastCalls[0]).toEqual({
      kind: "error",
      message: "Couldn't revoke that API key",
    });
    // The name claims the re-read, so the name owes the assertion: the refetch
    // sits after the if/else and must cover BOTH branches, not just the stale
    // one the sibling case pins (review finding, unified auditor).
    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(2));
  });
});

/**
 * ISS-11410: a failure that settles after the panel closed still reports
 * itself. Closing Settings mid-request unmounts the panel, and the failure
 * toast must survive that exactly as it does while the panel is open.
 */
describe("ApiKeysSettingsPanel failure toasts after unmount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastCalls.length = 0;
  });

  it("still reports a revoke failure that settles after the panel unmounts", async () => {
    const user = userEvent.setup();
    const revoke = deferred();
    mockApiClient.get.mockResolvedValue([activeKey()]);
    mockApiClient.delete.mockReturnValue(revoke.promise);

    const view = renderPanel();
    await screen.findByText("CI pipeline");
    await user.click(
      screen.getByRole("button", { name: "Revoke CI pipeline" })
    );
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(mockApiClient.delete).toHaveBeenCalledTimes(1));

    view.unmount();
    revoke.reject(new ApiError("boom", 500));

    await waitFor(() =>
      expect(toastCalls).toEqual([
        { kind: "error", message: "Couldn't revoke that API key" },
      ])
    );
  });

  it("still reports a create failure that settles after the panel unmounts", async () => {
    const user = userEvent.setup();
    const create = deferred();
    mockApiClient.get.mockResolvedValue([]);
    mockApiClient.post.mockReturnValue(create.promise);

    const view = renderPanel();
    await waitFor(() => expect(panelState()).toBe("empty"));
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await user.type(screen.getByLabelText("Name"), "CI pipeline");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockApiClient.post).toHaveBeenCalledTimes(1));

    view.unmount();
    create.reject(new ApiError("boom", 500));

    await waitFor(() =>
      expect(toastCalls).toEqual([
        { kind: "error", message: "Couldn't create that API key" },
      ])
    );
  });
});

function deferred() {
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}
