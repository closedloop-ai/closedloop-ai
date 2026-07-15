import { agentSessionKeys } from "@repo/app/agents/hooks/use-agent-sessions";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  applyDesktopSessionsListPollDefaults,
  DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS,
} from "../sessions-list-poll-defaults";

/**
 * FEA-2187: the desktop Sessions LIST query polls as a fallback because its push
 * refresh (the shared live bridge) is visibility-gated and can defer a
 * post-import flush forever when the renderer reports `document.hidden`
 * (CI/offscreen Electron). These assertions pin the two load-bearing parts: the
 * poll runs in the background (`refetchIntervalInBackground`) — without that,
 * React Query pauses the poll in exactly the hidden state we must cover — and it
 * is scoped to the LIST key only, so detail/usage/analytics stay pure-push.
 */
describe("applyDesktopSessionsListPollDefaults", () => {
  it("sets a background poll default on the sessions list key", () => {
    const client = new QueryClient();
    applyDesktopSessionsListPollDefaults(client);

    const listDefaults = client.getQueryDefaults(
      agentSessionKeys.list("local", {})
    );
    expect(listDefaults.refetchInterval).toBe(
      DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS
    );
    // Load-bearing: must keep polling while the window is hidden.
    expect(listDefaults.refetchIntervalInBackground).toBe(true);
  });

  it("does not poll non-list session queries (detail stays pure-push)", () => {
    const client = new QueryClient();
    applyDesktopSessionsListPollDefaults(client);

    const detailDefaults = client.getQueryDefaults(
      agentSessionKeys.detail("local", "session-1")
    );
    expect(detailDefaults.refetchInterval).toBeUndefined();
    expect(detailDefaults.refetchIntervalInBackground).toBeUndefined();
  });
});
