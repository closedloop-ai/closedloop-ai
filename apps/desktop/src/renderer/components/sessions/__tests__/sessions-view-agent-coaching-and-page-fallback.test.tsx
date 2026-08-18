import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

const sessionsViewHooks = sessionsViewHookMocks();

describe("SessionsView coaching gate and page fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultSessionsViewHooks();
    installDesktopApiStub({
      getAgentMonitorUrl: vi.fn().mockResolvedValue({
        localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
      }),
      onDbChanged: vi.fn(() => undefined),
    });
  });

  afterEach(() => {
    cleanup();
    restoreDesktopApi();
  });

  it("renders coaching tips only when their Labs gate is enabled", async () => {
    sessionsViewHooks.useFeatureFlagEnabled.mockImplementation(
      (key: string) => key === DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY
    );

    await renderSessionsView();

    expect(screen.getByTestId("agent-coaching-tips")).toBeTruthy();
  });

  it("falls back an invalid page query to the first server window", async () => {
    sessionsViewHooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams("page=invalid")
    );

    await renderSessionsView();

    expect(sessionsViewHooks.useAgentSessionsPageData).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, offset: 0 }),
      expect.anything()
    );
  });
});
