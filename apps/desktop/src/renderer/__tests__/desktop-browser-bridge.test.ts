import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopBrowserBridgeErrorReason,
  desktopBrowserBridgeEvent,
  desktopBrowserBridgePayloadTooLargeMessage,
  desktopBrowserBridgeRequestTooLargeMessage,
} from "../../shared/desktop-browser-bridge-contract.mjs";
import {
  applyBrowserClientLocalApi,
  connectDesktopBrowserBridgeClient,
  createDesktopApiClient,
  DesktopBrowserBridgeError,
  takeBridgeTokenFromUrl,
} from "../desktop-browser-bridge";
import { selectReadOnlyDesktopApi } from "../desktop-browser-bridge-projection";
import {
  answerLastRequest,
  callbackFor,
  currentSocket,
  flushHostRequest,
  invokeFrame,
  invokeRemoteFrame,
  lastCallbackId,
  lastResponsePayload,
  requestCount,
} from "./desktop-browser-bridge-fake-socket";
import {
  cloudRelayFor,
  connectFakeHost,
  connectReadClient,
  connectSubscribingClient,
  createHostApiStub,
  isStillPending,
  issueLaunchToken,
  OVER_LIMIT_PAYLOAD_LENGTH,
  readManifest,
  resetBridgeDocument,
  subscriptionManifest,
} from "./desktop-browser-bridge-harness";

vi.mock("socket.io-client", async () => {
  const { io } = await import("./desktop-browser-bridge-fake-socket");
  return { io };
});

describe("desktop browser bridge client", () => {
  it("keeps subscription cleanup synchronous across the async bridge", async () => {
    const remoteUnsubscribe = vi.fn();
    const invoke = vi.fn(() => Promise.resolve(remoteUnsubscribe));
    const desktopApi = createDesktopApiClient(subscriptionManifest, invoke) as {
      onDbChanged: (onChange: () => void) => () => void;
    };

    const unsubscribe = desktopApi.onDbChanged(() => undefined);
    expect(unsubscribe).toBeTypeOf("function");
    await Promise.resolve();
    unsubscribe();

    expect(invoke).toHaveBeenCalledWith({
      args: [expect.any(Function)],
      kind: "invoke",
      path: ["onDbChanged"],
    });
    expect(remoteUnsubscribe).toHaveBeenCalledOnce();
  });

  it("releases a subscription that closes before setup resolves", async () => {
    let resolveSetup: (value: unknown) => void = () => undefined;
    const setupPromise = new Promise<unknown>((resolve) => {
      resolveSetup = resolve;
    });
    const remoteUnsubscribe = vi.fn();
    const desktopApi = createDesktopApiClient(
      subscriptionManifest,
      () => setupPromise
    ) as {
      onDbChanged: (onChange: () => void) => () => void;
    };

    const unsubscribe = desktopApi.onDbChanged(() => undefined);
    unsubscribe();
    resolveSetup(remoteUnsubscribe);
    await setupPromise;
    await Promise.resolve();

    expect(remoteUnsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps ordinary read methods promise-based", async () => {
    const invoke = vi.fn(() => Promise.resolve({ theme: "dark" }));
    const desktopApi = createDesktopApiClient(readManifest, invoke) as {
      getSettings: () => Promise<{ theme: string }>;
    };

    await expect(desktopApi.getSettings()).resolves.toEqual({ theme: "dark" });
    expect(invoke).toHaveBeenCalledWith({
      args: [],
      kind: "invoke",
      path: ["getSettings"],
    });
  });
});

describe("desktop browser bridge launch token", () => {
  beforeEach(() => {
    globalThis.sessionStorage.clear();
  });

  it("takes the token off the URL, keeps it for the tab, and reuses it on reload", () => {
    globalThis.history.replaceState(
      null,
      "",
      "/design-system/browser.html?closedloopBridgeToken=reader-token#/sessions"
    );

    expect(takeBridgeTokenFromUrl("client")).toBe("reader-token");
    // Off the address bar, so the credential stops riding in a copyable URL —
    // without disturbing the hash the desktop renderer routes on.
    expect(globalThis.location.search).toBe("");
    expect(globalThis.location.hash).toBe("#/sessions");
    // A reload arrives with no query at all and must still connect.
    expect(takeBridgeTokenFromUrl("client")).toBe("reader-token");
  });

  it("does not let one role's token answer for the other", () => {
    issueLaunchToken("reader-token");

    expect(takeBridgeTokenFromUrl("client")).toBe("reader-token");
    expect(takeBridgeTokenFromUrl("host")).toBe("");
  });

  it("reports no token when the document was opened without one", () => {
    globalThis.history.replaceState(null, "", "/design-system/browser.html");

    // This is the process that only fetched the served assets: nothing in them
    // carries a token, so it has nothing to present at the handshake.
    expect(takeBridgeTokenFromUrl("client")).toBe("");
  });
});

describe("desktop browser bridge capability surface", () => {
  it("bridges the sync-consent read so the mirror can see and change its sync level", () => {
    const selected = selectReadOnlyDesktopApi(createHostApiStub());

    // The read source stopped consulting consent on 2026-09-25, so this entry no
    // longer decides the mirror's stack. It is still required: `hasSyncConsentBridge()`
    // probes exactly this method, and without it the store settles to a null record,
    // which leaves the consent takeover gate and the Settings sync panel rendering a
    // device whose level cannot be read or changed.
    expect(selected.getSyncConsentRecord).toBeTypeOf("function");
  });

  // ISS-9857: the sidecar mirror hand-enumerates its read-only method paths, so
  // without this entry the mirrored renderer's local source would see
  // `undefined` for `eventsPage` on a host that HAS it.
  it("projects the events page read so the mirrored renderer can page past the prefix", () => {
    const selected = selectReadOnlyDesktopApi(createHostApiStub()) as {
      agentSessionsApi: Record<string, unknown>;
    };

    expect(selected.agentSessionsApi.eventsPage).toBeTypeOf("function");
  });

  // The channel is OPTIONAL in the preload contract: a mirrored renderer can
  // run against an installed build that predates it, and that host must keep
  // every read it does have rather than lose the whole bridge to one missing
  // method. The mirror then lacks the key, which the local source turns into an
  // absent `eventsPage` and the transcript panel into "no continuation".
  it("still projects a host whose preload predates the events page read, leaving the key absent", () => {
    const { eventsPage: _eventsPage, ...withoutEventsPage } =
      createHostApiStub().agentSessionsApi as Record<string, unknown>;
    const selected = selectReadOnlyDesktopApi(
      createHostApiStub({ agentSessionsApi: withoutEventsPage })
    ) as { agentSessionsApi: Record<string, unknown> };

    expect(selected.agentSessionsApi.detail).toBeTypeOf("function");
    expect(Object.hasOwn(selected.agentSessionsApi, "eventsPage")).toBe(false);
  });

  it("relays an ordinary cloud read but denies the transcript endpoint", async () => {
    const cloudApiFetch = vi.fn(() => Promise.resolve({ status: 200 }));
    const relay = cloudRelayFor(cloudApiFetch);

    await expect(relay({ path: "/agent-sessions/s-1" })).resolves.toEqual({
      status: 200,
    });
    expect(() => relay({ path: "/agent-sessions/s-1/transcript" })).toThrow(
      TRANSCRIPT_DENIAL_PATTERN
    );
    expect(() =>
      relay({ path: "/agent-sessions/s-1/transcript?download=1" })
    ).toThrow(TRANSCRIPT_DENIAL_PATTERN);
    expect(cloudApiFetch).toHaveBeenCalledTimes(1);
  });

  it("denies the transcript endpoint on the resolved pathname, not the raw string", async () => {
    const cloudApiFetch = vi.fn(() => Promise.resolve({ status: 200 }));
    const relay = cloudRelayFor(cloudApiFetch);

    for (const path of [
      "/agent-sessions/abc/transcript",
      "/agent-sessions/abc/foo/../transcript",
      "/agent-sessions/abc/x/%2e%2e/transcript",
      "/agent-sessions/abc/transcript/.",
    ]) {
      expect(() => relay({ path }), path).toThrow(TRANSCRIPT_DENIAL_PATTERN);
    }
    expect(cloudApiFetch).not.toHaveBeenCalled();

    for (const path of [
      "/agent-sessions/abc/foo/../summary",
      "/prefix/agent-sessions/abc/transcript",
      "/agent-sessions/abc/transcripts",
      "//[",
    ]) {
      await expect(relay({ path }), path).resolves.toEqual({ status: 200 });
      expect(cloudApiFetch).toHaveBeenLastCalledWith({ method: "GET", path });
    }
    expect(cloudApiFetch).toHaveBeenCalledTimes(4);
  });

  it("answers the auth mutators locally so sidecar controls cannot throw", async () => {
    const desktopApi: Record<string, unknown> = {
      getDesktopAuthState: () => Promise.resolve({ status: "signed_out" }),
    };

    applyBrowserClientLocalApi(desktopApi);

    const beginSignIn = desktopApi.beginDesktopSignIn as () => Promise<unknown>;
    const cancelSignIn =
      desktopApi.cancelDesktopSignIn as () => Promise<unknown>;
    const signOut = desktopApi.signOutDesktop as () => Promise<unknown>;
    await expect(beginSignIn()).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(cancelSignIn()).resolves.toBeUndefined();
    await expect(signOut()).resolves.toBeUndefined();
  });
});

describe("desktop browser bridge client lifecycle", () => {
  beforeEach(() => {
    resetBridgeDocument("reader-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("mounts the tab when the host arrives after the ready window elapses", async () => {
    vi.useFakeTimers();
    const onHostSlow = vi.fn();
    const connecting = connectDesktopBrowserBridgeClient({ onHostSlow });
    const socket = currentSocket();
    socket.deliver("connect", undefined);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(onHostSlow).toHaveBeenCalledTimes(1);
    // Still waiting rather than rejected: the launcher prints the URL before
    // Electron has finished starting, and a rejection here strands the tab.
    expect(await isStillPending(connecting)).toBe(true);

    socket.deliver(desktopBrowserBridgeEvent.manifest, readManifest);
    const desktopApi = (await connecting) as Record<string, unknown>;
    expect(desktopApi.getSettings).toBeTypeOf("function");
  });

  it("ignores a manifest deeper than the broker accepts, then mounts a valid one", async () => {
    const connecting = connectDesktopBrowserBridgeClient();
    const socket = currentSocket();
    socket.deliver("connect", undefined);

    socket.deliver(desktopBrowserBridgeEvent.manifest, overDeepManifest());
    // Settle every microtask first: `Promise.resolve` wins a bare race even
    // against an ALREADY-resolved promise, which would make this vacuous.
    await flushHostRequest();
    expect(await isStillPending(connecting)).toBe(true);

    socket.deliver(desktopBrowserBridgeEvent.manifest, readManifest);
    const desktopApi = (await connecting) as Record<string, unknown>;
    expect(desktopApi.getSettings).toBeTypeOf("function");
  });

  it("tells a size refusal apart from a dead host and from a real timeout", async () => {
    vi.useFakeTimers();
    const { read, socket } = await connectReadClient();

    const overLimit = read().catch((error: unknown) => error);
    answerLastRequest(socket, {
      error: {
        message: desktopBrowserBridgePayloadTooLargeMessage,
        reason: desktopBrowserBridgeErrorReason.PayloadTooLarge,
      },
    });
    const sizeError = await overLimit;

    const unavailable = read().catch((error: unknown) => error);
    answerLastRequest(socket, {
      error: {
        message: "Desktop browser bridge host is unavailable",
        reason: desktopBrowserBridgeErrorReason.HostUnavailable,
      },
    });
    const unavailableError = await unavailable;

    const stalled = read().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(31_000);
    const timeoutError = await stalled;

    expect(sizeError).toBeInstanceOf(DesktopBrowserBridgeError);
    expect((sizeError as DesktopBrowserBridgeError).reason).toBe(
      desktopBrowserBridgeErrorReason.PayloadTooLarge
    );
    expect((unavailableError as DesktopBrowserBridgeError).reason).toBe(
      desktopBrowserBridgeErrorReason.HostUnavailable
    );
    expect((timeoutError as DesktopBrowserBridgeError).reason).toBe(
      desktopBrowserBridgeErrorReason.Timeout
    );
  });

  it("refuses an over-size request itself instead of putting it on the wire", async () => {
    const { read, socket } = await connectReadClient();
    const sentBefore = requestCount(socket);

    const refusing = read({
      rows: "x".repeat(OVER_LIMIT_PAYLOAD_LENGTH),
    }).catch((error: unknown) => error);

    // Asserted BEFORE the await, so a lost refusal fails here rather than
    // hanging until the runner's own timeout. Nothing reached the wire, so the
    // transport never sees the frame that would close this tab's own socket and
    // report a disconnect instead of a size. The guard also returns before the
    // promise body, so no 30s window is armed either — but a settled promise
    // cannot show that from out here, and this assertion does not pin it.
    expect(requestCount(socket)).toBe(sentBefore);

    const refused = await refusing;
    expect(refused).toBeInstanceOf(DesktopBrowserBridgeError);
    expect((refused as DesktopBrowserBridgeError).reason).toBe(
      desktopBrowserBridgeErrorReason.PayloadTooLarge
    );
    expect((refused as DesktopBrowserBridgeError).message).toBe(
      desktopBrowserBridgeRequestTooLargeMessage
    );
    // The sibling: a normal-sized request still reaches the wire and answers.
    const settling = read({ rows: [] });
    expect(requestCount(socket)).toBe(sentBefore + 1);
    answerLastRequest(socket, { result: { rows: [] } });
    expect(await settling).toEqual({ rows: [] });
  });

  it("resumes pushes after the host restarts while the tab's socket stays up", async () => {
    const { socket, subscribe } = await connectSubscribingClient();
    const onChange = vi.fn();
    subscribe(onChange);

    const firstCallbackId = lastCallbackId(socket);
    socket.deliver(
      desktopBrowserBridgeEvent.callback,
      callbackFor(firstCallbackId)
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    // An Electron renderer reload: the host went away and came back, and this
    // socket never noticed. Its remote functions were released, so the id the
    // tab still holds refers to nothing.
    socket.deliver(desktopBrowserBridgeEvent.hostDisconnected, undefined);
    socket.deliver(
      desktopBrowserBridgeEvent.callback,
      callbackFor(firstCallbackId)
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    socket.deliver(desktopBrowserBridgeEvent.manifest, subscriptionManifest);
    const secondCallbackId = lastCallbackId(socket);
    expect(secondCallbackId).not.toBe(firstCallbackId);
    socket.deliver(
      desktopBrowserBridgeEvent.callback,
      callbackFor(secondCallbackId)
    );
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("resumes pushes after the tab's own socket reconnects", async () => {
    const { socket, subscribe } = await connectSubscribingClient();
    const onChange = vi.fn();
    subscribe(onChange);

    const firstCallbackId = lastCallbackId(socket);
    socket.deliver("disconnect", undefined);
    socket.deliver(
      desktopBrowserBridgeEvent.callback,
      callbackFor(firstCallbackId)
    );
    expect(onChange).not.toHaveBeenCalled();

    // The broker hands a rejoining client the manifest it already holds.
    socket.deliver("connect", undefined);
    socket.deliver(desktopBrowserBridgeEvent.manifest, subscriptionManifest);
    const secondCallbackId = lastCallbackId(socket);
    expect(secondCallbackId).not.toBe(firstCallbackId);
    socket.deliver(
      desktopBrowserBridgeEvent.callback,
      callbackFor(secondCallbackId)
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("desktop browser bridge host", () => {
  beforeEach(() => {
    resetBridgeDocument("host-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses an over-size response itself instead of putting it on the wire", async () => {
    // The broker's own refusal cannot cover this: an over-size frame trips
    // engine.io's `maxHttpBufferSize` on the way IN, which closes the single
    // host socket and takes every connected tab down with it, and the
    // correlated refusal is never emitted at all. So the host answers the
    // request it could not answer, on a socket that is still up.
    // `getAllFlags` deliberately, not one of the two projected reads: a record
    // projection could strip the bulk and leave this asserting a payload that
    // was never over-size by the time it reached the emit.
    const { disconnect, socket } = connectFakeHost({
      getAllFlags: () =>
        Promise.resolve({ oversized: "x".repeat(OVER_LIMIT_PAYLOAD_LENGTH) }),
    });

    socket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeFrame("getAllFlags", "request-oversized")
    );
    await flushHostRequest();

    const response = lastResponsePayload(socket);
    expect(response.requestId).toBe("request-oversized");
    expect(response.error).toEqual({
      message: desktopBrowserBridgePayloadTooLargeMessage,
      reason: desktopBrowserBridgeErrorReason.PayloadTooLarge,
    });
    expect(response.result).toBeUndefined();
    disconnect();
  });

  it("releases the subscriptions it holds when its own socket reconnects", async () => {
    // A reconnect re-broadcasts the manifest, which every still-open tab answers
    // by re-subscribing — so the pre-drop records are superseded. Nothing else
    // retires them: `clientDisconnected` never fires for a tab that stayed open.
    const unsubscribe = vi.fn();
    const { disconnect, socket } = connectFakeHost({
      onDbChanged: () => unsubscribe,
    });

    socket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeFrame("onDbChanged", "request-subscribe")
    );
    await flushHostRequest();
    const subscribed = lastResponsePayload(socket).result as {
      remoteFunctionId: string;
    };
    expect(unsubscribe).not.toHaveBeenCalled();

    socket.deliver("connect", undefined);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    // And the record is GONE, not merely cleaned up — a map that still held it
    // would answer this with the unsubscribe a second time.
    socket.deliver(
      desktopBrowserBridgeEvent.request,
      invokeRemoteFrame(subscribed.remoteFunctionId, "request-stale")
    );
    await flushHostRequest();

    const stale = lastResponsePayload(socket);
    expect(stale.requestId).toBe("request-stale");
    expect((stale.error as { reason: string }).reason).toBe(
      desktopBrowserBridgeErrorReason.HostError
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    disconnect();
  });
});

describe("desktop browser bridge record projection", () => {
  it("mirrors exactly the runtime-status and settings fields the renderer reads", async () => {
    const selected = selectReadOnlyDesktopApi(
      createHostApiStub({
        getRuntimeStatus: () => Promise.resolve(hostRuntimeStatus),
        getSettings: () => Promise.resolve(hostSettings),
      })
    );

    const runtimeStatus = await (
      selected.getRuntimeStatus as () => Promise<unknown>
    )();
    const settings = await (selected.getSettings as () => Promise<unknown>)();

    // Written out rather than derived from the allowlists they police: a
    // projection that DROPS a field the mirrored UI reads is as much a defect
    // as one that leaks a field it does not.
    expect(runtimeStatus).toEqual({
      agentMonitor: { kind: "ok" },
      cloudReadReadiness: { importComplete: true },
      cloudStatus: { state: "online" },
      cloudSync: { caughtUp: true },
      connectionSecurity: { mode: "standard" },
      fileAccessBlocks: [],
      gatewayHealthy: true,
      ingest: { complete: true },
      isPackaged: false,
      maintenance: { active: false },
      port: 19_432,
      serverAlive: true,
    });
    expect(settings).toEqual({
      activeConfigId: "config-1",
      // The approval rules and both sandbox roots DO cross: the mirrored
      // Approvals panel and the sandbox cards render them, so withholding them
      // would break the surfaces this mirror exists to show. Only the fields no
      // consumer reads are withheld — asserted by their absence here.
      alwaysAllowRules: [{ id: "rule-1", scopePath: "/private/var/scope" }],
      apiOrigin: "https://api.example.test",
      relayOrigin: "https://relay.example.test",
      sandboxBaseDirectory: "/private/var/sandbox-root",
      // Narrowed at the NESTED level too, not merely allowed through by key.
      // `apiKeySource`, `computeTarget`, `gatewayPublicKey`, `onboardingState`
      // and `port` are on the fixture profile and absent here — an outer-level
      // allowlist alone would have carried all five into a browser tab, and
      // `apiKeySource` would also have survived a nested set derived from
      // `GatewayProfileRowData` rather than from the renderer's read sites.
      savedConfigs: [
        {
          apiOrigin: "https://api.example.test",
          hasCloudApiKey: true,
          id: "config-1",
          name: "Primary",
          relayOrigin: "https://relay.example.test",
          sandboxBaseDirectory: "/private/var/profile-sandbox",
          webAppOrigin: "https://app.example.test",
        },
      ],
      verboseLogging: true,
      webAppOrigin: "https://app.example.test",
    });
  });
});

const TRANSCRIPT_DENIAL_PATTERN =
  /^Desktop browser bridge does not relay transcript reads$/;
/** Every field the projection allows through, plus the ones it must withhold. */
const hostRuntimeStatus = {
  agentMonitor: { kind: "ok" },
  apiOrigin: "https://api.example.test",
  cloudReadReadiness: { importComplete: true },
  cloudStatus: { state: "online" },
  cloudSync: { caughtUp: true },
  commandsPaused: false,
  connectionEnabled: true,
  connectionSecurity: { mode: "standard" },
  dashboardReady: true,
  fileAccessBlocks: [],
  gatewayHealthy: true,
  ingest: { complete: true },
  isPackaged: false,
  maintenance: { active: false },
  port: 19_432,
  relayOrigin: "https://relay.example.test",
  sandboxBaseDirectory: "/private/var/sandbox-root",
  serverAlive: true,
};
const hostSettings = {
  activeConfigId: "config-1",
  alwaysAllowRules: [{ id: "rule-1", scopePath: "/private/var/scope" }],
  apiOrigin: "https://api.example.test",
  autoApprovalRules: [{ id: "auto-1" }],
  binaryPaths: { claude: "/usr/local/bin/claude" },
  defaultApprovalTier: "auto",
  relayOrigin: "https://relay.example.test",
  managedKeyHintLastSeenProvenance: "managed",
  sandboxBaseDirectory: "/private/var/sandbox-root",
  savedConfigs: [
    {
      apiOrigin: "https://api.example.test",
      hasCloudApiKey: true,
      id: "config-1",
      name: "Primary",
      relayOrigin: "https://relay.example.test",
      sandboxBaseDirectory: "/private/var/profile-sandbox",
      webAppOrigin: "https://app.example.test",
      // Everything below is what a saved profile ALSO carries and no mirrored
      // surface reads. Present here so the nested projection has something to
      // withhold — without them the assertion below passes on an unprojected
      // entry and proves nothing. `apiKeySource` sits here rather than above
      // because it is declared on `GatewayProfileRowData` and read by no
      // renderer: being on the type is not being consumed.
      apiKeySource: "keychain",
      computeTarget: { id: "compute-1", region: "us-east-1" },
      gatewayPublicKey: "gateway-public-key",
      onboardingState: { completed: true },
      port: 4820,
    },
  ],
  verboseLogging: true,
  webAppOrigin: "https://app.example.test",
};

/** One level past `desktopBrowserBridgeLimits.manifestDepth`. */
function overDeepManifest(): unknown {
  let node: unknown = { kind: "method" };
  for (let depth = 0; depth <= 13; depth += 1) {
    node = { entries: { nested: node }, kind: "object" };
  }
  return node;
}
