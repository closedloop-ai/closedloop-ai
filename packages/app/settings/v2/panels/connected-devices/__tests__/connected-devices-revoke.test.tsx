import { BrowserSessionErrorCode } from "@repo/api/src/types/browser-session";
import { SettingsPanelIntent } from "@repo/api/src/types/settings-panel";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../shared/api/api-error";
import { makeQueryClient } from "../../../../../shared/query/query-client";
import { SettingsPanelDataState } from "../../../lib/settings-panel-data-state";
import {
  buildBrowserSessionFixture,
  buildBrowserSessionListFixture,
} from "../../../test-fixtures/device-panel-fixtures";
import { ConnectedDevicesPanel } from "../connected-devices-panel";

const mockApiClient = { delete: vi.fn(), get: vi.fn() };

vi.mock("../../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const BROWSER_SESSIONS_PATH = "/settings/browser-sessions";
const COMPUTE_TARGETS_PATH = "/compute-targets";
const REVOCABLE_SESSION_ID = "sess_other";
const RE_CURRENT_SESSION_SENTENCE = /Use Sign out to end it/;
const RE_NOT_FOUND_SENTENCE =
  /no longer active, so there was nothing to sign out/;

function listWith(sessionIds: readonly string[]) {
  return buildBrowserSessionListFixture({
    sessions: sessionIds.map((id) => buildBrowserSessionFixture({ id })),
  });
}

/**
 * Answers the list read from a queue, so the refetch a successful revoke
 * triggers can return a DIFFERENT page than the first read did.
 */
function stubList(pages: readonly ReturnType<typeof listWith>[]) {
  let index = 0;
  mockApiClient.get.mockImplementation((path: string) => {
    if (path.startsWith(BROWSER_SESSIONS_PATH)) {
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return Promise.resolve(page);
    }
    if (path === COMPUTE_TARGETS_PATH) {
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`unexpected read: ${path}`));
  });
}

function renderPanel() {
  const queryClient = makeQueryClient({ gcTime: 0 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<ConnectedDevicesPanel intent={SettingsPanelIntent.View} />, {
    wrapper,
  });
}

function revokeOutcome(): string | null {
  return (
    document
      .querySelector("[data-browser-session-revoke]")
      ?.getAttribute("data-browser-session-revoke") ?? null
  );
}

async function clickSignOut() {
  const button = await screen.findByRole("button", { name: "Sign out" });
  fireEvent.click(button);
}

describe("ConnectedDevicesPanel revoke outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes the row once the refetch reflects the revoke", async () => {
    stubList([listWith([REVOCABLE_SESSION_ID]), listWith([])]);
    mockApiClient.delete.mockResolvedValue({ revoked: true });

    renderPanel();
    await clickSignOut();

    await waitFor(() =>
      expect(
        document.querySelector(
          `[data-browser-session-row="${REVOCABLE_SESSION_ID}"]`
        )
      ).toBeNull()
    );
    expect(mockApiClient.delete).toHaveBeenCalledWith(
      `${BROWSER_SESSIONS_PATH}/${REVOCABLE_SESSION_ID}`
    );
  });

  it("answers a refused current session with the sign-out sentence, not a failure", async () => {
    // The route refuses the caller's own session with a 409 rather than trusting
    // the client. A generic "that didn't work" would tell the user to retry
    // something that can never succeed from here.
    stubList([listWith([REVOCABLE_SESSION_ID])]);
    mockApiClient.delete.mockRejectedValue(
      new ApiError("conflict", 409, {
        code: BrowserSessionErrorCode.CurrentSessionNotRevocable,
      })
    );

    renderPanel();
    await clickSignOut();

    await waitFor(() =>
      expect(revokeOutcome()).toBe(
        BrowserSessionErrorCode.CurrentSessionNotRevocable
      )
    );
    expect(screen.getByText(RE_CURRENT_SESSION_SENTENCE)).toBeInTheDocument();
  });

  it("answers an already-gone session as not found, distinctly", async () => {
    stubList([listWith([REVOCABLE_SESSION_ID])]);
    mockApiClient.delete.mockRejectedValue(
      new ApiError("gone", 404, {
        code: BrowserSessionErrorCode.SessionNotFound,
      })
    );

    renderPanel();
    await clickSignOut();

    await waitFor(() =>
      expect(revokeOutcome()).toBe(BrowserSessionErrorCode.SessionNotFound)
    );
    expect(screen.getByText(RE_NOT_FOUND_SENTENCE)).toBeInTheDocument();
  });

  it("answers an unreachable provider as unavailable, which is not a refusal", async () => {
    stubList([listWith([REVOCABLE_SESSION_ID])]);
    mockApiClient.delete.mockRejectedValue(
      new ApiError("provider down", 503, {
        code: BrowserSessionErrorCode.ProviderUnavailable,
      })
    );

    renderPanel();
    await clickSignOut();

    await waitFor(() =>
      expect(revokeOutcome()).toBe(SettingsPanelDataState.Unavailable)
    );
    // ...and it is a different render from either coded refusal above.
    expect(revokeOutcome()).not.toBe(BrowserSessionErrorCode.SessionNotFound);
  });
});
