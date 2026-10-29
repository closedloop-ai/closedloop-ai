import assert from "node:assert/strict";
import type { RealtimeClient } from "@repo/realtime-client/connection";
import { RealtimeStatus } from "@repo/realtime-client/port";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { test, vi } from "vitest";
import { DesktopRealtimeHost } from "../src/main/realtime/desktop-realtime-host.js";
import type { DesktopAccountAdmission } from "../src/main/session/desktop-account-admission.js";
import { reconcileDesktopAccountChange } from "../src/main/session/desktop-account-lifecycle.js";

const ADMISSION = {
  userId: "user-1",
  organizationId: "org-1",
  generation: 1,
};
const NEXT_ADMISSION = {
  userId: "user-2",
  organizationId: "org-1",
  generation: 2,
};
const CHANNEL = formatChannelAddress(
  ChannelKind.Comments,
  "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  ["artifact-1"]
);

test("an admitted account reconciles realtime before the cloud restarts", () => {
  const calls: string[] = [];
  reconcileDesktopAccountChange(ADMISSION, recordingDeps(calls));

  assert.deepEqual(calls, ["reconcile-realtime", "restart-cloud"]);
});

test("the realtime socket follows the account across a switch and a sign-out", () => {
  const harness = createRealtimeHarness(ADMISSION);
  harness.host.join({ id: 1, send: () => undefined }, CHANNEL);
  const [first] = harness.clients;

  harness.state.admission = NEXT_ADMISSION;
  reconcileDesktopAccountChange(NEXT_ADMISSION, {
    ...recordingDeps([]),
    realtime: harness.host,
  });

  assert.equal(first?.close.mock.calls.length, 1);
  assert.equal(harness.clients.length, 2, "held channels move to the new one");

  harness.state.admission = null;
  reconcileDesktopAccountChange(null, {
    ...recordingDeps([]),
    realtime: harness.host,
  });

  assert.equal(harness.clients[1]?.close.mock.calls.length, 1);
  assert.equal(harness.clients.length, 2, "a sign-out builds no client");
});

function recordingDeps(calls: string[]) {
  return {
    clearOrgDirectory: () => calls.push("clear-directory"),
    stopCloud: () => calls.push("stop-cloud"),
    realtime: {
      stop: () => calls.push("stop-realtime"),
      reconcileAccount: () => calls.push("reconcile-realtime"),
    },
    forgetSessionSyncIdentity: () => calls.push("forget-sync"),
    mayRestartCloud: () => true,
    restartCloud: () => calls.push("restart-cloud"),
  };
}

function createRealtimeHarness(initial: DesktopAccountAdmission) {
  const clients: (RealtimeClient & { close: ReturnType<typeof vi.fn> })[] = [];
  const state: { admission: DesktopAccountAdmission | null } = {
    admission: initial,
  };
  const host = new DesktopRealtimeHost({
    getAccountAdmission: () => state.admission,
    fetchToken: () => Promise.resolve({ token: "t", expiresAt: 1 }),
    clientVersion: "test",
    createClient: () => {
      let status: RealtimeStatus = RealtimeStatus.Connecting;
      const client = {
        join: () => () => undefined,
        status: () => status,
        onStatus: () => () => undefined,
        close: vi.fn(() => {
          status = RealtimeStatus.Closed;
        }),
      };
      clients.push(client);
      return client;
    },
  });
  return { clients, host, state };
}
