/**
 * @file agent-session-sync-relay-disconnect-capabilities.test.ts
 * @description ISS-12068: a relay disconnect while HTTP sync stays up under the
 * retained compute target. The monitored-activity capability is part of the
 * session lane's source key, so capabilities that vanish with the socket re-key
 * the lane and re-walk the corpus; held across the disconnect (Perrin Upcott
 * ruling, 2026-10-06) they re-send nothing the cloud already holds.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";
import ts from "typescript6";
import { test } from "vitest";
import {
  capabilitiesFromHelloAck,
  createNegotiatedSessionSyncCapabilities,
  NO_AGENT_SESSION_SYNC_CAPABILITIES,
  SessionSyncCapability,
  syncCapabilityAccessors,
} from "../src/main/agent-sync/agent-session-sync-capabilities.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import {
  buildAgentSessionSyncSourceKey,
  type SyncedSessionLoadOptions,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { createSessionSyncIdentityAdapter } from "../src/main/agent-sync/retained-compute-target-identity.js";
import type { SignedInUserIdentity } from "../src/main/util/user-identity.js";
import { CloudSocketState } from "../src/shared/cloud-socket-error.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { settleSelfContinuedDrain } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";
import {
  forEachNode,
  parseTypeScriptFile,
  propertyAccessPair,
  propertyInitializer,
} from "./helpers/ts-ast.js";

const TARGET = "iss12068-target";
const API_ORIGIN = "https://api.example.test";
const OTHER_API_ORIGIN = "https://api.other.example.test";
const ACCOUNT: SignedInUserIdentity = {
  organizationId: "org-1",
  userId: "user-1",
};
const OTHER_ACCOUNT: SignedInUserIdentity = {
  organizationId: "org-2",
  userId: "user-2",
};
const CAPABLE_SERVER: ComputeTargetServerCapabilities = {
  agentSessionSync: true,
  agentSessionSyncMonitoredActivity: true,
};
const ROLLED_BACK_SERVER: ComputeTargetServerCapabilities = {
  agentSessionSync: true,
};
const CORPUS = ["session-a", "session-b", "session-c"];
const SESSION_UPDATED_WHILE_DISCONNECTED = "session-d";
const V2_KEY = buildAgentSessionSyncSourceKey(TARGET, true);
const BASE_KEY = buildAgentSessionSyncSourceKey(TARGET);

/** Records, per session load, whether the lane asked for the newer-server shape. */
class ShapeRecordingSource extends FakeSyncSource {
  readonly loads: Array<{ id: string; monitoredActivity: boolean }> = [];

  override loadSyncedSessions(
    ids: string[],
    _cache?: unknown,
    options?: SyncedSessionLoadOptions
  ) {
    const monitoredActivity = options?.includeMonitoredSessionActivity === true;
    for (const id of ids) {
      this.loads.push({ id, monitoredActivity });
    }
    return super.loadSyncedSessions(ids);
  }
}

/**
 * The lane as `app.ts` composes it: the retained-target adapter, the negotiated
 * capability holder handed that adapter, and the capability accessors built on
 * the holder. `bindTo: "online-socket"` is the pre-fix semantics — capabilities
 * that exist only while the socket is up, which is what resetting them on every
 * disconnect amounted to.
 */
function composeRelayLane(bindTo: "sync-target" | "online-socket") {
  let socketTarget: string | null = null;
  let identity: SignedInUserIdentity | null = ACCOUNT;
  let apiOrigin = API_ORIGIN;
  const syncIdentity = createSessionSyncIdentityAdapter({
    getIdentity: () => identity,
    getAuthStatus: () => DesktopAuthStatus.Authenticated,
    getApiOrigin: () => apiOrigin,
    getCloudStatus: () =>
      socketTarget
        ? { state: CloudSocketState.Online, targetId: socketTarget }
        : { state: CloudSocketState.Idle },
  });
  const capabilities = createNegotiatedSessionSyncCapabilities(
    bindTo === "sync-target"
      ? syncIdentity
      : { computeTargetId: () => syncIdentity.onlineComputeTargetId() }
  );
  const source = new ShapeRecordingSource(
    CORPUS.map((id) => makeSyncedSession(id, "2026-10-06T08:00:00.000Z"))
  );
  const sentIds: string[] = [];
  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => syncIdentity.isHttpReady(),
    getSource: () => source,
    getSyncComputeTargetId: () => syncIdentity.computeTargetId(),
    ...syncCapabilityAccessors(() => capabilities.current()),
    sendBatch: (batch) => {
      sentIds.push(...batch.sessions.map((s) => s.externalSessionId));
      return Promise.resolve({ accepted: true });
    },
  };
  const service = new AgentSessionSyncService(options);
  const settle = async () => {
    service.refresh();
    await service.whenSessionSyncSettled();
    await settleSelfContinuedDrain(service);
  };
  return {
    service,
    source,
    sentIds,
    capabilities,
    settle,
    liveSourceKey: () => SessionSyncCapability.sourceKey(options),
    /** `onHelloAck`, then the online status `onCloudSocketStatus` remembers. */
    helloAck: async (serverCapabilities: ComputeTargetServerCapabilities) => {
      capabilities.recordHelloAck(TARGET, serverCapabilities);
      socketTarget = TARGET;
      syncIdentity.remember({ targetId: TARGET });
      await settle();
    },
    /** `onDisconnect`: the socket is gone, the retained target and HTTP are not. */
    relayDisconnect: async () => {
      socketTarget = null;
      await settle();
    },
    signInAs: (next: SignedInUserIdentity) => {
      identity = next;
    },
    pointAt: (origin: string) => {
      apiOrigin = origin;
    },
  };
}

/** Drain under a capable server, drop the relay, update one session, reconnect. */
async function runDisconnectCycle(bindTo: "sync-target" | "online-socket") {
  const lane = composeRelayLane(bindTo);
  lane.service.start();
  try {
    await lane.helloAck(CAPABLE_SERVER);
    const initial = lane.sentIds.splice(0);
    await lane.relayDisconnect();
    const keyWhileDisconnected = lane.liveSourceKey();
    lane.source.upsert(
      makeSyncedSession(
        SESSION_UPDATED_WHILE_DISCONNECTED,
        "2026-10-06T09:00:00.000Z"
      )
    );
    await lane.settle();
    const whileDisconnected = lane.sentIds.splice(0);
    await lane.helloAck(CAPABLE_SERVER);
    return {
      initial,
      keyWhileDisconnected,
      whileDisconnected,
      afterReconnect: lane.sentIds.splice(0),
    };
  } finally {
    lane.service.stop();
  }
}

test("ISS-12068: capabilities that vanish with the socket re-key the lane and re-walk the corpus on a relay disconnect", async () => {
  const cycle = await runDisconnectCycle("online-socket");

  assert.deepEqual(cycle.initial.toSorted(), CORPUS);
  assert.equal(
    cycle.keyWhileDisconnected,
    BASE_KEY,
    "the disconnect moved the lane off the key it drained under"
  );
  assert.deepEqual(
    cycle.whileDisconnected.toSorted(),
    [...CORPUS, SESSION_UPDATED_WHILE_DISCONNECTED],
    "the whole corpus the cloud already holds went out again"
  );
});

test("ISS-12068: a relay disconnect and reconnect re-send nothing the cloud already holds", async () => {
  const cycle = await runDisconnectCycle("sync-target");

  assert.deepEqual(cycle.initial.toSorted(), CORPUS);
  assert.deepEqual(
    cycle.whileDisconnected,
    [SESSION_UPDATED_WHILE_DISCONNECTED],
    "HTTP sync stays up through the disconnect and sends only what changed"
  );
  assert.equal(cycle.keyWhileDisconnected, V2_KEY);
  assert.deepEqual(cycle.afterReconnect, []);
});

test("ISS-12068: a server rolled back during a disconnect gets the newer shape until its hello ack, then everything in its own", async () => {
  const lane = composeRelayLane("sync-target");
  lane.service.start();
  try {
    await lane.helloAck(CAPABLE_SERVER);
    await lane.relayDisconnect();
    lane.source.upsert(
      makeSyncedSession(
        SESSION_UPDATED_WHILE_DISCONNECTED,
        "2026-10-06T09:00:00.000Z"
      )
    );
    await lane.settle();
    assert.deepEqual(
      lane.source.loads.filter(
        (load) => load.id === SESSION_UPDATED_WHILE_DISCONNECTED
      ),
      [{ id: SESSION_UPDATED_WHILE_DISCONNECTED, monitoredActivity: true }],
      "the accepted window: sent in the shape the last handshake negotiated"
    );
    lane.source.loads.splice(0);
    lane.sentIds.splice(0);

    await lane.helloAck(ROLLED_BACK_SERVER);

    assert.deepEqual(
      lane.capabilities.current(),
      capabilitiesFromHelloAck(ROLLED_BACK_SERVER)
    );
    assert.equal(lane.liveSourceKey(), BASE_KEY);
    assert.deepEqual(
      lane.sentIds.toSorted(),
      [...CORPUS, SESSION_UPDATED_WHILE_DISCONNECTED],
      "the rolled-back server is re-sent every session, the window's included"
    );
    assert.deepEqual(
      [...new Set(lane.source.loads.map((load) => load.monitoredActivity))],
      [false]
    );
  } finally {
    lane.service.stop();
  }
});

test("ISS-12068: held capabilities read None under another account or environment", async () => {
  const lane = composeRelayLane("sync-target");
  lane.service.start();
  try {
    await lane.helloAck(CAPABLE_SERVER);
    await lane.relayDisconnect();
    const negotiated = capabilitiesFromHelloAck(CAPABLE_SERVER);
    assert.deepEqual(lane.capabilities.current(), negotiated);

    lane.signInAs(OTHER_ACCOUNT);
    assert.deepEqual(
      lane.capabilities.current(),
      NO_AGENT_SESSION_SYNC_CAPABILITIES
    );

    lane.signInAs(ACCOUNT);
    lane.pointAt(OTHER_API_ORIGIN);
    assert.deepEqual(
      lane.capabilities.current(),
      NO_AGENT_SESSION_SYNC_CAPABILITIES
    );
  } finally {
    lane.service.stop();
  }
});

/**
 * `app.ts` imports `electron`, so no node test can drive it, and the suites
 * above compose the holder by hand. This is the sanctioned AST guard (as in
 * `desktop-connection-lifecycle-analytics.test.ts`) for the three production
 * lines they cannot reach.
 */
test("ISS-12068: app.ts binds the holder to the sync target, records each hello ack, and leaves it alone on disconnect", () => {
  const app = parseTypeScriptFile(
    fileURLToPath(new URL("../src/main/app.ts", import.meta.url))
  );
  const onHelloAck = propertyInitializer(app, "onHelloAck");
  const onDisconnect = propertyInitializer(app, "onDisconnect");
  assert.ok(onHelloAck && onDisconnect);

  assert.deepEqual(holderCalls(onHelloAck), [
    "recordHelloAck(event.computeTargetId, event.serverCapabilities)",
  ]);
  assert.equal(holderReferences(onHelloAck), 1);
  assert.equal(
    holderReferences(onDisconnect),
    0,
    "a disconnect must not touch the negotiated capabilities"
  );
  assert.deepEqual(holderConstructionArguments(app), [
    ["this.sessionSyncIdentity"],
  ]);
});

const HOLDER_FIELD = "sessionSyncCapabilities";

function isThisMember(node: ts.Node, member: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    node.name.text === member
  );
}

function describeArgument(node: ts.Node): string {
  const pair = propertyAccessPair(node);
  if (pair) {
    return `${pair.receiver}.${pair.member}`;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return `this.${node.name.text}`;
  }
  return "<expression>";
}

/** Every `this.sessionSyncCapabilities.<method>(...)` call under `root`. */
function holderCalls(root: ts.Node): string[] {
  const calls: string[] = [];
  forEachNode(root, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isThisMember(node.expression.expression, HOLDER_FIELD)
    ) {
      const args = node.arguments.map(describeArgument).join(", ");
      calls.push(`${node.expression.name.text}(${args})`);
    }
  });
  return calls;
}

/** Every reference to `this.sessionSyncCapabilities` under `root`, of any kind. */
function holderReferences(root: ts.Node): number {
  let count = 0;
  forEachNode(root, (node) => {
    if (isThisMember(node, HOLDER_FIELD)) {
      count += 1;
    }
  });
  return count;
}

/** The arguments of every `sessionSyncCapabilities` field initializer. */
function holderConstructionArguments(app: ts.SourceFile): string[][] {
  const found: string[][] = [];
  forEachNode(app, (node) => {
    if (
      ts.isPropertyDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === HOLDER_FIELD &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      found.push(node.initializer.arguments.map(describeArgument));
    }
  });
  return found;
}
