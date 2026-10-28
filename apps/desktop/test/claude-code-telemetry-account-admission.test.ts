import assert from "node:assert/strict";
import type {
  DesktopClaudeCodeDropCounterInput,
  DesktopClaudeCodeSessionTelemetryInput,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { test } from "vitest";
import {
  type ClaudeCodeTelemetryPendingSession,
  ClaudeCodeTelemetrySyncService,
  type ClaudeCodeTelemetrySyncStore,
} from "../src/main/agent-sync/claude-code-telemetry-sync-service.js";
import {
  createDesktopClaudeCodeTelemetryClient,
  DesktopClaudeCodeTelemetryClientResultKind,
} from "../src/main/dashboard/desktop-claude-code-telemetry-client.js";
import type { ClaudeCodeDropCounterSnapshot } from "../src/main/otel/claude-code-telemetry-rollup.js";
import type { DesktopAccountAdmission } from "../src/main/session/desktop-account-admission.js";

const observedTo = "2026-09-28T00:00:00.000Z";
const accountA: DesktopAccountAdmission = {
  userId: "user-a",
  organizationId: "org-a",
  generation: 1,
};
const accountB: DesktopAccountAdmission = {
  userId: "user-b",
  organizationId: "org-b",
  generation: 2,
};
const sameAccountNextGeneration: DesktopAccountAdmission = {
  ...accountA,
  generation: 2,
};
const session: DesktopClaudeCodeSessionTelemetryInput = {
  externalSessionId: "session-a",
  harness: "claude",
  costEventCount: 1,
  components: [],
};
const pendingSession: ClaudeCodeTelemetryPendingSession = {
  sessionId: "session-a",
  session,
  observedTo,
};
const dropCounter: DesktopClaudeCodeDropCounterInput = {
  harness: "claude",
  reason: "receiver_backpressure",
  droppedCount: "1",
  firstObservedAt: observedTo,
  lastObservedAt: observedTo,
};

type StoreLog = {
  pendingReads: number;
  counterReads: number;
  delivered: number;
  countersDelivered: number;
  sourceKeys: string[];
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

function makeStore(
  loadPending: (
    sourceKey: string
  ) => Promise<ClaudeCodeTelemetryPendingSession[]>,
  loadCounters: () => Promise<ClaudeCodeDropCounterSnapshot>
): { store: ClaudeCodeTelemetrySyncStore; log: StoreLog } {
  const log: StoreLog = {
    pendingReads: 0,
    counterReads: 0,
    delivered: 0,
    countersDelivered: 0,
    sourceKeys: [],
  };
  return {
    log,
    store: {
      loadPendingSessions: (sourceKey) => {
        log.pendingReads += 1;
        log.sourceKeys.push(sourceKey);
        return loadPending(sourceKey);
      },
      loadDropCounters: () => {
        log.counterReads += 1;
        return loadCounters();
      },
      markDropCountersDelivered: () => {
        log.countersDelivered += 1;
        return Promise.resolve();
      },
      recordDelivered: () => {
        log.delivered += 1;
        return Promise.resolve();
      },
      recordRejection: () => Promise.resolve(1),
      recordSessionAbsent: () => Promise.resolve(1),
      recordAbandoned: () => Promise.resolve(),
    },
  };
}

test("accountless Claude telemetry ticks never read or send despite retained target readiness", async () => {
  const { store, log } = makeStore(
    () => Promise.resolve([pendingSession]),
    () => Promise.resolve({ counters: [dropCounter], undelivered: true })
  );
  let sends = 0;
  const service = new ClaudeCodeTelemetrySyncService({
    store: () => store,
    isReady: () => true,
    getAccountAdmission: () => null,
    getComputeTargetId: () => "retained-target",
    sendSession: () => {
      sends += 1;
      return Promise.resolve({
        kind: DesktopClaudeCodeTelemetryClientResultKind.Deferred,
      });
    },
    log: () => undefined,
  });

  await service.syncOnce();

  assert.equal(log.pendingReads, 0);
  assert.equal(log.counterReads, 0);
  assert.equal(sends, 0);
});

for (const readKind of ["pending", "counters"] as const) {
  test(`a ${readKind} DB read crossing sign-out suppresses Claude telemetry egress`, async () => {
    let admission: DesktopAccountAdmission | null = accountA;
    const pendingRead = deferred<ClaudeCodeTelemetryPendingSession[]>();
    const countersRead = deferred<ClaudeCodeDropCounterSnapshot>();
    const countersStarted = deferred<void>();
    const { store, log } = makeStore(
      () =>
        readKind === "pending" ? pendingRead.promise : Promise.resolve([]),
      () => {
        countersStarted.resolve();
        return countersRead.promise;
      }
    );
    let sends = 0;
    const service = new ClaudeCodeTelemetrySyncService({
      store: () => store,
      isReady: () => true,
      getAccountAdmission: () => admission,
      getComputeTargetId: () => "target-a",
      sendSession: () => {
        sends += 1;
        return Promise.resolve({
          kind: DesktopClaudeCodeTelemetryClientResultKind.Deferred,
        });
      },
      log: () => undefined,
    });

    const tick = service.syncOnce();
    if (readKind === "counters") {
      await countersStarted.promise;
    }
    admission = null;
    if (readKind === "pending") {
      pendingRead.resolve([pendingSession]);
    } else {
      countersRead.resolve({ counters: [dropCounter], undelivered: true });
    }
    await tick;

    assert.equal(sends, 0);
    assert.equal(log.delivered, 0);
    assert.equal(log.countersDelivered, 0);
    assert.equal(log.counterReads, readKind === "pending" ? 0 : 1);
  });
}

for (const uploadKind of ["session", "counters-only"] as const) {
  for (const transition of ["sign-out", "account-switch"] as const) {
    test(`${uploadKind} upload held on token resolution cannot cross ${transition}`, async () => {
      let admission: DesktopAccountAdmission | null = accountA;
      let targetId = "target-a";
      let firstToken = true;
      let keyReads = 0;
      const tokenRead = deferred<string | null>();
      const tokenStarted = deferred<void>();
      const requests: string[] = [];
      const { store, log } = makeStore(
        () => Promise.resolve(uploadKind === "session" ? [pendingSession] : []),
        () =>
          Promise.resolve({
            counters: [dropCounter],
            undelivered: true,
          })
      );
      const client = createDesktopClaudeCodeTelemetryClient({
        getAccessToken: () => {
          if (firstToken) {
            firstToken = false;
            tokenStarted.resolve();
            return tokenRead.promise;
          }
          return Promise.resolve("fresh-token");
        },
        getApiKey: () => {
          keyReads += 1;
          return "synthetic-stored-key";
        },
        getApiOrigin: () => "http://127.0.0.1:3002",
        getComputeTargetId: () => targetId,
        fetch: ((input: unknown, init?: RequestInit) => {
          requests.push(`${String(input)} ${String(init?.body)}`);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                accepted: true,
                protocolVersion: 1,
                dropCountersRecorded: 1,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }) as typeof fetch,
      });
      const service = new ClaudeCodeTelemetrySyncService({
        store: () => store,
        isReady: () => true,
        getAccountAdmission: () => admission,
        getComputeTargetId: () => targetId,
        sendSession: (input, canStillSend) =>
          client.syncSession(input, canStillSend),
        log: () => undefined,
      });

      const staleTick = service.syncOnce();
      await tokenStarted.promise;
      admission = transition === "sign-out" ? null : accountB;
      tokenRead.resolve(null);
      await staleTick;

      assert.equal(requests.length, 0);
      assert.equal(keyReads, 0);
      assert.equal(log.delivered, 0);
      assert.equal(log.countersDelivered, 0);

      if (transition === "sign-out") {
        admission = sameAccountNextGeneration;
      } else {
        targetId = "target-b";
      }
      await service.syncOnce();

      assert.equal(requests.length, 1);
      assert.equal(keyReads, 0);
      assert.equal(log.delivered, uploadKind === "session" ? 1 : 0);
      assert.equal(log.countersDelivered, 1);
      assert.ok(requests[0]?.includes(targetId));
      const body = JSON.parse(
        requests[0]?.split(" ").slice(1).join(" ") ?? "{}"
      ) as Record<string, unknown>;
      assert.equal(Object.hasOwn(body, "session"), uploadKind === "session");
    });
  }
}

test("an account switch during acknowledged session settlement leaves counters owed", async () => {
  let admission: DesktopAccountAdmission | null = accountA;
  let targetId = "target-a";
  const entered = deferred<void>();
  const release = deferred<void>();
  const { store, log } = makeStore(
    () => Promise.resolve([pendingSession]),
    () => Promise.resolve({ counters: [dropCounter], undelivered: true })
  );
  const recordDelivered = store.recordDelivered;
  let holdFirst = true;
  store.recordDelivered = async (...args) => {
    if (holdFirst) {
      holdFirst = false;
      entered.resolve();
      await release.promise;
    }
    await recordDelivered(...args);
  };
  const service = new ClaudeCodeTelemetrySyncService({
    store: () => store,
    isReady: () => true,
    getAccountAdmission: () => admission,
    getComputeTargetId: () => targetId,
    sendSession: () =>
      Promise.resolve({
        kind: DesktopClaudeCodeTelemetryClientResultKind.Ack,
        ack: {
          accepted: true,
          protocolVersion: 1,
          externalSessionId: pendingSession.sessionId,
          dropCountersRecorded: 1,
        },
      }),
    log: () => undefined,
  });

  const oldTick = service.syncOnce();
  await entered.promise;
  admission = accountB;
  targetId = "target-b";
  release.resolve();
  await oldTick;
  assert.equal(log.delivered, 1);
  assert.equal(log.countersDelivered, 0);

  await service.syncOnce();
  assert.equal(log.countersDelivered, 1);
  assert.ok(log.sourceKeys.some((key) => key.includes("target-b")));
});

for (const uploadKind of ["session", "counters-only"] as const) {
  for (const heldAt of ["post", "json"] as const) {
    for (const transition of ["sign-out", "account-switch"] as const) {
      test(`${uploadKind} ACK held at ${heldAt} cannot advance delivery across ${transition}`, async () => {
        let admission: DesktopAccountAdmission | null = accountA;
        let requests = 0;
        const entered = deferred<void>();
        const responseReady = deferred<Response>();
        const jsonReady = deferred<unknown>();
        const ack = {
          accepted: true,
          protocolVersion: 1,
          dropCountersRecorded: 1,
          ...(uploadKind === "session"
            ? { externalSessionId: pendingSession.sessionId }
            : {}),
        };
        const client = createDesktopClaudeCodeTelemetryClient({
          getAccessToken: () => Promise.resolve("synthetic-access-token"),
          getApiOrigin: () => "http://127.0.0.1:3002",
          getComputeTargetId: () => "target-a",
          fetch: (() => {
            requests += 1;
            if (requests > 1) {
              return Promise.resolve(Response.json(ack));
            }
            if (heldAt === "post") {
              entered.resolve();
              return responseReady.promise;
            }
            const response = Response.json(ack);
            Object.defineProperty(response, "json", {
              value: () => {
                entered.resolve();
                return jsonReady.promise;
              },
            });
            return Promise.resolve(response);
          }) as typeof fetch,
        });
        const { store, log } = makeStore(
          () =>
            Promise.resolve(uploadKind === "session" ? [pendingSession] : []),
          () => Promise.resolve({ counters: [dropCounter], undelivered: true })
        );
        const outcomes: string[] = [];
        const service = new ClaudeCodeTelemetrySyncService({
          store: () => store,
          isReady: () => true,
          getAccountAdmission: () => admission,
          getComputeTargetId: () => "target-a",
          sendSession: async (input, canStillSend) => {
            const result = await client.syncSession(input, canStillSend);
            outcomes.push(result.kind);
            return result;
          },
          log: () => undefined,
        });

        const staleTick = service.syncOnce();
        await entered.promise;
        admission = transition === "sign-out" ? null : accountB;
        if (heldAt === "post") {
          responseReady.resolve(Response.json(ack));
        } else {
          jsonReady.resolve(ack);
        }
        await staleTick;

        assert.equal(requests, 1);
        assert.deepEqual(outcomes, [
          DesktopClaudeCodeTelemetryClientResultKind.Deferred,
        ]);
        assert.equal(log.delivered, 0);
        assert.equal(log.countersDelivered, 0);

        admission =
          transition === "sign-out" ? sameAccountNextGeneration : accountB;
        await service.syncOnce();
        assert.equal(requests, 2);
        assert.equal(log.delivered, uploadKind === "session" ? 1 : 0);
        assert.equal(log.countersDelivered, 1);
      });
    }
  }
}
