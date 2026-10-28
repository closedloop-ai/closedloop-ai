import { TooltipProvider } from "@closedloop-ai/design-system/components/ui/tooltip";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { ReadSource } from "@repo/api/src/types/read-source";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { useBranchesPageData } from "@repo/app/branches/hooks/use-branches";
import { canonicalBranchListResponseFixture } from "@repo/app/branches/test-fixtures/canonical-branch-projection";
import { ReadSourceBadge } from "@repo/app/shared/components/read-source-badge";
import { onlineManager } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import type { SyncConsentRecord } from "../../../shared/sync-consent";
import { DesktopAppCoreProvider } from "../../shared-agent-sessions/desktop-app-core-provider";
import type { DesktopAuthState } from "../../types/desktop-api";
import { DesktopBranchesSource } from "../desktop-branches-source";

/**
 * ISS-5714: Sessions said `Local` while Branches said `Cloud (partial)` in one
 * app, in one session, on one date window — and the Branches page was empty
 * because the cloud had not yet received this machine's history.
 *
 * The two surfaces selected their read store from two DIFFERENT predicates.
 * Since ISS-6972 there is one, and since 2026-09-25 it is authenticated and
 * online — consent left it, because consent governs what this Mac SENDS.
 * This suite pins the invariant that closes that class: **on one rendered
 * screen, under one app state, both surfaces' data sources must report the same
 * store.** ISS-6005 removed the badge from the Sessions list toolbar and
 * ISS-9923 gated it on the Branches pair, so the harness below mounts it itself
 * rather than depending on either toolbar to render the readout.
 *
 * Asserting each badge against a CONSTANT would not catch the divergence — the
 * two have to be compared against EACH OTHER, on one mount, which is what
 * {@link ReadSourceParityScreen} exists to make possible.
 */
const AUTHENTICATED: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-1",
  organizationId: "org-1",
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

/**
 * One screen carrying BOTH surfaces' read-source badges, each driven by the
 * `readSource` its own production list read stamped — the same envelope field
 * `SessionsView` and `BranchesView` pass to their toolbars.
 */
function ReadSourceParityScreen() {
  const sessions = useAgentSessions({ limit: 1, offset: 0 });
  const branches = useBranchesPageData();
  return (
    <TooltipProvider>
      <div data-testid="sessions-surface">
        <ReadSourceBadge
          readSource={sessions.data?.readSource}
          surfaceLabel="sessions"
        />
      </div>
      <div data-testid="branches-surface">
        <ReadSourceBadge
          readSource={branches.data?.list.readSource}
          surfaceLabel="branches"
        />
      </div>
    </TooltipProvider>
  );
}

const CONSENTED: SyncConsentRecord = {
  tier: "full",
  organizationId: "org-1",
  bound: true,
};

function setupDesktopApi(consent: SyncConsentRecord = CONSENTED) {
  const emptySessionsList = {
    items: [],
    total: 0,
    viewerScope: AgentSessionViewerScope.Self,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() => Promise.resolve(AUTHENTICATED)),
      onDesktopAuthStateChanged: vi.fn(() => () => {
        // no auth transitions in this suite
      }),
      getSyncConsentRecord: vi.fn(() => Promise.resolve(consent)),
      cloudApiFetch: vi.fn((...args: unknown[]) =>
        Promise.resolve({
          kind: "response" as const,
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/json"]] as [string, string][],
          bodyText: JSON.stringify({
            success: true,
            data: JSON.stringify(args).includes("branches")
              ? canonicalBranchListResponseFixture
              : emptySessionsList,
          }),
        })
      ),
      agentSessionsApi: {
        analytics: vi.fn(() =>
          Promise.resolve({
            byAgentType: [],
            byProject: [],
            byRepository: [],
            byTool: [],
            viewerScope: AgentSessionViewerScope.Self,
          })
        ),
        detail: vi.fn(() => Promise.resolve(null)),
        list: vi.fn(() => Promise.resolve(emptySessionsList)),
        pageData: vi.fn(() =>
          Promise.resolve({ list: emptySessionsList, usage: null })
        ),
        usage: vi.fn(() => Promise.resolve(null)),
      },
      branchesApi: {
        list: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
        detail: vi.fn(() => Promise.resolve(null)),
        analytics: vi.fn(() => Promise.resolve({})),
        usage: vi.fn(() => Promise.resolve({})),
        pageData: vi.fn(() =>
          Promise.resolve({ list: { items: [], total: 0 }, analytics: {} })
        ),
      },
      db: {
        listAgentComponents: vi.fn(() =>
          Promise.resolve({ items: [], total: 0 })
        ),
        getAgentComponentDetail: vi.fn(() => Promise.resolve(null)),
      },
    },
  });
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

function renderParityScreen() {
  return render(
    <DesktopAppCoreProvider>
      <DesktopBranchesSource>
        <ReadSourceParityScreen />
      </DesktopBranchesSource>
    </DesktopAppCoreProvider>
  );
}

async function settledReadSources(): Promise<{
  sessions: string | null;
  branches: string | null;
}> {
  await waitFor(() => {
    expect(
      screen.getByTestId("sessions-surface").querySelector("[data-read-source]")
    ).not.toBeNull();
    expect(
      screen.getByTestId("branches-surface").querySelector("[data-read-source]")
    ).not.toBeNull();
  });
  return {
    sessions: readSourceOf("sessions-surface"),
    branches: readSourceOf("branches-surface"),
  };
}

function readSourceOf(surfaceTestId: string): string | null {
  return (
    screen
      .getByTestId(surfaceTestId)
      .querySelector("[data-read-source]")
      ?.getAttribute("data-read-source") ?? null
  );
}

describe("Sessions and Branches read-source parity (ISS-5714)", () => {
  it("reports one store on one screen when authenticated and online", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi();

    renderParityScreen();

    const badges = await settledReadSources();
    // The reported defect: Sessions rendered `local` (populated, from SQLite)
    // beside Branches rendering `cloud` (empty). Neither value alone is
    // wrong-looking — their DISAGREEMENT is the bug, so they are compared to
    // each other and not to a constant...
    expect(badges.branches).toBe(badges.sessions);
    // ...but equality alone would also pass if BOTH went to the wrong store, so
    // the store they agree on is pinned too.
    expect(badges.sessions).toBe(ReadSource.Cloud);
  });

  /**
   * The provider-level half of the 2026-09-25 ruling: consent governs EGRESS,
   * so a reader who sends nothing — or has not elected a level at all — still
   * reads their workspace on BOTH surfaces. This mounts the real provider with
   * a withholding consent record on the bridge, so threading consent back into
   * `resolveDesktopAppCoreMode` turns these red where a resolver-level case
   * that cannot even express consent any more would stay green.
   */
  it.each([
    ["a tier that sends nothing", "local"],
    ["no elected tier at all", null],
  ] as const)(
    "reads the workspace on both surfaces for %s",
    async (_label, tier) => {
      restoreOnline = forceOnline(true);
      setupDesktopApi({ ...CONSENTED, tier });

      renderParityScreen();

      const badges = await settledReadSources();
      expect(badges.branches).toBe(badges.sessions);
      expect(badges.sessions).toBe(ReadSource.Cloud);
    }
  );

  /**
   * ISS-6972 decision 3 retired the one deliberate divergence this suite used to
   * pin: Branches kept serving cached cloud rows offline while Sessions dropped
   * to the local database. That bought offline branch reads at the cost of one
   * screen naming two stores, which is the defect class this file exists for.
   * Offline is now Local on both surfaces.
   */
  it("drops BOTH surfaces to local data when the machine goes offline", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi();
    renderParityScreen();
    await settledReadSources();

    act(() => {
      onlineManager.setOnline(false);
      restoreOnline?.();
      restoreOnline = forceOnline(false);
      window.dispatchEvent(new Event("offline"));
    });

    await waitFor(() => {
      expect(readSourceOf("sessions-surface")).toBe(ReadSource.Local);
      expect(readSourceOf("branches-surface")).toBe(ReadSource.Local);
    });
  });
});
