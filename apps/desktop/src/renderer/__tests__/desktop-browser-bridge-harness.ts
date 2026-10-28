import { vi } from "vitest";
import { desktopBrowserBridgeEvent } from "../../shared/desktop-browser-bridge-contract.mjs";
import {
  connectDesktopBrowserBridgeClient,
  connectDesktopBrowserBridgeHost,
} from "../desktop-browser-bridge";
import { selectReadOnlyDesktopApi } from "../desktop-browser-bridge-projection";
import {
  currentSocket,
  type FakeBridgeSocket,
  openedSockets,
} from "./desktop-browser-bridge-fake-socket";

export const readManifest = {
  entries: { getSettings: { kind: "method" } },
  kind: "object",
} as const;

export const subscriptionManifest = {
  entries: { onDbChanged: { kind: "method" } },
  kind: "object",
} as const;

/** Comfortably past the bridge cap, so either side refuses before the emit. */
export const OVER_LIMIT_PAYLOAD_LENGTH = 3 * 1024 * 1024;

const PENDING = Symbol("pending");

/**
 * A stand-in for the trusted preload surface. The method names are spelled out
 * here as wire literals rather than read from the bridge's own allowlist, so a
 * path ADDED to that allowlist fails these tests: the stub stops satisfying
 * `selectReadOnlyDesktopApi` and it throws. A path DROPPED from the allowlist
 * is not caught here; the client-side manifests below are hand-written, not
 * derived from it, so a dropped path just stops being selected.
 */
export function createHostApiStub(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const method = () => () => Promise.resolve(undefined);
  const group = (names: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(names.map((name) => [name, method()]));

  return {
    agentSessionsApi: group([
      "analytics",
      "detail",
      "eventsPage",
      "list",
      "pageData",
      "usage",
    ]),
    branchesApi: group([
      "analytics",
      "cohortAnalytics",
      "detail",
      "list",
      "pageData",
      "trace",
      "usage",
    ]),
    cloudApiFetch: method(),
    db: group([
      "getAgentHierarchy",
      "getAgents",
      "getAnalytics",
      "getDashboardSummary",
      "getEventCountByType",
      "getEventFeed",
      "getEvents",
      "getEventsWithSession",
      "getInsights",
      "getKanbanPages",
      "getPrList",
      "getPrSessions",
      "getPrStats",
      "getSession",
      "getSessionDetails",
      "getSessions",
      "getSessionsPage",
      "getSessionsWithDetails",
      "getTokenAnalytics",
    ]),
    macOSMajorVersion: 15,
    platform: "darwin",
    ...group([
      "getAllFlags",
      "getDesktopAuthState",
      "getDesktopIdentity",
      "getGitHubIntegrationStatus",
      "getRuntimeStatus",
      "getSettings",
      "getSyncConsentRecord",
      "onDbChanged",
      "onDesktopAuthStateChanged",
      "onFlagsChanged",
      "onSyncConsentRecordChanged",
    ]),
    ...overrides,
  };
}

/** The projection's cloud read relay over a host carrying this fetch. */
export function cloudRelayFor(
  cloudApiFetch: (...args: unknown[]) => unknown
): (request: unknown) => Promise<unknown> {
  return selectReadOnlyDesktopApi(createHostApiStub({ cloudApiFetch }))
    .cloudApiFetch as (request: unknown) => Promise<unknown>;
}

/** Put a launch token on the URL the way the launcher opens the document. */
export function issueLaunchToken(token: string): void {
  globalThis.history.replaceState(
    null,
    "",
    `/design-system/browser.html?closedloopBridgeToken=${token}`
  );
}

/** A fresh document on a bridge-enabled build, opened with this launch token. */
export function resetBridgeDocument(token: string): void {
  openedSockets.length = 0;
  vi.stubEnv("VITE_DESKTOP_BROWSER_BRIDGE_ENABLED", "1");
  globalThis.sessionStorage.clear();
  issueLaunchToken(token);
}

export function connectFakeHost(overrides: Record<string, unknown> = {}): {
  disconnect: () => void;
  socket: FakeBridgeSocket;
} {
  const disconnect = connectDesktopBrowserBridgeHost(
    createHostApiStub(overrides)
  );
  const socket = currentSocket();
  socket.deliver("connect", undefined);
  return { disconnect, socket };
}

export async function connectFakeClient(
  manifest: unknown
): Promise<Record<string, unknown>> {
  const connecting = connectDesktopBrowserBridgeClient();
  const socket = currentSocket();
  socket.deliver("connect", undefined);
  socket.deliver(desktopBrowserBridgeEvent.manifest, manifest);
  return (await connecting) as Record<string, unknown>;
}

/** A client mounted on `readManifest`, with its one read and its socket. */
export async function connectReadClient(): Promise<{
  read: (...args: unknown[]) => Promise<unknown>;
  socket: FakeBridgeSocket;
}> {
  const desktopApi = await connectFakeClient(readManifest);
  return {
    read: desktopApi.getSettings as (...args: unknown[]) => Promise<unknown>,
    socket: currentSocket(),
  };
}

/** A client mounted on `subscriptionManifest`, with its one subscription. */
export async function connectSubscribingClient(): Promise<{
  socket: FakeBridgeSocket;
  subscribe: (listener: (...args: unknown[]) => void) => () => void;
}> {
  const desktopApi = await connectFakeClient(subscriptionManifest);
  return {
    socket: currentSocket(),
    subscribe: desktopApi.onDbChanged as (
      listener: (...args: unknown[]) => void
    ) => () => void,
  };
}

/**
 * Whether the promise has settled yet. Races the RAW promise: a `.catch`
 * derivative would read as pending even after a rejection.
 */
export async function isStillPending(
  promise: Promise<unknown>
): Promise<boolean> {
  const winner = await Promise.race([promise, Promise.resolve(PENDING)]);
  return winner === PENDING;
}
