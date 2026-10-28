import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { onlineManager } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import {
  DESKTOP_LOCAL_READ_REASON_COPY,
  DesktopLocalReadReason,
} from "../../../shared-agent-sessions/desktop-app-core-mode";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import type { DesktopAuthState } from "../../../types/desktop-api";
import { BranchDetailView } from "../branch-detail-view";

/**
 * ISS-6972 follow-up regression: a CLOUD branch detail open when the machine
 * goes offline.
 *
 * Offline moves the read source to this device — that is the decided product
 * behavior and this test does not challenge it. What it pins is what the user is
 * TOLD: the open id is a cloud Branch artifact UUID, which the local SQLite
 * source cannot address, so it answered 404 and the shared page rendered "Branch
 * not found" over a branch the user was reading a second earlier.
 */

/** A cloud Branch artifact id (`Artifact.id` is `@default(uuid(7))`). */
const CLOUD_BRANCH_ID = "0197f3a1-2b4c-7d8e-9f01-23456789abcd";
const BRANCH_NAME = "feature/offline-read";
const AUTHENTICATED: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-1",
  organizationId: "org-1",
};
const OFFLINE_DESCRIPTION = `${DESKTOP_LOCAL_READ_REASON_COPY[DesktopLocalReadReason.Offline]} Showing the data stored on this device, which doesn't include this branch.`;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);
let restoreOnline: (() => void) | null = null;

function cloudDetail(): BranchPageDetail {
  return {
    id: CLOUD_BRANCH_ID,
    branchName: BRANCH_NAME,
    baseBranch: "main",
    repoFullName: "owner/repo",
    owner: "alice",
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-06-17T12:00:00.000Z",
    sessionIds: [],
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [],
    mergedTrace: [],
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [],
    linkedArtifacts: [],
  };
}

function jsonBridgeResult(data: unknown) {
  return {
    kind: "response" as const,
    status: 200,
    statusText: "OK",
    headers: [["content-type", "application/json"]] as [string, string][],
    bodyText: JSON.stringify({ success: true, data }),
  };
}

/**
 * The cloud bridge answers the branch detail; this device's SQLite store has no
 * row under a cloud id, which is exactly why its `detail` resolves null (the
 * local source turns that into the 404 this regression is about).
 */
function setupDesktopApi() {
  const localDetail = vi.fn(async () => null);
  const cloudApiFetch = vi.fn(async ({ path }: { path: string }) =>
    path.includes(`/branches/${CLOUD_BRANCH_ID}`) && !path.includes("/comments")
      ? jsonBridgeResult(cloudDetail())
      : jsonBridgeResult({})
  );
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() => Promise.resolve(AUTHENTICATED)),
      onDesktopAuthStateChanged: vi.fn(() => () => undefined),
      cloudApiFetch,
      agentSessionsApi: {
        analytics: vi.fn(async () => ({})),
        detail: vi.fn(async () => null),
        list: vi.fn(async () => ({ items: [], total: 0 })),
        usage: vi.fn(async () => null),
      },
      branchesApi: {
        list: vi.fn(async () => ({ items: [], total: 0 })),
        detail: localDetail,
        trace: vi.fn(async () => []),
        analytics: vi.fn(async () => ({})),
        usage: vi.fn(async () => ({})),
      },
    },
  });
  return { cloudApiFetch, localDetail };
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

function goOffline() {
  act(() => {
    onlineManager.setOnline(false);
    restoreOnline?.();
    restoreOnline = forceOnline(false);
    window.dispatchEvent(new Event("offline"));
  });
}

function renderDetail(enabledFlags?: readonly string[]) {
  const navigation = createMemoryNavigation({
    initialPath: `/branches/${CLOUD_BRANCH_ID}`,
  });
  const view = (
    <DesktopAppCoreProvider>
      <BranchDetailView
        backHref="/branches"
        backLabel={BranchBackLabel.Branches}
        branchId={CLOUD_BRANCH_ID}
      />
    </DesktopAppCoreProvider>
  );
  return render(
    <NavigationProvider adapter={navigation.adapter}>
      {enabledFlags ? (
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: [...enabledFlags],
          })}
        >
          {view}
        </FeatureFlagAdapterProvider>
      ) : (
        view
      )}
    </NavigationProvider>
  );
}

afterEach(() => {
  onlineManager.setOnline(true);
  restoreOnline?.();
  restoreOnline = null;
  vi.restoreAllMocks();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("BranchDetailView offline with a workspace branch open", () => {
  it("says where the branch is instead of reporting it missing", async () => {
    restoreOnline = forceOnline(true);
    const { localDetail } = setupDesktopApi();
    renderDetail();

    // Reading the workspace: the cloud detail is on screen before connectivity
    // drops, so the state below is a transition, not a cold mount.
    expect(
      await screen.findByRole("heading", { name: BRANCH_NAME })
    ).toBeDefined();

    goOffline();

    expect(
      await screen.findByText("This branch is in your workspace")
    ).toBeDefined();
    expect(screen.getByText(OFFLINE_DESCRIPTION)).toBeDefined();
    expect(screen.queryByText("Branch not found")).toBeNull();
    // The doomed local read is never issued: a cloud id names nothing in this
    // device's store, and its 404 is what used to be mistranslated.
    await waitFor(() => expect(localDetail).not.toHaveBeenCalled());
  });

  it("keeps saying it with the shared-shell key forced on", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi();
    // ISS-10797 requires this proof with the key ON: the host reads the flag
    // above its workspace-only return, so a reordering that let the shell win
    // would answer "Branch not found" about a branch the user has.
    renderDetail([ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]);
    expect(
      await screen.findByRole("heading", { name: BRANCH_NAME })
    ).toBeDefined();

    goOffline();

    expect(
      await screen.findByText("This branch is in your workspace")
    ).toBeDefined();
    expect(screen.getByText(OFFLINE_DESCRIPTION)).toBeDefined();
    // The shell is the thing that must NOT have mounted; its tab strip is the
    // only part of it that cannot also come from the legacy page.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });
});
