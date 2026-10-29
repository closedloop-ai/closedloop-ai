import { request } from "node:http";
import {
  RelayDispatchDiagnosticReason,
  RelayDispatchReason,
} from "@repo/api/src/types/relay-dispatch";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { InstanceInfo } from "../target-registry.js";
import {
  cleanupOldWorker,
  socketToTarget,
  workersByTargetId,
} from "../worker-registry.js";
import { reserveTestPort } from "./helpers/reserve-test-port.js";

// `flush` and `debug` are stubbed even though this file drives neither:
// @repo/observability/shutdown calls log.flush(), and it is reachable from the
// relay entrypoint this suite imports, so a partial double fails as a TypeError
// rather than an assertion the moment a case reaches it.
vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

const { log } = await import("@repo/observability/log");
const logInfo = vi.mocked(log.info);

const TEST_PORT = await reserveTestPort(25_000, 1500);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

let baseUrl: string;
let stopRelay: (() => Promise<void>) | null = null;
let isAddressInCidr: (address: string, cidr: string) => boolean;
let isAllowedPeerInstance: (info: InstanceInfo) => boolean;
let peerDispatchTimeoutMs: number;
let apiDispatchCallerTimeoutMs: number;
let parseDispatchPayload: (
  raw: string
) =>
  | { ok: true; payload: { targetId: string; operation: unknown } }
  | { ok: false; error: string };
let validateSecret: (headerValue: string | string[] | undefined) => boolean;
let lastHeartbeatAckAt: Map<string, number>;

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

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.RELAY_PORT = String(TEST_PORT);
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;
  // No RELAY_INTERNAL_ALLOWED_IPS — exercises the secret-only authorization path.

  const relayModule = await import("../index");
  const peerDispatchModule = await import("../peer-dispatch");
  const dispatchModule = await import("../dispatch");
  await relayModule.startRelayServer("127.0.0.1");
  stopRelay = relayModule.stopRelayServer;
  isAddressInCidr = peerDispatchModule.isAddressInCidr;
  isAllowedPeerInstance = peerDispatchModule.isAllowedPeerInstance;
  const proxyDispatchModule = await import("../proxy-dispatch");
  peerDispatchTimeoutMs = proxyDispatchModule.PEER_DISPATCH_TIMEOUT_MS;
  apiDispatchCallerTimeoutMs =
    proxyDispatchModule.API_DISPATCH_CALLER_TIMEOUT_MS;
  parseDispatchPayload = dispatchModule.parseDispatchPayload;
  validateSecret = dispatchModule.validateSecret;
  lastHeartbeatAckAt = relayModule.lastHeartbeatAckAt;

  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
}, 30_000);

afterAll(async () => {
  if (stopRelay) {
    await stopRelay();
  }
  process.env = { ...ORIGINAL_ENV };
});

type TestResponse = { status: number; body: string };

function requestJson(
  path: string,
  options: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${baseUrl}${path}`,
      {
        method: options.method ?? "GET",
        headers: options.headers,
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
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

describe("isAddressInCidr", () => {
  it("matches an address inside the subnet", () => {
    expect(isAddressInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
  });

  it("rejects an address outside the subnet", () => {
    expect(isAddressInCidr("192.168.1.1", "10.0.0.0/8")).toBe(false);
  });

  it("treats /0 as matching all addresses", () => {
    expect(isAddressInCidr("203.0.113.5", "0.0.0.0/0")).toBe(true);
  });

  it("matches an exact /32 host and rejects its neighbour", () => {
    expect(isAddressInCidr("127.0.0.1", "127.0.0.1/32")).toBe(true);
    expect(isAddressInCidr("127.0.0.2", "127.0.0.1/32")).toBe(false);
  });

  it("fails closed on a non-numeric prefix length", () => {
    expect(isAddressInCidr("10.0.0.1", "10.0.0.0/foo")).toBe(false);
  });

  it("fails closed on a negative prefix length", () => {
    expect(isAddressInCidr("10.0.0.1", "10.0.0.0/-1")).toBe(false);
  });

  it("fails closed on a prefix length above 32", () => {
    expect(isAddressInCidr("10.0.0.1", "10.0.0.0/40")).toBe(false);
  });

  it("treats an entry without a slash as an exact host match", () => {
    expect(isAddressInCidr("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(isAddressInCidr("127.0.0.2", "127.0.0.1")).toBe(false);
  });

  it("strips the IPv4-mapped IPv6 prefix before matching", () => {
    expect(isAddressInCidr("::ffff:10.1.2.3", "10.0.0.0/8")).toBe(true);
  });
});

describe("parseDispatchPayload", () => {
  it("returns the payload for a valid body", () => {
    const result = parseDispatchPayload(
      JSON.stringify({ targetId: "t1", operation: { commandId: "c1" } })
    );
    expect(result).toEqual({
      ok: true,
      payload: { targetId: "t1", operation: { commandId: "c1" } },
    });
  });

  it("rejects invalid JSON", () => {
    expect(parseDispatchPayload("not-json")).toEqual({
      ok: false,
      error: "Invalid JSON",
    });
  });

  it("rejects a body missing targetId", () => {
    expect(parseDispatchPayload(JSON.stringify({ operation: {} }))).toEqual({
      ok: false,
      error: "Missing targetId",
    });
  });

  it("rejects a non-string targetId", () => {
    expect(parseDispatchPayload(JSON.stringify({ targetId: 42 }))).toEqual({
      ok: false,
      error: "Missing targetId",
    });
  });
});

describe("POST /internal/dispatch", () => {
  it("rejects requests without the internal secret", async () => {
    const response = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: "t1", operation: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects requests with a wrong internal secret", async () => {
    const response = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": "wrong-secret",
      },
      body: JSON.stringify({ targetId: "t1", operation: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects invalid JSON with 400", async () => {
    const response = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: "not-json",
    });
    expect(response.status).toBe(400);
    expect((JSON.parse(response.body) as { error: string }).error).toBe(
      "Invalid JSON"
    );
  });

  it("authorizes on a valid secret alone when no allowlist is set", async () => {
    const response = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: JSON.stringify({
        targetId: "target-not-connected",
        operation: { commandId: "cmd-1" },
      }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      delivered: boolean;
      diagnosticReason: string;
      reason: string;
    };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe(RelayDispatchReason.TargetNotConnected);
    expect(body.diagnosticReason).toBe(
      RelayDispatchDiagnosticReason.PeerNoWorker
    );
  });
});

describe("isAllowedPeerInstance (cross-instance egress allowlist)", () => {
  // No RELAY_INTERNAL_ALLOWED_IPS in this suite, so the RFC1918 fallback applies.
  it("allows a private peer IP on the relay port", () => {
    expect(
      isAllowedPeerInstance({
        privateIp: "10.0.0.5",
        port: TEST_PORT,
        startedAt: 0,
      })
    ).toBe(true);
  });

  it("rejects a public peer IP (SSRF / secret exfiltration guard)", () => {
    expect(
      isAllowedPeerInstance({
        privateIp: "1.2.3.4",
        port: TEST_PORT,
        startedAt: 0,
      })
    ).toBe(false);
  });

  it("rejects a loopback peer IP", () => {
    expect(
      isAllowedPeerInstance({
        privateIp: "127.0.0.1",
        port: TEST_PORT,
        startedAt: 0,
      })
    ).toBe(false);
  });

  it("rejects an unexpected port even for a private IP", () => {
    expect(
      isAllowedPeerInstance({ privateIp: "10.0.0.5", port: 22, startedAt: 0 })
    ).toBe(false);
  });

  it("rejects a non-integer port", () => {
    expect(
      isAllowedPeerInstance({
        privateIp: "10.0.0.5",
        port: Number.NaN,
        startedAt: 0,
      })
    ).toBe(false);
  });
});

describe("peer dispatch timeout contract", () => {
  it("aborts the peer dispatch before the API caller's budget", () => {
    expect(apiDispatchCallerTimeoutMs).toBe(5000);
    expect(peerDispatchTimeoutMs).toBeLessThan(apiDispatchCallerTimeoutMs);
  });
});

describe("readBody — body-size limit (L562)", () => {
  it("closes the connection when the request body exceeds the 1 MB limit", async () => {
    // Control: an otherwise-identical UNDER-limit request to the same route
    // must be served normally. Without this, the over-limit assertion below
    // would also pass for a deleted route (404) or an unrelated 500 — it would
    // prove nothing about the size limit.
    const underLimit = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: JSON.stringify({
        targetId: "target-not-connected",
        operation: { commandId: "cmd-under-limit" },
      }),
    });
    expect(underLimit.status).toBe(200);

    // Over the limit, readBody calls req.destroy() (L562 arm0), tearing down
    // the socket before any response can be written — so the client observes a
    // transport error, which the catch below normalizes to status 0.
    const overLimitBody = JSON.stringify({
      targetId: "t1",
      operation: {},
      pad: "x".repeat(1_100_000),
    });

    const result = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: overLimitBody,
    }).catch(() => ({ status: 0, body: "" }));

    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Previously-unpinned dispatch arms (ISS-7976)
// ---------------------------------------------------------------------------

describe("validateSecret — header shapes", () => {
  it("accepts the configured secret sent once", () => {
    // Control. Without it, the rejections below would also pass against a
    // validateSecret that refused everything.
    expect(validateSecret(TEST_SECRET)).toBe(true);
  });

  it("rejects a duplicated x-internal-secret header (array value)", () => {
    // Node surfaces a repeated header as string[]. Both entries hold the
    // CORRECT secret, so this fails on the SHAPE alone -- a `String(value)`
    // coercion "fix" would wrongly admit it.
    expect(validateSecret([TEST_SECRET, TEST_SECRET])).toBe(false);
  });

  it("rejects an absent x-internal-secret header", () => {
    expect(validateSecret(undefined)).toBe(false);
  });
});

describe("POST /internal/dispatch — the worker-found arms (ISS-7976)", () => {
  const SEEDED_TARGET = "target-seeded-worker";
  const SEEDED_SOCKET_ID = "seeded-socket";

  function seedWorker(emit: (event: string, payload: unknown) => void): void {
    // Seeded directly rather than through desktop.hello: this suite mocks
    // socket.io with a bare namespace double, so there is no connection
    // handler to drive. `socketToTarget` is populated the way registration
    // does it (index.ts:563) so afterEach can reach the production release
    // path instead of deleting the map entry behind its back.
    socketToTarget.set(SEEDED_SOCKET_ID, SEEDED_TARGET);
    workersByTargetId.set(SEEDED_TARGET, {
      socket: { id: SEEDED_SOCKET_ID, emit } as never,
      targetId: SEEDED_TARGET,
      organizationId: "org-1",
      userId: "user-1",
      heartbeatTimer: null,
      degradedTimer: null,
      wasDegraded: false,
    });
  }

  afterEach(() => {
    // apps/relay/AGENTS.md: release through the production path, which clears
    // the heartbeat and degraded timers before dropping the entry. A bare
    // `workersByTargetId.delete` leaks both the moment this fixture grows a
    // timer. `cleanupOldWorker` is the takeover arm of that path — the only
    // arm reachable here, since the disconnect handler needs socket.io's
    // connection handler and this suite mocks it away.
    const worker = workersByTargetId.get(SEEDED_TARGET);
    if (worker) {
      cleanupOldWorker(
        worker.socket,
        `${SEEDED_TARGET}-released`,
        lastHeartbeatAckAt
      );
    }
    socketToTarget.delete(SEEDED_SOCKET_ID);
    // `cleanupOldWorker` early-returns on either guard, so a release that
    // stopped reaching the delete would look identical to one that ran.
    if (workersByTargetId.has(SEEDED_TARGET)) {
      throw new Error(
        `${SEEDED_TARGET} survived cleanupOldWorker — afterEach released nothing.`
      );
    }
  });

  function dispatchToSeededTarget(): Promise<TestResponse> {
    return requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: JSON.stringify({
        targetId: SEEDED_TARGET,
        operation: { commandId: "cmd-seeded" },
      }),
    });
  }

  // An authenticated dispatch that announces a body, sends part of it, then
  // abandons the socket — the shape of a sender that gave up at
  // PEER_DISPATCH_TIMEOUT_MS. `readBody` never sees `end`, so the promise
  // `parseDispatchBody` awaits never settles. Resolves once the partial bytes
  // are on the wire and the socket is gone.
  function abandonMidBody(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = request(`${baseUrl}/internal/dispatch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": TEST_SECRET,
          // Promises far more than the chunk below ever delivers.
          "Content-Length": "512",
        },
      });
      // Abandoning the request surfaces here; it is the case, not a failure.
      req.on("error", () => resolve());
      req.write('{"targetId":"abandoned"', (writeError) => {
        if (writeError) {
          reject(writeError);
          return;
        }
        // Half-close rather than RST: the headers and the partial chunk are
        // already flushed, and a FIN guarantees the peer keeps them.
        req.socket?.end();
        resolve();
      });
    });
  }

  it("emits desktop.command to the local worker and reports delivered", async () => {
    // peer-dispatch.ts: only the refusal half of this pair was pinned.
    const emitted: Array<{ event: string; payload: unknown }> = [];
    seedWorker((event, payload) => {
      emitted.push({ event, payload });
    });

    const res = await dispatchToSeededTarget();

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ delivered: true });
    expect(emitted).toEqual([
      { event: "desktop.command", payload: { commandId: "cmd-seeded" } },
    ]);
  });

  it("records arrival for an authorized dispatch, worker present or not (ISS-8673)", async () => {
    // The logging IS the contract: without a record on this side, a hop the
    // sender abandoned at PEER_DISPATCH_TIMEOUT_MS cannot be told apart from one
    // that never landed. Deleting the log breaks no other assertion in the file.
    //
    // Both arms here complete normally, so neither pins WHERE the record sits
    // relative to the body read — that is the abandoned-body case below. What
    // these two pin is that the record does not depend on a worker being
    // present, and that it does not displace the wire contract on either arm.
    seedWorker(() => {
      // Delivery itself is pinned by the sibling case; this one owns the record.
    });
    logInfo.mockClear();

    await dispatchToSeededTarget();

    expect(logInfo).toHaveBeenCalledWith("Internal dispatch received", {
      sourceIp: expect.any(String),
    });

    logInfo.mockClear();
    const absent = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: JSON.stringify({
        targetId: "target-absent-for-arrival-record",
        operation: { commandId: "cmd-absent" },
      }),
    });

    expect(logInfo).toHaveBeenCalledWith("Internal dispatch received", {
      sourceIp: expect.any(String),
    });
    // The wire contract on this arm is what tryProxyDispatch keys its registry
    // deregistration off (proxy-dispatch.ts:106-111); the record must not come
    // at its expense.
    expect(absent.status).toBe(200);
    expect(JSON.parse(absent.body)).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerNoWorker,
    });
  });

  it("records arrival for a body the sender abandons mid-stream (ISS-8673)", async () => {
    // The timeout path the record exists for. The sender gives up before the
    // body is complete, so `readBody` never sees `end` and the promise
    // `parseDispatchBody` awaits never settles — a record placed anywhere
    // after that await is missing for exactly the case it was added to
    // explain. This is the assertion that kills that placement; the
    // malformed-body case below does NOT, because there the parse returns.
    logInfo.mockClear();

    await abandonMidBody();

    await vi.waitFor(
      () => {
        expect(logInfo).toHaveBeenCalledWith("Internal dispatch received", {
          sourceIp: expect.any(String),
        });
      },
      { timeout: 2000, interval: 10 }
    );
  });

  it("records arrival even when the body never parses (ISS-8673)", async () => {
    // A body that arrives whole but is not JSON still proves the hop landed.
    // This one pins only that the 400 arm keeps the record — it says nothing
    // about placement relative to the body read, which the abandoned-body case
    // above owns.
    logInfo.mockClear();

    const response = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: "not-json",
    });

    expect(response.status).toBe(400);
    expect(logInfo).toHaveBeenCalledWith("Internal dispatch received", {
      sourceIp: expect.any(String),
    });
  });

  it("does not record arrival for an unauthorized request (ISS-8673)", async () => {
    // The record is gated on the shared secret so an unauthenticated prober
    // cannot write to the log stream this comparison is read from.
    logInfo.mockClear();

    const response = await requestJson("/internal/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": "wrong-secret",
      },
      body: JSON.stringify({ targetId: "t1", operation: {} }),
    });

    expect(response.status).toBe(401);
    expect(logInfo).not.toHaveBeenCalledWith(
      "Internal dispatch received",
      expect.anything()
    );
  });

  it("answers a real 500 when the handler throws with the response still open", async () => {
    // The other way into this catch arm is the 1 MB body cap, and there
    // readBody has already destroyed the socket, so the client observes a
    // transport error (status 0 -- see the readBody suite above) and never a
    // status. This is the arm actually reaching a client, which is what makes
    // keeping the 500 write worthwhile instead of deleting it as unreachable.
    seedWorker(() => {
      throw new Error("socket adapter exploded");
    });

    const res = await dispatchToSeededTarget();

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Internal server error" });
  });
});

describe("isAddressInCidr — malformed address forms (ISS-7976 branch 9)", () => {
  // The configured-allowlist path (peer-dispatch.ts isAllowedPeerInstance)
  // hands `info.privateIp` -- untrusted Redis data -- straight to
  // isAddressInCidr, bypassing the strict-regex isRoutablePrivateIpv4 that the
  // unset-allowlist fallback uses. ipToNumber does no format validation, so
  // these are the forms that could in principle slip through. Each is pinned
  // to what it ACTUALLY resolves to, not to an assumption.

  it("treats an all-decimal address as the host it denotes, not a new one", () => {
    // 167772161 === 10.0.0.1. Number("167772161") lands in the single-octet
    // loop iteration, so this is an ALIAS for 10.0.0.1, not a bypass: it
    // matches exactly the CIDRs the dotted form matches, and no others.
    // /32 is the same-host proof: it matches one address and no other, so
    // this states WHICH host the form resolves to rather than only that some
    // /8 admits it.
    expect(isAddressInCidr("167772161", "10.0.0.1/32")).toBe(true);
    expect(isAddressInCidr("167772161", "10.0.0.2/32")).toBe(false);
    expect(isAddressInCidr("167772161", "192.168.0.0/16")).toBe(false);
  });

  it("treats a hex octet as the host it denotes, not a new one", () => {
    // Number("0x0a") === 10, so "0x0a.0.0.1" is another alias for 10.0.0.1.
    expect(isAddressInCidr("0x0a.0.0.1", "10.0.0.1/32")).toBe(true);
    expect(isAddressInCidr("0x0a.0.0.1", "10.0.0.2/32")).toBe(false);
  });

  it("treats a trailing-whitespace octet as the host it denotes", () => {
    // Number("1 ") === 1. Same alias again.
    expect(isAddressInCidr("10.0.0.1 ", "10.0.0.1/32")).toBe(true);
    expect(isAddressInCidr("10.0.0.1 ", "10.0.0.2/32")).toBe(false);
  });

  it("fails closed on an over-long address instead of matching what it appears to name", () => {
    // Six octets overflow the 32-bit shift and land on 0.5.6.7 -- NOT the
    // 10.0.0.5 the string appears to lead with. The load-bearing assertion is
    // the first: an allowlist for 10/8 does not admit it.
    expect(isAddressInCidr("10.0.0.5.6.7", "10.0.0.0/8")).toBe(false);
    expect(isAddressInCidr("10.0.0.5.6.7", "192.168.0.0/16")).toBe(false);
    expect(isAddressInCidr("10.0.0.5.6.7", "172.16.0.0/12")).toBe(false);
    // Where it DOES land, stated rather than left implied.
    expect(isAddressInCidr("10.0.0.5.6.7", "0.5.6.7/32")).toBe(true);
  });
});
