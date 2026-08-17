import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { ReadSource } from "@repo/api/src/types/read-source";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { useBranchList } from "@repo/app/branches/hooks/use-branches";
import { canonicalBranchListResponseFixture } from "@repo/app/branches/test-fixtures/canonical-branch-projection";
import { ReadSourceBadge } from "@repo/app/shared/components/read-source-badge";
import { TooltipProvider } from "@closedloop-ai/design-system/components/ui/tooltip";
import { onlineManager } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudReadReadinessSnapshot } from "../../../shared/cloud-read-readiness-contract";
import { DesktopAuthStatus } from "../../../shared/contracts";
import {
  drainedCutover,
  drainedReadiness,
  drainingReadiness,
} from "../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { describeCloudReadCutover } from "../../shared-agent-sessions/cloud-read-cutover-copy";
import {
  CloudReadCutoverBlocker,
  DesktopAppCoreMode,
} from "../../shared-agent-sessions/desktop-app-core-mode";
import { DesktopAppCoreProvider } from "../../shared-agent-sessions/desktop-app-core-provider";
import type { DesktopAuthState } from "../../types/desktop-api";
import { DesktopBranchesSource } from "../desktop-branches-source";

/**
 * ISS-5714: Sessions said `Local` while Branches said `Cloud (partial)` in one
 * app, in one session, on one date window — and the Branches page was empty
 * because the cloud had not yet received this machine's history.
 *
 * The two surfaces selected their read store from two DIFFERENT predicates:
 * Sessions from the ISS-5477 cutover gate (`useDesktopAppCoreMode`), Branches
 * from bare identity completeness (`useCanonicalCloudSource`). This suite pins
 * the invariant that closes that class: **on one rendered screen, under one
 * app state, both surfaces' `ReadSourceBadge` must report the same store.**
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
  const branches = useBranchList();
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
          readSource={branches.data?.readSource}
          surfaceLabel="branches"
        />
      </div>
    </TooltipProvider>
  );
}

function setupDesktopApi(readiness: CloudReadReadinessSnapshot) {
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
      getCloudReadReadiness: vi.fn(() => Promise.resolve(readiness)),
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
  it("reports one store on one screen while the upload backlog is still draining", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(drainingReadiness());

    renderParityScreen();

    const badges = await settledReadSources();
    // The reported defect: Sessions rendered `local` (populated, from SQLite)
    // beside Branches rendering `cloud` (empty, because the cloud had not yet
    // received a row). Neither value alone is wrong-looking — their DISAGREEMENT
    // is the bug, so they are compared to each other and not to a constant...
    expect(badges.branches).toBe(badges.sessions);
    // ...but equality alone would also pass if BOTH went to the wrong store, so
    // the store they agree on is pinned too. Mid-drain the cloud holds nothing,
    // so the only honest answer for either surface is the local database.
    expect(badges.sessions).toBe(ReadSource.Local);
  });

  it("reports one store on one screen once the backlog has drained", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(drainedReadiness());

    renderParityScreen();

    const badges = await settledReadSources();
    expect(badges.branches).toBe(badges.sessions);
    expect(badges.sessions).toBe(ReadSource.Cloud);
  });

  /**
   * A KNOWN, deliberate divergence, pinned so it cannot drift silently.
   *
   * Connectivity is the one axis `cloudHoldsHistory` excludes. Offline after a
   * cutover, Sessions drops to the local database (PRD-461 D3) while Branches
   * keeps serving the canonical cloud rows already in its cache rather than
   * pausing on an unreachable read — which is strictly more useful than an empty
   * local namespace. The badges therefore differ ON PURPOSE here, and the
   * tooltip has to say so: `describeCloudReadCutover` answers for the store the
   * surface actually read, so Branches must NOT get the local reader's "this is
   * your own machine's data" sentence under a `Cloud` badge.
   */
  it("keeps Branches on its cached cloud rows offline, and says so", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(drainedReadiness());
    renderParityScreen();
    await settledReadSources();

    act(() => {
      onlineManager.setOnline(false);
      restoreOnline?.();
      restoreOnline = forceOnline(false);
      window.dispatchEvent(new Event("offline"));
    });

    await waitFor(() =>
      expect(readSourceOf("sessions-surface")).toBe(ReadSource.Local)
    );
    expect(readSourceOf("branches-surface")).toBe(ReadSource.Cloud);

    const offlineCloud = describeCloudReadCutover(
      { ...drainedCutover(), blocker: CloudReadCutoverBlocker.Offline },
      ReadSource.Cloud
    );
    const offlineLocal = describeCloudReadCutover(
      {
        ...drainedCutover(),
        mode: DesktopAppCoreMode.Local,
        blocker: CloudReadCutoverBlocker.Offline,
      },
      ReadSource.Local
    );
    expect(offlineCloud).not.toBe(offlineLocal);
    expect(offlineLocal).toContain("your own machine's data");
    expect(offlineCloud).not.toContain("your own machine's data");
  });
});
