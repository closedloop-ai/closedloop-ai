import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  type ArtifactCollaboratorBatchResponse,
  CollaboratorArtifactType,
} from "@repo/api/src/types/artifact-collaborators";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { useAgentSessionsDataSource } from "@repo/app/agents/data-source/provider";
import { useBranchesDataSource } from "@repo/app/branches/data-source/provider";
import { artifactCollaboratorBatchFixture } from "@repo/app/shared/__tests__/fixtures/artifact-collaborators";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudApiFetchRequest } from "../../../shared/cloud-api-fetch-contract";
import { DesktopAuthStatus } from "../../../shared/contracts";
import type { SyncConsentRecord } from "../../../shared/sync-consent";
import { RendererExceptionReporterProvider } from "../../renderer-exception-reporter";
import { DesktopBranchesSource } from "../../shared-branches/desktop-branches-source";
import type { DesktopAuthState } from "../../types/desktop-api";
import { DesktopAppCoreMode } from "../desktop-app-core-mode";
import {
  DesktopAppCoreProvider,
  useDesktopAppCoreMode,
} from "../desktop-app-core-provider";

/**
 * The bridge is only worth anything if the provider actually mounts it, and it
 * belongs to exactly one mode: CLOUD reads have no other refresh channel, while
 * LOCAL reads already have the local DB's push bridge and would gain nothing but
 * duplicate work from a second one.
 *
 * The bridge module is mocked to a counter rather than driving its behaviour
 * again (that is the sibling suite's job) — what this asserts is the wiring, so
 * deleting the mount site fails here.
 */
const mount = vi.hoisted(() => ({
  count: 0,
  cloudApiFetch: vi.fn(),
  getE2eSeededFeatureFlags: vi.fn(),
  reportException: vi.fn(),
}));

vi.mock("../cloud-sessions-sync-bridge", () => ({
  CloudSessionsSyncBridge: () => {
    mount.count += 1;
    return null;
  },
}));

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

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

let restoreOnline: (() => void) | null = null;
let fixtureAuthState = AUTHENTICATED;

beforeEach(() => {
  mount.count = 0;
  mount.cloudApiFetch.mockClear();
  mount.getE2eSeededFeatureFlags.mockReset();
  mount.reportException.mockClear();
  fixtureAuthState = AUTHENTICATED;
  mount.cloudApiFetch.mockImplementation(() =>
    Promise.resolve({
      kind: "response",
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      bodyText: "{}",
    })
  );
  mount.getE2eSeededFeatureFlags.mockResolvedValue({
    flags: {
      [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]: true,
    },
    resolved: true,
    userId: "e2e-user",
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      cloudApiFetch: mount.cloudApiFetch,
      getE2eSeededFeatureFlags: mount.getE2eSeededFeatureFlags,
      getDesktopAuthState: () => Promise.resolve(fixtureAuthState),
      onDesktopAuthStateChanged: () => () => {
        // no auth transitions in this suite
      },
      getSyncConsentRecord: () => Promise.resolve(CONSENTED),
      getRuntimeStatus: () => Promise.resolve({}),
      agentSessionsApi: {
        list: () =>
          Promise.resolve({
            items: [
              createAgentSessionListItemFixture({
                externalSessionId: "local-fallback-session",
                id: "local-fallback-session",
              }),
            ],
            total: 1,
            viewerScope: AgentSessionViewerScope.Self,
          }),
      },
    },
    writable: true,
  });
});

afterEach(() => {
  restoreOnline?.();
  restoreOnline = null;
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("DesktopAppCoreProvider sessions refresh channel", () => {
  it("routes a recovered cloud Sessions failure through renderer monitoring", async () => {
    mount.cloudApiFetch.mockResolvedValue({
      kind: "response",
      status: 503,
      statusText: "Service Unavailable",
      headers: [["content-type", "application/json"]],
      bodyText: JSON.stringify({ message: "cloud unavailable" }),
    });
    const { result } = renderHook(
      () => ({
        mode: useDesktopAppCoreMode(),
        sessions: useAgentSessionsDataSource(),
      }),
      { wrapper: withExceptionReporter }
    );
    await waitFor(() =>
      expect(result.current.mode).toBe(DesktopAppCoreMode.Cloud)
    );

    await waitFor(async () => {
      await expect(
        result.current.sessions.list({ limit: 25 })
      ).resolves.toMatchObject({
        items: [{ id: "local-fallback-session" }],
      });
    });
    expect(mount.reportException).toHaveBeenCalledWith(expect.any(Error));
  });

  it.each([CollaboratorArtifactType.Session, CollaboratorArtifactType.Branch])(
    "reads %s collaborators through the mounted Cloud source and IPC bridge",
    async (artifactType) => {
      const ids = [
        "55555555-5555-4555-8555-555555555551",
        "55555555-5555-4555-8555-555555555552",
      ];
      const fixture = artifactCollaboratorBatchFixture(artifactType, ids);
      respondWithCollaborators(artifactType, ids, fixture);
      const { result } = renderHook(
        () => ({
          mode: useDesktopAppCoreMode(),
          sessions: useAgentSessionsDataSource(),
          branches: useBranchesDataSource(),
        }),
        { wrapper: withBranchSource }
      );
      await waitFor(() =>
        expect(result.current.mode).toBe(DesktopAppCoreMode.Cloud)
      );
      const source =
        artifactType === CollaboratorArtifactType.Session
          ? result.current.sessions
          : result.current.branches;
      expect(await source.collaborators?.(ids)).toEqual(fixture);
      const requests = mount.cloudApiFetch.mock.calls.map(
        ([request]) => request as CloudApiFetchRequest
      );
      const batch = requests.find((request) =>
        request.path.startsWith("/artifacts/collaborators?")
      );
      expect(batch?.method).toBe("GET");
      const query = new URL(batch?.path ?? "", "https://api.example.test");
      expect(query.searchParams.getAll("artifactIds")).toEqual(ids);
      expect(query.searchParams.get("artifactType")).toBe(artifactType);
    }
  );

  it("carries each Branch's Cloud PR-comment proof state through unchanged", async () => {
    const [provenId, missingLaneId] = [
      "55555555-5555-4555-8555-555555555553",
      "55555555-5555-4555-8555-555555555554",
    ];
    const base = artifactCollaboratorBatchFixture(
      CollaboratorArtifactType.Branch,
      [provenId, missingLaneId]
    );
    const fixture: ArtifactCollaboratorBatchResponse = {
      results: base.results.map((entry) =>
        entry.artifactType === CollaboratorArtifactType.Branch &&
        entry.artifactId === provenId
          ? {
              ...entry,
              collaborators: {
                ...entry.collaborators,
                sources: {
                  ...entry.collaborators.sources,
                  [BranchCollaboratorSource.PullRequestComments]:
                    BranchIdentityAvailability.Complete,
                },
              },
            }
          : entry
      ),
    };
    respondWithCollaborators(
      CollaboratorArtifactType.Branch,
      [provenId, missingLaneId],
      fixture
    );
    const { result } = renderHook(
      () => ({
        mode: useDesktopAppCoreMode(),
        branches: useBranchesDataSource(),
      }),
      { wrapper: withBranchSource }
    );
    await waitFor(() =>
      expect(result.current.mode).toBe(DesktopAppCoreMode.Cloud)
    );
    const response = await result.current.branches.collaborators?.([
      provenId,
      missingLaneId,
    ]);
    expect(
      response?.results.map((entry) =>
        entry.artifactType === CollaboratorArtifactType.Branch
          ? [
              entry.artifactId,
              entry.collaborators.sources[
                BranchCollaboratorSource.PullRequestComments
              ],
            ]
          : null
      )
    ).toEqual([
      [provenId, BranchIdentityAvailability.Complete],
      [missingLaneId, BranchIdentityAvailability.Incomplete],
    ]);
  });

  it("keeps both signed-out Local sources unavailable without making a Cloud request", async () => {
    fixtureAuthState = {
      status: DesktopAuthStatus.SignedOut,
      userId: null,
      organizationId: null,
    };
    const { result } = renderHook(
      () => ({
        mode: useDesktopAppCoreMode(),
        sessions: useAgentSessionsDataSource(),
        branches: useBranchesDataSource(),
      }),
      { wrapper: withBranchSource }
    );
    await waitFor(() =>
      expect(result.current.mode).toBe(DesktopAppCoreMode.Local)
    );
    for (const source of [result.current.sessions, result.current.branches]) {
      const response = await source.collaborators?.(["local-a", "local-b"]);
      expect(response?.results).toHaveLength(2);
      for (const item of response?.results ?? []) {
        expect(item.collaborators.availability).toBe(
          BranchIdentityAvailability.Unavailable
        );
        expect(item.collaborators.people).toEqual([]);
        expect(new Set(Object.values(item.collaborators.sources))).toEqual(
          new Set([BranchIdentityAvailability.Unavailable])
        );
      }
    }
    expect(mount.cloudApiFetch).not.toHaveBeenCalled();
  });
  it("mounts the upsync bridge in cloud mode", async () => {
    const { result } = renderHook(() => useDesktopAppCoreMode(), {
      wrapper: DesktopAppCoreProvider,
    });

    await waitFor(() => expect(result.current).toBe(DesktopAppCoreMode.Cloud));
    expect(mount.count).toBeGreaterThan(0);
  });

  it("leaves it out of local mode, where the push bridge already refreshes", async () => {
    restoreOnline = forceOffline();

    const { result } = renderHook(() => useDesktopAppCoreMode(), {
      wrapper: DesktopAppCoreProvider,
    });

    await waitFor(() => expect(result.current).toBe(DesktopAppCoreMode.Local));
    expect(mount.count).toBe(0);
  });
});

/** Offline is one of the three terms that holds the provider on local reads. */
function forceOffline(): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: false,
  });
  return () => {
    if (original) {
      Object.defineProperty(window.navigator, "onLine", original);
    } else {
      Reflect.deleteProperty(window.navigator, "onLine");
    }
  };
}

function withBranchSource({ children }: { children: ReactNode }) {
  return (
    <DesktopAppCoreProvider>
      <DesktopBranchesSource>{children}</DesktopBranchesSource>
    </DesktopAppCoreProvider>
  );
}

function withExceptionReporter({ children }: { children: ReactNode }) {
  return (
    <RendererExceptionReporterProvider reportException={mount.reportException}>
      <DesktopAppCoreProvider>{children}</DesktopAppCoreProvider>
    </RendererExceptionReporterProvider>
  );
}

/** Answers only the exact collaborator batch request; anything else is empty. */
function respondWithCollaborators(
  artifactType: CollaboratorArtifactType,
  ids: readonly string[],
  data: ArtifactCollaboratorBatchResponse
): void {
  mount.cloudApiFetch.mockImplementation((request: CloudApiFetchRequest) => {
    const url = new URL(request.path, "https://api.example.test");
    const matches =
      url.pathname === "/artifacts/collaborators" &&
      url.searchParams.get("artifactType") === artifactType &&
      url.searchParams.getAll("artifactIds").join() === ids.join();
    return Promise.resolve({
      kind: "response",
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      bodyText: JSON.stringify({
        success: true,
        data: matches ? data : { results: [] },
      }),
    });
  });
}
