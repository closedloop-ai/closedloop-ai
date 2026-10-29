import { request } from "node:http";
import {
  RelayDispatchDiagnosticReason,
  RelayDispatchMetadataLimit,
  RelayDispatchReason,
} from "@repo/api/src/types/relay-dispatch";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { workersByTargetId } from "../worker-registry.js";
import { reserveTestPort } from "./helpers/reserve-test-port.js";

const TEST_PORT = await reserveTestPort(29_000, 1500);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

const REMOTE_TARGET_ID = "remote-target";
const REMOTE_INSTANCE_ID = "other-instance";
const REMOTE_PRIVATE_IP = "10.0.0.5";
// Every relay task listens on the same port; the egress allowlist requires the
// peer port to equal this instance's RELAY_PORT, so mirror the test port here.
const REMOTE_PORT = TEST_PORT;

// A target registered to an instance that has no instance-info in the registry
// (simulates a SCAN/lookup race where the instance record expired).
const DANGLING_TARGET_ID = "dangling-target";
const DANGLING_INSTANCE_ID = "dangling-instance";

// A target whose registry-supplied instance info carries a public (non-VPC) IP,
// which the SSRF guard should reject.
const SSRF_TARGET_ID = "ssrf-target";
const SSRF_INSTANCE_ID = "ssrf-instance";
const SSRF_PRIVATE_IP = "1.2.3.4"; // public IP → isRoutablePrivateIpv4 = false

// A target the registry attributes to THIS relay instance. Outside redis mode
// initializeTargetRegistry returns before resolveInstanceId runs, so the
// instance id stays at its module default.
const LOCAL_TARGET_ID = "local-owned-target";
const LOCAL_INSTANCE_ID = "unknown";
const STALE_LOCAL_TARGET_ID = "same-instance-owner-token-mismatch-target";
const TARGET_LOOKUP_ERROR_TARGET_ID = "target-lookup-error-target";
const TARGET_UNREADABLE_TARGET_ID = "target-unreadable-target";
const INSTANCE_LOOKUP_ERROR_TARGET_ID = "instance-lookup-error-target";
const INSTANCE_LOOKUP_ERROR_INSTANCE_ID = "instance-lookup-error-instance";
const INSTANCE_UNREADABLE_TARGET_ID = "instance-unreadable-target";
const INSTANCE_UNREADABLE_INSTANCE_ID = "instance-unreadable-instance";

const mockDeregister = vi.hoisted(() => vi.fn().mockResolvedValue(true));

let baseUrl: string;
let stopRelay: (() => Promise<void>) | null = null;

vi.mock("socket.io", () => {
  const mockNamespace = { use: vi.fn(), on: vi.fn() };
  return {
    Server: class MockServer {
      // Engine.IO stub: index.ts attaches a `connection_error` listener to
      // `io.engine` at module load, so a Server double without one crashes on import.
      engine = { on: vi.fn() };
      of() {
        return mockNamespace;
      }
      close() {
        return Promise.resolve();
      }
    },
  };
});

// Inject a registry that resolves the target to a different relay instance,
// forcing handleDispatch down the cross-instance proxy path.
vi.mock("../target-registry.js", () => {
  const RegistryLookupOutcome = {
    Found: "found",
    Missing: "missing",
    Unreadable: "unreadable",
    Error: "error",
  } as const;
  const TargetRegistryBackend = {
    InMemory: "in_memory",
    Redis: "redis",
  } as const;
  const ReclaimOutcome = {
    Reclaimed: "reclaimed",
    Refused: "refused",
    Error: "error",
  } as const;
  const RegistryOperation = {
    Reclaim: "reclaim",
  } as const;
  const remoteTarget = {
    instanceId: REMOTE_INSTANCE_ID,
    socketId: "sock-remote",
    ownerToken: "owner-token-remote",
    organizationId: "org-1",
    userId: "user-1",
    connectedAt: 0,
  };
  const remoteInstance = {
    privateIp: REMOTE_PRIVATE_IP,
    port: REMOTE_PORT,
    startedAt: 0,
  };
  const danglingTarget = {
    instanceId: DANGLING_INSTANCE_ID,
    socketId: "sock-dangling",
    ownerToken: "owner-token-dangling",
    organizationId: "org-1",
    userId: "user-1",
    connectedAt: 0,
  };

  const localTarget = {
    instanceId: LOCAL_INSTANCE_ID,
    socketId: "sock-local",
    ownerToken: "owner-token-local",
    organizationId: "org-1",
    userId: "user-1",
    connectedAt: 0,
  };

  const staleLocalTarget = {
    instanceId: LOCAL_INSTANCE_ID,
    socketId: "sock-stale-local",
    ownerToken: "registry-owner-token",
    organizationId: "org-1",
    userId: "user-1",
    connectedAt: 0,
  };

  const ssrfTarget = {
    instanceId: SSRF_INSTANCE_ID,
    socketId: "sock-ssrf",
    ownerToken: "owner-token-ssrf",
    organizationId: "org-1",
    userId: "user-1",
    connectedAt: 0,
  };

  const instanceLookupErrorTarget = {
    instanceId: INSTANCE_LOOKUP_ERROR_INSTANCE_ID,
    socketId: "sock-instance-error",
    ownerToken: "owner-token-instance-error",
    organizationId: "org-1",
    userId: "user-1",
    connectedAt: 0,
  };

  const instanceUnreadableTarget = {
    instanceId: INSTANCE_UNREADABLE_INSTANCE_ID,
    socketId: "sock-instance-unreadable",
    ownerToken: "owner-token-instance-unreadable",
    organizationId: "org-1",
    userId: "user-1",
    connectedAt: 0,
  };

  const ssrfInstance = {
    privateIp: SSRF_PRIVATE_IP,
    port: REMOTE_PORT,
    startedAt: 0,
  };

  // Deliberately a VALID, allowlisted peer record: without it, a dropped
  // local-instance short-circuit would still bail at the missing instance
  // lookup and the "no fetch" assertion below would pass for the wrong reason.
  const localInstance = {
    privateIp: REMOTE_PRIVATE_IP,
    port: REMOTE_PORT,
    startedAt: 0,
  };

  class MockTargetRegistry {
    readonly backend = TargetRegistryBackend.Redis;

    register() {
      return Promise.resolve(true);
    }
    lookup(targetId: string) {
      if (targetId === REMOTE_TARGET_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Found,
          metadata: remoteTarget,
        });
      }
      if (targetId === DANGLING_TARGET_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Found,
          metadata: danglingTarget,
        });
      }
      if (targetId === SSRF_TARGET_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Found,
          metadata: ssrfTarget,
        });
      }
      if (targetId === LOCAL_TARGET_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Found,
          metadata: localTarget,
        });
      }
      if (targetId === STALE_LOCAL_TARGET_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Found,
          metadata: staleLocalTarget,
        });
      }
      if (targetId === TARGET_LOOKUP_ERROR_TARGET_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Error,
          error: new Error("lookup failed"),
        });
      }
      if (targetId === TARGET_UNREADABLE_TARGET_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Unreadable,
        });
      }
      if (targetId === INSTANCE_LOOKUP_ERROR_TARGET_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Found,
          metadata: instanceLookupErrorTarget,
        });
      }
      if (targetId === INSTANCE_UNREADABLE_TARGET_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Found,
          metadata: instanceUnreadableTarget,
        });
      }
      return Promise.resolve({ outcome: RegistryLookupOutcome.Missing });
    }
    deregister(targetId: string, ownerToken: string) {
      return mockDeregister(targetId, ownerToken);
    }
    refreshTtl() {
      return Promise.resolve(true);
    }
    reclaim() {
      return Promise.resolve({ outcome: ReclaimOutcome.Reclaimed });
    }
    deregisterAllByInstance() {
      return Promise.resolve(0);
    }
    registerInstance() {
      return Promise.resolve();
    }
    lookupInstance(instanceId: string) {
      if (instanceId === REMOTE_INSTANCE_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Found,
          info: remoteInstance,
        });
      }
      if (instanceId === SSRF_INSTANCE_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Found,
          info: ssrfInstance,
        });
      }
      if (instanceId === LOCAL_INSTANCE_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Found,
          info: localInstance,
        });
      }
      if (instanceId === INSTANCE_LOOKUP_ERROR_INSTANCE_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Error,
          error: new Error("instance lookup failed"),
        });
      }
      if (instanceId === INSTANCE_UNREADABLE_INSTANCE_ID) {
        return Promise.resolve({
          outcome: RegistryLookupOutcome.Unreadable,
        });
      }
      // DANGLING_INSTANCE_ID intentionally has no instance record.
      return Promise.resolve({ outcome: RegistryLookupOutcome.Missing });
    }
    deregisterInstance() {
      return Promise.resolve();
    }
  }
  return {
    InMemoryTargetRegistry: MockTargetRegistry,
    RegistryLookupOutcome,
    RegistryOperation,
    ReclaimOutcome,
    RedisTargetRegistry: MockTargetRegistry,
    TargetRegistryBackend,
  };
});

const fetchMock = vi.fn();

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.RELAY_PORT = String(TEST_PORT);
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  vi.stubGlobal("fetch", fetchMock);

  const relayModule = await import("../index");
  await relayModule.startRelayServer("127.0.0.1");
  stopRelay = relayModule.stopRelayServer;

  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
}, 30_000);

beforeEach(() => {
  fetchMock.mockReset();
  mockDeregister.mockClear();
});

afterAll(async () => {
  if (stopRelay) {
    await stopRelay();
  }
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

function dispatch(targetId: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${baseUrl}/dispatch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": TEST_SECRET,
        },
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.write(JSON.stringify({ targetId, operation: { commandId: "cmd-1" } }));
    req.end();
  });
}

describe("cross-instance dispatch proxying", () => {
  it("proxies to the owning instance and returns its result", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ delivered: true }),
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ delivered: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(calledUrl).toBe(
      `http://${REMOTE_PRIVATE_IP}:${REMOTE_PORT}/internal/dispatch`
    );
    expect(calledInit.headers["x-internal-secret"]).toBe(TEST_SECRET);
    expect(JSON.parse(calledInit.body).targetId).toBe(REMOTE_TARGET_ID);
  });

  it("never proxies a target this instance already owns (ISS-7976)", async () => {
    // ISS-7612/ISS-7976 moved tryProxyDispatch into proxy-dispatch.ts, which
    // turned the relay's own instance id from a closed-over module binding
    // into an argument. Nothing pinned that the call site still passes it, so
    // a wrong argument would silently make the relay proxy dispatches to
    // ITSELF over the network -- with the internal secret attached -- instead
    // of answering not-connected. The absent fetch is the whole assertion.
    const response = await dispatch(LOCAL_TARGET_ID);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.LocalWorkerNotConnected,
    });
  });

  it("refuses a same-instance local worker whose owner token is stale", async () => {
    const emit = vi.fn();
    workersByTargetId.set(STALE_LOCAL_TARGET_ID, {
      socket: {
        id: "sock-stale-local",
        connected: true,
        emit,
        data: { pendingBuffer: [] },
      },
      targetId: STALE_LOCAL_TARGET_ID,
      organizationId: "org-1",
      userId: "user-1",
      heartbeatTimer: null,
      degradedTimer: null,
      wasDegraded: false,
      ownerToken: "socket-owner-token",
    } as never);

    try {
      const response = await dispatch(STALE_LOCAL_TARGET_ID);

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        delivered: false,
        reason: RelayDispatchReason.TargetNotConnected,
        diagnosticReason:
          RelayDispatchDiagnosticReason.SameInstanceOwnerTokenMismatch,
      });
      expect(emit).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      workersByTargetId.delete(STALE_LOCAL_TARGET_ID);
    }
  });

  it("reports peer_network_failed when the peer fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(
      new Error("peer fetch failed", { cause: { code: "ECONNREFUSED" } })
    );

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerNetworkFailed,
      peerErrorCode: "ECONNREFUSED",
    });
    expect(mockDeregister).not.toHaveBeenCalled();
  });

  it("reports peer_body_not_json on a non-JSON peer response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerBodyNotJson,
    });
    expect(mockDeregister).not.toHaveBeenCalled();
  });

  it("reports not-delivered on a non-2xx peer response with a JSON error body", async () => {
    // A peer 500/401/403 must not be forwarded verbatim with a 200; the API
    // caller only treats delivered === false as failure.
    const jsonSpy = vi.fn(() => Promise.resolve({ error: "internal" }));
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: jsonSpy,
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerHttpNotOk,
      peerStatusCode: 500,
    });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(mockDeregister).not.toHaveBeenCalled();
  });

  it("reports not-delivered on a malformed 2xx peer response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ unexpected: "shape" }),
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerMalformedResponse,
    });
    expect(mockDeregister).not.toHaveBeenCalled();
  });

  it("reports peer_timeout separately from other fetch failures", async () => {
    const timeoutError = new Error("peer deadline exceeded");
    timeoutError.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeoutError);

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerTimeout,
    });
    expect(mockDeregister).not.toHaveBeenCalled();
  });

  it("attaches an abort signal that times out before the API caller budget", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ delivered: true }),
    });

    await dispatch(REMOTE_TARGET_ID);

    const [, calledInit] = fetchMock.mock.calls[0] as [
      string,
      { signal?: AbortSignal },
    ];
    expect(calledInit.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports target_not_connected when no instance owns the target", async () => {
    const response = await dispatch("unknown-target");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.NoRegistryEntry,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports target_registry_lookup_failed when the target registry lookup errors", async () => {
    const response = await dispatch(TARGET_LOOKUP_ERROR_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason:
        RelayDispatchDiagnosticReason.TargetRegistryLookupFailed,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports target_registry_record_unreadable when the target record is malformed", async () => {
    const response = await dispatch(TARGET_UNREADABLE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason:
        RelayDispatchDiagnosticReason.TargetRegistryRecordUnreadable,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports target_not_connected when instance info is absent for a registered target", async () => {
    // The dangling-target has a registry entry that points to an instance whose
    // info record no longer exists.
    const response = await dispatch(DANGLING_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerInstanceMissing,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports peer_instance_lookup_failed when instance info lookup errors", async () => {
    const response = await dispatch(INSTANCE_LOOKUP_ERROR_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerInstanceLookupFailed,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports peer_instance_lookup_failed when instance info is unreadable", async () => {
    const response = await dispatch(INSTANCE_UNREADABLE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerInstanceLookupFailed,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to proxy to a public IP and issues no fetch", async () => {
    // The ssrf-target's instance record has a public (non-VPC) IP.
    const response = await dispatch(SSRF_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerInstanceDisallowed,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes through a peer's not-delivered result with a non-standard reason", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ delivered: false, reason: "some_other_reason" }),
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      delivered: boolean;
      reason: string;
    };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe("some_other_reason");
    expect(mockDeregister).not.toHaveBeenCalled();
  });

  it("deregisters the stale target when a new peer explicitly reports no worker", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          delivered: false,
          reason: RelayDispatchReason.TargetNotConnected,
          diagnosticReason: RelayDispatchDiagnosticReason.PeerNoWorker,
        }),
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      delivered: boolean;
      reason: string;
    };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe(RelayDispatchReason.TargetNotConnected);
    expect(body).toMatchObject({
      diagnosticReason: RelayDispatchDiagnosticReason.PeerNoWorker,
    });
    expect(mockDeregister).toHaveBeenCalledWith(
      REMOTE_TARGET_ID,
      "owner-token-remote"
    );
  });

  it("deregisters the stale target when an older peer reports target_not_connected without diagnostics", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          delivered: false,
          reason: RelayDispatchReason.TargetNotConnected,
        }),
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerReportedNotConnected,
    });
    expect(mockDeregister).toHaveBeenCalledWith(
      REMOTE_TARGET_ID,
      "owner-token-remote"
    );
  });

  it("does not synthesize a legacy peer diagnostic from an unreadable peer diagnostic field", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          delivered: false,
          reason: RelayDispatchReason.TargetNotConnected,
          diagnosticReason: "x".repeat(
            RelayDispatchMetadataLimit.DiagnosticReasonMaxLength + 1
          ),
          peerErrorCode: "x".repeat(
            RelayDispatchMetadataLimit.PeerErrorCodeMaxLength + 1
          ),
        }),
    });

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
    });
    expect(mockDeregister).not.toHaveBeenCalled();
  });

  it("reports peer_network_failed when the peer raises a non-Error exception", async () => {
    fetchMock.mockRejectedValueOnce("ECONNRESET: non-error string failure");

    const response = await dispatch(REMOTE_TARGET_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerNetworkFailed,
    });
    expect(mockDeregister).not.toHaveBeenCalled();
  });
});
