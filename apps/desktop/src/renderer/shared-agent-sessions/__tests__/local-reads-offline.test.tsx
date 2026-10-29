import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { ReadSource } from "@repo/api/src/types/read-source";
import { useAgentSessionsDataSource } from "@repo/app/agents/data-source/provider";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { onlineManager } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import type { SyncConsentRecord } from "../../../shared/sync-consent";
import type { DesktopAuthState } from "../../types/desktop-api";
import { DesktopAppCoreMode } from "../desktop-app-core-mode";
import {
  DesktopAppCoreProvider,
  useDesktopAppCoreMode,
} from "../desktop-app-core-provider";

/**
 * A Local-mode read must RESOLVE while the machine is offline.
 *
 * The local client's reads are SQLite over IPC, but they are still React Query
 * queries, and React Query's stock `networkMode: "online"` pauses any fetch it
 * starts while `onlineManager` reports offline. On an empty cache that pause is
 * terminal: `fetchStatus: "paused"`, `isPending: true`, forever — so every
 * Local-mode surface (Sessions, components, trace comments, insights) renders a
 * skeleton that never resolves, in the one state that sent it to the local
 * source in the first place.
 *
 * The mount here is COLD-OFFLINE on purpose: `navigator.onLine` AND
 * `onlineManager` are both offline BEFORE the first render, so the query under
 * assertion is the local client's own first fetch. A suite that mounts online
 * and flips offline afterwards cannot fail on this defect — the observer it
 * keeps is the one built at boot, and the value it then reads back is the cache
 * that boot fetch filled while the machine was still online.
 */

const AUTHENTICATED: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-1",
  organizationId: "org-1",
};

const CONSENTED: SyncConsentRecord = {
  tier: "full",
  organizationId: "org-1",
  bound: true,
};

const LOCAL_SCOPE = "local";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

/**
 * Authenticated and permitted to sync, so OFFLINE is the only term holding this
 * renderer on the local source — the exact state the pause used to strand.
 */
function setupDesktopApi() {
  const list = vi.fn(async () => ({
    items: [{ id: "session-1" }],
    total: 1,
    viewerScope: AgentSessionViewerScope.Self,
  }));
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() => Promise.resolve(AUTHENTICATED)),
      onDesktopAuthStateChanged: vi.fn(() => () => {
        // no auth transitions in this suite
      }),
      getSyncConsentRecord: vi.fn(() => Promise.resolve(CONSENTED)),
      agentSessionsApi: {
        analytics: vi.fn(async () => ({
          byAgentType: [],
          byProject: [],
          byRepository: [],
          byTool: [],
          viewerScope: AgentSessionViewerScope.Self,
        })),
        detail: vi.fn(async () => null),
        list,
        pageData: vi.fn(async () => ({
          list: { items: [], total: 0 },
          usage: null,
        })),
        usage: vi.fn(async () => null),
      },
      db: {
        listAgentComponents: vi.fn(async () => ({ items: [], total: 0 })),
        getAgentComponentDetail: vi.fn(async () => null),
      },
    },
  });
  return { list };
}

function forceOnline(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
  return () => {
    if (original) {
      Object.defineProperty(window.navigator, "onLine", original);
    } else {
      Reflect.deleteProperty(window.navigator, "onLine");
    }
  };
}

let restoreOnline: (() => void) | null = null;

afterEach(() => {
  onlineManager.setOnline(true);
  restoreOnline?.();
  restoreOnline = null;
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("Local-mode reads on a cold offline start", () => {
  it("resolves the local IPC read instead of pausing it", async () => {
    restoreOnline = forceOnline(false);
    onlineManager.setOnline(false);
    const { list } = setupDesktopApi();

    const { result } = renderHook(
      () => ({
        mode: useDesktopAppCoreMode(),
        sessions: useAgentSessions({ limit: 10, offset: 0 }),
        source: useAgentSessionsDataSource(),
      }),
      { wrapper: DesktopAppCoreProvider }
    );

    // Pin the path under test: offline degrades to the local SQLite source, so
    // a green run cannot be the cloud client answering.
    await waitFor(() => {
      expect(result.current.mode).toBe(DesktopAppCoreMode.Local);
    });
    expect(result.current.source.scope).toBe(LOCAL_SCOPE);

    await waitFor(() => {
      expect(result.current.sessions.data?.total).toBe(1);
    });
    expect(result.current.sessions.data?.readSource).toBe(ReadSource.Local);
    expect(result.current.sessions.fetchStatus).not.toBe("paused");
    expect(list).toHaveBeenCalled();
  });
});
