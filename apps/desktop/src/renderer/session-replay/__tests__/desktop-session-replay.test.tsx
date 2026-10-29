import {
  DESKTOP_SESSION_REPLAY_FLAG_KEY,
  type DesktopFeatureFlagAssignment,
} from "@repo/api/src/types/desktop-feature-flags";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { DesktopFeatureFlagProvider } from "../../feature-flags/desktop-feature-flag-provider";
import { __resetRuntimeStatusPollForTests } from "../../hooks/use-runtime-status-poll";
import { RECORD_ID_ROUTE_PATTERNS } from "../../navigation/route-table";
import { DesktopAuthProvider } from "../../shared-agent-sessions/desktop-auth-provider";
import { DesktopSessionReplay } from "../desktop-session-replay";

const replayClient = vi.hoisted(() => ({
  startDesktopSessionReplay: vi.fn(),
  stopDesktopSessionReplay: vi.fn(),
  discardDesktopSessionReplay: vi.fn(),
  waitForSentDesktopReplayBatches: vi.fn(),
}));

vi.mock("@repo/analytics/desktop-session-replay", () => replayClient);

// Lets a case hold the gate open across a sign-in or sign-out, which on its own
// closes and reopens the gate, so the restart it sees is the signed-in key's.
const gate = vi.hoisted(() => ({ heldOpen: false }));

vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (importOriginal) => {
    const actual = await importOriginal<{
      useFeatureFlagEnabled: (key: string) => boolean;
    }>();
    return {
      ...actual,
      useFeatureFlagEnabled: (key: string) => {
        const enabled = actual.useFeatureFlagEnabled(key);
        return gate.heldOpen || enabled;
      },
    };
  }
);

// Literals, not the shared constants: these origins are the ISS-11946 contract.
const PROD_API_ORIGIN = "https://api.closedloop.ai";
const STAGE_API_ORIGIN = "https://api.stage.example";
const LOCAL_API_ORIGIN = "http://localhost:3002";
const NODE_UUID = "2f1c8f8e-3b7a-4c1d-9e2f-5a6b7c8d9e0f";
const SIGNED_IN_USER_ID = "user_desktop_1";
const SIGNED_IN_STATE = {
  status: DesktopAuthStatus.Authenticated,
  userId: SIGNED_IN_USER_ID,
  organizationId: "org_1",
};
const SIGNED_OUT_STATE = {
  status: DesktopAuthStatus.SignedOut,
  userId: null,
  organizationId: null,
};

let originalDesktopApiDescriptor: PropertyDescriptor | undefined;

describe("DesktopSessionReplay (ISS-11838)", () => {
  beforeEach(() => {
    originalDesktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    replayClient.startDesktopSessionReplay.mockReset();
    replayClient.stopDesktopSessionReplay.mockReset();
    replayClient.discardDesktopSessionReplay.mockReset();
    replayClient.waitForSentDesktopReplayBatches
      .mockReset()
      .mockResolvedValue(undefined);
    gate.heldOpen = false;
  });

  afterEach(() => {
    cleanup();
    __resetRuntimeStatusPollForTests();
    if (originalDesktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", originalDesktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it.each([
    ["signed in", SIGNED_IN_USER_ID],
    ["signed out", null],
  ])(
    "never loads the replay client while the gate is closed (%s)",
    async (_label, authedUserId) => {
      const bridge = installDesktopApi({
        authedUserId,
        replayFlag: false,
        apiOrigin: PROD_API_ORIGIN,
      });

      renderReplay();

      await waitFor(() =>
        expect(bridge.getDesktopFeatureFlags).toHaveBeenCalled()
      );
      // The closed verdict has landed and every effect it triggers has run.
      await act(() => bridge.getDesktopFeatureFlags.mock.results[0]?.value);
      expect(replayClient.startDesktopSessionReplay).not.toHaveBeenCalled();
      expect(bridge.getRuntimeStatus).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["signed in, against prod", SIGNED_IN_USER_ID, PROD_API_ORIGIN],
    ["signed out, against prod", null, PROD_API_ORIGIN],
    ["signed in, against stage", SIGNED_IN_USER_ID, STAGE_API_ORIGIN],
  ])(
    "records under the install's node_uuid while the gate is open (%s)",
    async (_label, authedUserId, apiOrigin) => {
      const bridge = installDesktopApi({
        authedUserId,
        replayFlag: true,
        apiOrigin,
      });

      renderReplay();

      await waitFor(() =>
        expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(1)
      );
      expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledWith({
        apiHost: `${apiOrigin}/r`,
        distinctId: NODE_UUID,
        recordIdRoutes: RECORD_ID_ROUTE_PATTERNS,
      });
      // ISS-12257: main refuses replay batches until it hears this.
      await waitFor(() =>
        expect(bridge.reportDesktopReplayRecording.mock.calls).toEqual([
          [
            {
              signedIn: authedUserId !== null,
              authGeneration: bridge.initialAuthGeneration,
            },
          ],
        ])
      );
      expect(replayClient.discardDesktopSessionReplay).not.toHaveBeenCalled();
    }
  );

  it("stops recording when the gate closes", async () => {
    const bridge = installDesktopApi({
      authedUserId: SIGNED_IN_USER_ID,
      replayFlag: true,
      apiOrigin: PROD_API_ORIGIN,
    });
    renderReplay();
    await waitFor(() =>
      expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(1)
    );

    // Signing out hands the gate to the install's own assignment, closed here.
    bridge.setReplayFlag(false);
    bridge.pushAuthState(SIGNED_OUT_STATE);

    await waitFor(() =>
      expect(replayClient.stopDesktopSessionReplay).toHaveBeenCalledTimes(1)
    );
    expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["signs in", null, SIGNED_IN_STATE],
    ["signs out", SIGNED_IN_USER_ID, SIGNED_OUT_STATE],
  ])(
    "discards the old recording, then restarts under the same node_uuid, when the install %s (ISS-12222, ISS-12257)",
    async (_label, authedUserId, nextAuthState) => {
      const bridge = installDesktopApi({
        authedUserId,
        replayFlag: true,
        apiOrigin: PROD_API_ORIGIN,
      });
      renderReplay();
      await waitFor(() =>
        expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(1)
      );
      gate.heldOpen = true;

      bridge.pushAuthState(nextAuthState);

      await waitFor(() =>
        expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(2)
      );
      const target = {
        apiHost: `${PROD_API_ORIGIN}/r`,
        distinctId: NODE_UUID,
        recordIdRoutes: RECORD_ID_ROUTE_PATTERNS,
      };
      expect(replayClient.startDesktopSessionReplay.mock.calls).toEqual([
        [target],
        [target],
      ]);
      expect(replayClient.stopDesktopSessionReplay).toHaveBeenCalledTimes(1);
      expect(
        replayClient.stopDesktopSessionReplay.mock.invocationCallOrder[0]
      ).toBeLessThan(
        replayClient.startDesktopSessionReplay.mock.invocationCallOrder[1] ?? 0
      );
      // The old session's unsent batches are dropped, not flushed by the stop.
      expect(replayClient.discardDesktopSessionReplay).toHaveBeenCalledTimes(1);
      expect(
        replayClient.discardDesktopSessionReplay.mock.invocationCallOrder[0]
      ).toBeLessThan(
        replayClient.stopDesktopSessionReplay.mock.invocationCallOrder[0] ?? 0
      );
      await waitFor(() =>
        expect(bridge.reportDesktopReplayRecording.mock.calls).toEqual([
          [
            {
              signedIn: authedUserId !== null,
              authGeneration: bridge.initialAuthGeneration,
            },
          ],
          [
            {
              signedIn: authedUserId === null,
              authGeneration: bridge.initialAuthGeneration + 1,
            },
          ],
        ])
      );
    }
  );

  it("tells main about the restarted recording only once the old recording's sent batches are answered (ISS-12257)", async () => {
    const bridge = installDesktopApi({
      authedUserId: null,
      replayFlag: true,
      apiOrigin: PROD_API_ORIGIN,
    });
    renderReplay();
    await waitFor(() =>
      expect(bridge.reportDesktopReplayRecording).toHaveBeenCalledTimes(1)
    );
    gate.heldOpen = true;
    let answerSentBatches: () => void = () => undefined;
    replayClient.waitForSentDesktopReplayBatches.mockReturnValue(
      new Promise<void>((resolve) => {
        answerSentBatches = resolve;
      })
    );

    bridge.pushAuthState(SIGNED_IN_STATE);

    await waitFor(() =>
      expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(2)
    );
    // The snapshot of batches in flight is taken before the new recording can
    // add its own.
    expect(
      replayClient.waitForSentDesktopReplayBatches.mock.invocationCallOrder[1]
    ).toBeLessThan(
      replayClient.startDesktopSessionReplay.mock.invocationCallOrder[1] ?? 0
    );
    expect(bridge.reportDesktopReplayRecording.mock.calls).toEqual([
      [{ signedIn: false, authGeneration: 0 }],
    ]);

    answerSentBatches();

    await waitFor(() =>
      expect(bridge.reportDesktopReplayRecording.mock.calls).toEqual([
        [{ signedIn: false, authGeneration: 0 }],
        [{ signedIn: true, authGeneration: 1 }],
      ])
    );
  });

  // The renderer hears only the last of main's sign-out and sign-in, so its
  // sign-in state never changes and the recording is not restarted.
  it("discards, and reports the auth generation its recording started under, after main flips away and back unheard (ISS-12257)", async () => {
    const bridge = installDesktopApi({
      authedUserId: null,
      replayFlag: true,
      apiOrigin: PROD_API_ORIGIN,
    });
    renderReplay();
    await waitFor(() =>
      expect(bridge.reportDesktopReplayRecording).toHaveBeenCalledTimes(1)
    );
    gate.heldOpen = true;
    let answerSentBatches: () => void = () => undefined;
    replayClient.waitForSentDesktopReplayBatches.mockReturnValue(
      new Promise<void>((resolve) => {
        answerSentBatches = resolve;
      })
    );
    act(() => bridge.pushAuthState(SIGNED_IN_STATE));
    await waitFor(() =>
      expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(2)
    );

    act(() => bridge.pushAuthState(SIGNED_IN_STATE, 2));

    expect(replayClient.discardDesktopSessionReplay).toHaveBeenCalledTimes(2);
    answerSentBatches();

    await waitFor(() =>
      expect(bridge.reportDesktopReplayRecording).toHaveBeenCalledTimes(2)
    );
    expect(bridge.reportDesktopReplayRecording.mock.calls).toEqual([
      [{ signedIn: false, authGeneration: 0 }],
      [{ signedIn: true, authGeneration: 1 }],
    ]);
  });

  it("does not record until main's auth state carries its auth generation (ISS-12257)", async () => {
    const bridge = installDesktopApi({
      authedUserId: null,
      replayFlag: true,
      apiOrigin: PROD_API_ORIGIN,
      authGeneration: null,
    });
    renderReplay();
    await waitFor(() =>
      expect(bridge.getDesktopFeatureFlags).toHaveBeenCalled()
    );
    await act(() => bridge.getDesktopFeatureFlags.mock.results[0]?.value);
    expect(replayClient.startDesktopSessionReplay).not.toHaveBeenCalled();

    act(() => bridge.pushAuthState(SIGNED_OUT_STATE, 0));

    await waitFor(() =>
      expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(1)
    );
  });

  it.each([
    ["a local API origin", { apiOrigin: LOCAL_API_ORIGIN }],
    ["a runtime status from a main without node_uuid", { nodeUuid: null }],
  ])("does not record against %s", async (_label, overrides) => {
    const bridge = installDesktopApi({
      authedUserId: SIGNED_IN_USER_ID,
      replayFlag: true,
      apiOrigin: PROD_API_ORIGIN,
      ...overrides,
    });

    renderReplay();

    await waitFor(() => expect(bridge.getRuntimeStatus).toHaveBeenCalled());
    // The start path read this reply before the test's own continuation runs.
    await act(() => bridge.getRuntimeStatus.mock.results[0]?.value);
    expect(replayClient.startDesktopSessionReplay).not.toHaveBeenCalled();
  });

  // Applying a saved profile changes the API origin without reloading the
  // renderer; the shared runtime-status poll picks it up within a second.
  it("stops recording when the API origin changes to one that does not record", async () => {
    const bridge = installDesktopApi({
      authedUserId: null,
      replayFlag: true,
      apiOrigin: PROD_API_ORIGIN,
    });
    renderReplay();
    await waitFor(() =>
      expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(1)
    );

    bridge.setApiOrigin(LOCAL_API_ORIGIN);

    await waitFor(
      () =>
        expect(replayClient.stopDesktopSessionReplay).toHaveBeenCalledTimes(1),
      { timeout: 3000 }
    );
    expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(1);
    // ISS-12257 AC3: outside a sign-in flip the stop still flushes.
    expect(replayClient.discardDesktopSessionReplay).not.toHaveBeenCalled();
  }, 10_000);

  it("stops, then starts against the new origin, when it changes between replay origins", async () => {
    const bridge = installDesktopApi({
      authedUserId: null,
      replayFlag: true,
      apiOrigin: PROD_API_ORIGIN,
    });
    renderReplay();
    await waitFor(() =>
      expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(1)
    );

    bridge.setApiOrigin(STAGE_API_ORIGIN);

    await waitFor(
      () =>
        expect(replayClient.startDesktopSessionReplay).toHaveBeenCalledTimes(2),
      { timeout: 3000 }
    );
    expect(replayClient.startDesktopSessionReplay).toHaveBeenLastCalledWith({
      apiHost: `${STAGE_API_ORIGIN}/r`,
      distinctId: NODE_UUID,
      recordIdRoutes: RECORD_ID_ROUTE_PATTERNS,
    });
    expect(replayClient.stopDesktopSessionReplay).toHaveBeenCalledTimes(1);
    expect(
      replayClient.stopDesktopSessionReplay.mock.invocationCallOrder[0]
    ).toBeLessThan(
      replayClient.startDesktopSessionReplay.mock.invocationCallOrder[1] ?? 0
    );
    expect(replayClient.discardDesktopSessionReplay).not.toHaveBeenCalled();
  }, 10_000);
});

function renderReplay() {
  return render(
    <DesktopAuthProvider>
      <DesktopFeatureFlagProvider>
        <DesktopSessionReplay />
      </DesktopFeatureFlagProvider>
    </DesktopAuthProvider>
  );
}

/**
 * `authGeneration` is main's auth generation at launch: 1 once restored signed
 * in, 0 signed out, or null for a state that carries none.
 */
function installDesktopApi(options: {
  authedUserId: string | null;
  replayFlag: boolean;
  apiOrigin: string;
  nodeUuid?: string | null;
  authGeneration?: number | null;
}) {
  let replayFlag = options.replayFlag;
  let apiOrigin = options.apiOrigin;
  const authListeners: Array<(next: unknown) => void> = [];
  const initialAuthGeneration =
    options.authGeneration ?? (options.authedUserId ? 1 : 0);
  let authGeneration = initialAuthGeneration;
  const authState = {
    ...(options.authedUserId
      ? { ...SIGNED_IN_STATE, userId: options.authedUserId }
      : SIGNED_OUT_STATE),
    ...(options.authGeneration === null ? {} : { authGeneration }),
  };
  const bridge = {
    getDesktopAuthState: vi.fn(() => Promise.resolve(authState)),
    onDesktopAuthStateChanged: vi.fn((onChange: (next: unknown) => void) => {
      authListeners.push(onChange);
      return () => {
        authListeners.splice(authListeners.indexOf(onChange), 1);
      };
    }),
    // The signed-in read answers for the account; the signed-out (ISS-11945)
    // read answers for the install's node_uuid.
    getDesktopFeatureFlags: vi.fn(
      (): Promise<DesktopFeatureFlagAssignment> =>
        Promise.resolve({
          userId: options.authedUserId ?? NODE_UUID,
          resolved: true,
          flags: { [DESKTOP_SESSION_REPLAY_FLAG_KEY]: replayFlag },
        })
    ),
    reportDesktopReplayRecording: vi.fn((_recording: unknown) =>
      Promise.resolve(true)
    ),
    getRuntimeStatus: vi.fn(() =>
      Promise.resolve({
        isPackaged: true,
        apiOrigin,
        ...(options.nodeUuid === null
          ? {}
          : { nodeUuid: options.nodeUuid ?? NODE_UUID }),
      })
    ),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: bridge,
  });
  return {
    ...bridge,
    initialAuthGeneration,
    setReplayFlag(next: boolean) {
      replayFlag = next;
    },
    setApiOrigin(next: string) {
      apiOrigin = next;
    },
    /** `flips`: how many of main's sign-in flips led to `next`, heard or not. */
    pushAuthState(
      next: {
        status: string;
        userId: string | null;
        organizationId: string | null;
      },
      flips = 1
    ) {
      authGeneration += flips;
      for (const listener of [...authListeners]) {
        listener({ ...next, authGeneration });
      }
    },
  };
}
