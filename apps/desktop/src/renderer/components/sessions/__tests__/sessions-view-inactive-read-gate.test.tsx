import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

const sessionsViewHooks = sessionsViewHookMocks();

describe("SessionsView inactive keep-alive read gate (ISS-8055)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultSessionsViewHooks();
    installDesktopApiStub({
      getAgentMonitorUrl: readyLocalSourceProbe(),
      onDbChanged: vi.fn(() => undefined),
    });
  });

  afterEach(() => {
    cleanup();
    restoreDesktopApi();
  });

  it("does not issue list or auxiliary reads while the keep-alive tree is hidden", async () => {
    sessionsViewHooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: listWith([{ id: "s1" }]),
        usage: { byRepository: [] },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });

    await renderSessionsView({ isActive: false });

    expect(sessionsViewHooks.useAgentSessionsPageData).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true })
    );
    expect(
      sessionsViewHooks.useAgentSessionsPageData.mock.lastCall?.[1]
    ).toEqual(expect.objectContaining({ enabled: false }));
    expect(sessionsViewHooks.useAgentSessionAnalytics).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true })
    );
  });

  it("opens the same reads once the keep-alive tree is visible", async () => {
    sessionsViewHooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: listWith([{ id: "s1" }]),
        usage: { byRepository: [] },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });

    await renderSessionsView({ isActive: true });

    expect(sessionsViewHooks.useAgentSessionsPageData).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true })
    );
    expect(sessionsViewHooks.useAgentSessionAnalytics).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true })
    );
  });
});

function readyLocalSourceProbe() {
  return vi.fn(() =>
    Promise.resolve({
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
    })
  );
}
