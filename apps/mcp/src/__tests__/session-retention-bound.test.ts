import { once } from "node:events";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ApiKeyVerificationStatus } from "../api-key-contract.js";

const { verifyApiKeyMock, checkApiReachableMock, logInfoMock, dbBarrier } =
  vi.hoisted(() => ({
    verifyApiKeyMock: vi.fn(),
    checkApiReachableMock: vi.fn(),
    logInfoMock: vi.fn(),
    // Lets a case pin N handlers between their capacity claim and their
    // admission. `createMcpServer` awaits exactly one `withDb` call, after the
    // claim and before the map is touched, so a handler held here is holding a
    // real in-flight server — the arrival shape the count bound has to survive.
    dbBarrier: {
      waitFor: 0,
      arrived: 0,
      gate: undefined as Promise<void> | undefined,
      open: undefined as (() => void) | undefined,
    },
  }));

// Also silences the per-request `[http] request` / `[mcp] session-*` lines that
// otherwise bury this suite's real output under a burst of MAX_SESSIONS.
vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: logInfoMock,
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

vi.mock("../api-client.js", () => ({
  verifyApiKey: verifyApiKeyMock,
  // Mirrors the real module, where verifyApiKeyDetailed is the source of truth
  // and verifyApiKey collapses it.
  verifyApiKeyDetailed: async (plaintextKey: string) => {
    const context = await verifyApiKeyMock(plaintextKey);
    return context
      ? { status: ApiKeyVerificationStatus.Ok, context }
      : { status: ApiKeyVerificationStatus.Invalid };
  },
  checkApiReachable: checkApiReachableMock,
  createApiClient: vi.fn(() => ({})),
}));

vi.mock("@repo/database", () => {
  const db = {
    organization: {
      findUnique: () => Promise.resolve({ slug: "test-org" }),
    },
  };
  const withDb = Object.assign(
    async <T>(fn: (client: typeof db) => Promise<T> | T): Promise<T> => {
      if (dbBarrier.waitFor > 0) {
        dbBarrier.arrived += 1;
        // Safety valve. If more handlers get past their claim than the cap
        // allows, stop holding them: the case then fails on its status
        // assertion, which names the defect, instead of on a timeout, which
        // does not.
        if (dbBarrier.arrived > dbBarrier.waitFor) {
          dbBarrier.open?.();
        }
        await dbBarrier.gate;
      }
      return fn(db);
    },
    {
      tx: async <T>(fn: (client: typeof db) => Promise<T>): Promise<T> =>
        fn(db),
    }
  );
  return { withDb };
});

const TEST_API_KEY = "sk_live_session_bound_test";

const MAX_SESSIONS = 5;
const SWEEP_INTERVAL_MS = 30_000;
const TTL_MS = 60_000;

type McpSessionReservation = { released: boolean };

type SessionLike = {
  server: { close: () => Promise<void> };
  lastActivityMs: number;
};

let admitMcpSession: (
  sessionId: string,
  session: SessionLike,
  reservation?: McpSessionReservation
) => void;
let cleanupExpiredMcpSessions: (nowMs: number) => void;
let startMcpSessionSweep: () => void;
let stopMcpSessionSweep: () => void;
let reserveMcpSessionCapacity: () => McpSessionReservation | undefined;
let releaseMcpSessionCapacity: (r: McpSessionReservation) => void;
let mcpSessions: Map<string, SessionLike>;
let resetInMemorySecurityState: () => void;
let startHttpServer: (port?: number) => import("node:http").Server;

let closedSessionIds: string[] = [];

function claimSlot(): McpSessionReservation {
  const reservation = reserveMcpSessionCapacity();
  if (!reservation) {
    throw new Error("expected a session slot to be available");
  }
  return reservation;
}

function armDbBarrier(waitFor: number): void {
  dbBarrier.waitFor = waitFor;
  dbBarrier.arrived = 0;
  dbBarrier.gate = new Promise<void>((resolve) => {
    dbBarrier.open = resolve;
  });
}

function disarmDbBarrier(): void {
  dbBarrier.open?.();
  dbBarrier.waitFor = 0;
  dbBarrier.arrived = 0;
  dbBarrier.gate = undefined;
  dbBarrier.open = undefined;
}

// `session-capacity-refused` is a POST for both causes, so `reason` is the only
// facet a monitor can group on to tell an initialize refusal from a shed
// rebuild — and apps/mcp/README.md tells operators to triage by exactly that.
function refusalReasons(): string[] {
  return logInfoMock.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith("[mcp] session-capacity-refused "))
    .map((line) => line.split(" ").find((part) => part.startsWith("reason=")))
    .map((part) => part ?? "reason=<absent>");
}

function makeSession(sessionId: string, lastActivityMs: number): SessionLike {
  return {
    server: {
      close: () => {
        closedSessionIds.push(sessionId);
        return Promise.resolve();
      },
    },
    lastActivityMs,
  };
}

const TEST_ENV: Record<string, string> = {
  INTERNAL_API_SECRET: "test-internal-secret",
  MCP_MAX_SESSIONS: String(MAX_SESSIONS),
  MCP_SESSION_SWEEP_INTERVAL_MS: String(SWEEP_INTERVAL_MS),
  MCP_SERVER_CACHE_TTL_MS: String(TTL_MS),
};
const previousEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  // `pool: threads` shares process.env across suites in a worker, so every
  // mutation is restored in afterAll rather than leaked to the next file.
  for (const [key, value] of Object.entries(TEST_ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  const mod = await import("../index.js");
  const testables = mod.__testables as unknown as {
    admitMcpSession: typeof admitMcpSession;
    cleanupExpiredMcpSessions: typeof cleanupExpiredMcpSessions;
    startMcpSessionSweep: typeof startMcpSessionSweep;
    stopMcpSessionSweep: typeof stopMcpSessionSweep;
    reserveMcpSessionCapacity: typeof reserveMcpSessionCapacity;
    releaseMcpSessionCapacity: typeof releaseMcpSessionCapacity;
    mcpSessions: typeof mcpSessions;
    MCP_MAX_SESSIONS: number;
    resetInMemorySecurityState: typeof resetInMemorySecurityState;
  };
  startHttpServer = mod.startHttpServer;

  admitMcpSession = testables.admitMcpSession;
  cleanupExpiredMcpSessions = testables.cleanupExpiredMcpSessions;
  startMcpSessionSweep = testables.startMcpSessionSweep;
  stopMcpSessionSweep = testables.stopMcpSessionSweep;
  reserveMcpSessionCapacity = testables.reserveMcpSessionCapacity;
  releaseMcpSessionCapacity = testables.releaseMcpSessionCapacity;
  mcpSessions = testables.mcpSessions;
  resetInMemorySecurityState = testables.resetInMemorySecurityState;

  // A setup precondition, not an assertion: if the env override did not take
  // effect the cap tests below would run against the 200 default and pass while
  // proving nothing, so fail loudly here instead.
  if (testables.MCP_MAX_SESSIONS !== MAX_SESSIONS) {
    throw new Error(
      `MCP_MAX_SESSIONS override did not apply: expected ${MAX_SESSIONS}, got ${testables.MCP_MAX_SESSIONS}`
    );
  }
});

afterAll(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  previousEnv.clear();
});

beforeEach(() => {
  resetInMemorySecurityState();
  closedSessionIds = [];
  checkApiReachableMock.mockReset();
  checkApiReachableMock.mockResolvedValue(true);
  logInfoMock.mockReset();
  verifyApiKeyMock.mockReset();
  verifyApiKeyMock.mockImplementation((apiKey: string) =>
    apiKey === TEST_API_KEY
      ? {
          userId: "user_1",
          organizationId: "org_1",
          scopes: ["read", "write", "delete"],
        }
      : null
  );
});

// A real listening server, not the mock-http doubles: those answer the MCP
// protocol handshake with 400 (see api-key-scope-fail-closed.test.ts), so no
// session is ever created through them and a cap assertion over them would be
// vacuous. Only a real req/res pair completes initialize and registers a
// session, which is the exact step this bound has to constrain.
// `sessionId` names a session the task does not hold, which is what routes the
// POST to the stateless rebuild instead of the initialize path — so this is
// only an initialize when no `sessionId` is given, hence `postMcp` rather than
// the name it carried when the rebuild had no case. `rpcMethod` is what real
// rebuild traffic varies: an established client resumes with `tools/call` or
// `tools/list`, not with another handshake.
//
// `retryAfter` comes back alongside the status because the refusal contract is
// a 503 AND the retry it tells the client to make; asserting only the status
// leaves the second half of that contract unpinned.
const INITIALIZE_PARAMS = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "burst-client", version: "1.0.0" },
};

async function postMcp(
  port: number,
  options: { sessionId?: string; rpcMethod?: string } = {}
): Promise<{ status: number; retryAfter: string | null }> {
  const { sessionId, rpcMethod = "initialize" } = options;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TEST_API_KEY}`,
      "mcp-protocol-version": "2025-03-26",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: rpcMethod,
      params: rpcMethod === "initialize" ? INITIALIZE_PARAMS : {},
    }),
  });
  // The initialize response is an SSE stream; release it so the socket does not
  // stay open and hold the suite past its assertions.
  await response.body?.cancel();
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
  };
}

// Unconditional: a case that throws between useFakeTimers and a trailing
// restore would otherwise leak a frozen clock into every later test.
afterEach(() => {
  stopMcpSessionSweep();
  // A case that throws while the barrier is armed would otherwise leave every
  // later handler blocked on a gate nobody opens.
  disarmDbBarrier();
  vi.useRealTimers();
});

describe("MCP session retention is bounded in count", () => {
  it("never retains more than the cap, however fast sessions arrive", () => {
    const burst = MAX_SESSIONS + 20;

    for (let index = 0; index < burst; index += 1) {
      admitMcpSession(
        `session-${index}`,
        makeSession(`session-${index}`, index)
      );
      expect(mcpSessions.size).toBeLessThanOrEqual(MAX_SESSIONS);
    }

    expect(mcpSessions.size).toBe(MAX_SESSIONS);
    // Every session displaced by the cap had its server closed, so the
    // McpServer it carried is released rather than merely unreferenced.
    expect(closedSessionIds).toHaveLength(burst - MAX_SESSIONS);
  });

  it("evicts the least recently used session, not the oldest admitted", () => {
    // Insertion order and recency order are deliberately DIFFERENT here.
    // "busy" is admitted first and starts as the least-recently-used, so an
    // eviction that simply takes the head of the map — or that reads
    // lastActivityMs as it stood at admission — picks "busy" and fails this
    // case. Only re-reading recency at eviction time picks "target".
    admitMcpSession("busy", makeSession("busy", 1000));
    admitMcpSession("target", makeSession("target", 1500));
    for (let index = 0; index < MAX_SESSIONS - 2; index += 1) {
      admitMcpSession(`filler-${index}`, makeSession(`filler-${index}`, 3000));
    }
    expect(mcpSessions.size).toBe(MAX_SESSIONS);

    const busy = mcpSessions.get("busy");
    if (!busy) {
      throw new Error("expected the busy session to still be retained");
    }
    busy.lastActivityMs = 9000;

    admitMcpSession("newcomer", makeSession("newcomer", 10_000));

    expect(mcpSessions.has("target")).toBe(false);
    expect(mcpSessions.has("busy")).toBe(true);
    expect(mcpSessions.has("newcomer")).toBe(true);
    expect(closedSessionIds).toEqual(["target"]);
  });

  it("keeps the newly admitted session rather than evicting it immediately", () => {
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      admitMcpSession(`filler-${index}`, makeSession(`filler-${index}`, 1000));
    }

    admitMcpSession("newcomer", makeSession("newcomer", 500));

    expect(mcpSessions.has("newcomer")).toBe(true);
    expect(mcpSessions.size).toBe(MAX_SESSIONS);
  });
});

describe("MCP session sweep runs without request traffic", () => {
  it("reaps expired sessions on its own interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));

    startMcpSessionSweep();
    mcpSessions.set("idle", makeSession("idle", Date.now() - (TTL_MS + 1000)));

    // No request arrives in this window; before the interval existed the only
    // sweep call site was the request handler, so this session stayed resident.
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + 1000);

    expect(mcpSessions.has("idle")).toBe(false);
    expect(closedSessionIds).toEqual(["idle"]);
  });

  it("leaves unexpired sessions alone when the interval fires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));

    startMcpSessionSweep();
    mcpSessions.set("fresh", makeSession("fresh", Date.now()));

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + 1000);

    expect(mcpSessions.has("fresh")).toBe(true);
    expect(closedSessionIds).toEqual([]);
  });

  it("stops sweeping once the timer is cleared", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));

    startMcpSessionSweep();
    stopMcpSessionSweep();
    mcpSessions.set("idle", makeSession("idle", Date.now() - (TTL_MS + 1000)));

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 4);

    expect(mcpSessions.has("idle")).toBe(true);
  });

  it("does not stack a second interval when started twice", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));

    startMcpSessionSweep();
    startMcpSessionSweep();
    stopMcpSessionSweep();
    mcpSessions.set("idle", makeSession("idle", Date.now() - (TTL_MS + 1000)));

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 4);

    // A leaked second interval would survive the single stop and reap this.
    expect(mcpSessions.has("idle")).toBe(true);
  });
});

// The suites above drive admitMcpSession directly, so on their own they stay
// green if the production handler goes back to calling mcpSessions.set. This
// one drives real POST /mcp initialize requests through dispatchHttpRequest,
// so the call site itself is pinned.
describe("the /mcp initialize path enforces the bound", () => {
  it("holds the cap across a real reconnect burst", async () => {
    const httpServer = startHttpServer(0);
    try {
      await once(httpServer, "listening");
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("expected an ephemeral TCP port");
      }

      const burst = MAX_SESSIONS + 8;
      for (let index = 0; index < burst; index += 1) {
        const { status } = await postMcp(address.port);
        // Pins that the burst is real traffic. Without this, an auth or
        // transport regression would leave the map empty and the cap
        // assertion below would pass while proving nothing.
        expect({ index, status }).toEqual({ index, status: 200 });
      }

      expect(mcpSessions.size).toBe(MAX_SESSIONS);
    } finally {
      httpServer.close();
    }
  });

  it("refuses the surplus of a concurrent burst rather than building a server for each", async () => {
    // The settled map size proves nothing about a concurrent burst: eviction at
    // admission alone already lands on the cap once everything drains. What has
    // to be pinned is the PEAK, so this case holds MAX_SESSIONS handlers open
    // between their claim and their admission and asks what the surplus gets
    // while every slot is committed to a server that exists but is not yet in
    // the map. Granting them is one McpServer per in-flight request on the
    // heap, which is the spike this bound exists to prevent.
    const httpServer = startHttpServer(0);
    try {
      await once(httpServer, "listening");
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("expected an ephemeral TCP port");
      }

      armDbBarrier(MAX_SESSIONS);
      const held = Array.from({ length: MAX_SESSIONS }, () =>
        postMcp(address.port)
      );
      await vi.waitFor(
        () => {
          expect(dbBarrier.arrived).toBe(MAX_SESSIONS);
        },
        { timeout: 10_000 }
      );

      const surplus = 8;
      const surplusResponses = await Promise.all(
        Array.from({ length: surplus }, () => postMcp(address.port))
      );

      // 503, not 200 and not a session-missing error: the client was shed for
      // capacity and the retry it is being told to make will work. The retry is
      // half that contract, so the header is pinned with the status — a refusal
      // that ships no Retry-After leaves the client no told-to-retry at all.
      expect(surplusResponses).toEqual(
        Array.from({ length: surplus }, () => ({
          status: 503,
          retryAfter: "1",
        }))
      );
      // These are new clients turned away. The rebuild case below sheds an
      // established one, and `method` is POST for both.
      expect(refusalReasons()).toEqual(
        Array.from({ length: surplus }, () => "reason=initialize")
      );
      // Nothing was evicted to serve them either — with the table empty there
      // is nothing to evict, which is precisely why refusing is the only bound.
      expect(closedSessionIds).toEqual([]);
      expect(mcpSessions.size).toBe(0);

      disarmDbBarrier();
      expect((await Promise.all(held)).map((held) => held.status)).toEqual(
        Array.from({ length: MAX_SESSIONS }, () => 200)
      );
      expect(mcpSessions.size).toBe(MAX_SESSIONS);
    } finally {
      disarmDbBarrier();
      httpServer.close();
    }
  }, 20_000);
});

// A POST carrying a session id this task does not hold rebuilds the same
// 49-tool McpServer an admitted session holds. Before ISS-8394 it took no
// claim, so the cap counted the sessions it admitted rather than the servers
// resident — and every routine miss (restart, TTL expiry, eviction, non-sticky
// load balancer) allocated outside it.
describe("the /mcp stateless fallback is bound by the same capacity", () => {
  async function withRunningServer(
    run: (port: number) => Promise<void>
  ): Promise<void> {
    const httpServer = startHttpServer(0);
    try {
      await once(httpServer, "listening");
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("expected an ephemeral TCP port");
      }
      await run(address.port);
    } finally {
      disarmDbBarrier();
      httpServer.close();
    }
  }

  it("claims a slot for the rebuild, evicting to make room for it", async () => {
    await withRunningServer(async (port) => {
      // Fresh timestamps: the handler sweeps expired sessions before routing,
      // so stale ones would be gone before the claim and the eviction below
      // would be indistinguishable from a TTL reap.
      const admittedAtMs = Date.now();
      for (let index = 0; index < MAX_SESSIONS; index += 1) {
        admitMcpSession(
          `held-${index}`,
          makeSession(`held-${index}`, admittedAtMs + index)
        );
      }
      expect(mcpSessions.size).toBe(MAX_SESSIONS);

      const { status } = await postMcp(port, {
        sessionId: "session-this-task-lacks",
      });

      // A precondition, not the point: the 200 is what today's unbounded path
      // already returns, so it proves the traffic is real and nothing more.
      expect(status).toBe(200);
      // The point. Taking the claim is the only thing that can displace a
      // session here, so an unaccounted rebuild leaves the table untouched.
      expect(closedSessionIds).toEqual(["held-0"]);
      expect(mcpSessions.size).toBe(MAX_SESSIONS - 1);
    });
  }, 20_000);

  it("refuses the rebuild when every slot is committed to a server being built", async () => {
    await withRunningServer(async (port) => {
      // Every slot held by an initialize mid-build, so the table is empty and
      // there is nothing left to evict — the state in which granting the
      // rebuild is one more McpServer on the heap in exchange for nothing.
      armDbBarrier(MAX_SESSIONS);
      const held = Array.from({ length: MAX_SESSIONS }, () => postMcp(port));
      await vi.waitFor(
        () => {
          expect(dbBarrier.arrived).toBe(MAX_SESSIONS);
        },
        { timeout: 10_000 }
      );

      // `tools/list`, not another handshake: real rebuild traffic is an
      // established client resuming a call. The claim is taken before dispatch,
      // so the body cannot change the outcome — which is the point. A rebuild
      // carrying any JSON-RPC method is shed identically, so an operator reading
      // `session-capacity-refused` is not only seeing new clients turned away.
      const { status, retryAfter } = await postMcp(port, {
        sessionId: "session-this-task-lacks",
        rpcMethod: "tools/list",
      });

      // 503 with a retry, not a 404 "reinitialize": this client's session was
      // never here to lose, and the retry it is told to make will work. Both
      // halves are pinned — a 503 that ships no Retry-After, or one that names
      // an hour, tells the client something the refusal contract does not.
      expect({ status, retryAfter }).toEqual({ status: 503, retryAfter: "1" });
      // Same status and same event as an initialize refusal, so only this facet
      // separates "no client could connect" from "an established client's call
      // was shed" when the two spike together.
      expect(refusalReasons()).toEqual(["reason=stateless-rebuild"]);
      // The refused rebuild never reached `withDb`, so the claim was taken
      // BEFORE the server was built. Claiming after the build would leave the
      // heap already committed by the time the bound got a say.
      expect(dbBarrier.arrived).toBe(MAX_SESSIONS);
      expect(closedSessionIds).toEqual([]);

      disarmDbBarrier();
      expect((await Promise.all(held)).map((held) => held.status)).toEqual(
        Array.from({ length: MAX_SESSIONS }, () => 200)
      );
    });
  }, 20_000);

  it("gives the slot back, so repeated rebuilds do not exhaust the bound", async () => {
    await withRunningServer(async (port) => {
      // Nothing is retained past the response, so a claim that is never
      // released only ever accumulates: `pendingMcpSessions` would reach the
      // cap after MAX_SESSIONS rebuilds and then refuse every request — both
      // rebuilds and initializes — until the task restarts.
      const statuses: number[] = [];
      for (let index = 0; index <= MAX_SESSIONS; index += 1) {
        const { status } = await postMcp(port, {
          sessionId: `session-this-task-lacks-${index}`,
        });
        statuses.push(status);
      }

      expect(statuses).toEqual(
        Array.from({ length: MAX_SESSIONS + 1 }, () => 200)
      );
      expect(mcpSessions.size).toBe(0);
    });
  }, 30_000);
});

describe("the server lifecycle owns the retention sweep", () => {
  it("reaps an idle session on the interval without any request traffic", () => {
    // The sweep cases above call startMcpSessionSweep directly, so deleting the
    // call in startHttpServer leaves them green while idle sessions stay
    // resident in production until the next request happens to arrive.
    vi.useFakeTimers();
    const httpServer = startHttpServer(0);
    try {
      const nowMs = Date.now();
      mcpSessions.set("idle", makeSession("idle", nowMs - TTL_MS - 1));

      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

      expect(mcpSessions.has("idle")).toBe(false);
      expect(closedSessionIds).toEqual(["idle"]);
    } finally {
      httpServer.close();
    }
  });
});

// The cap check at admission runs after `createMcpServer` has already built all
// 49 tools, so a concurrent burst can hold one server per in-flight request
// while the map is still under the cap. These pin the claim being taken up
// front, which is the only point at which the heap has not been committed yet.
describe("session capacity is reserved before the server is built", () => {
  function fillToCapacity(): void {
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      admitMcpSession(
        `session-${index}`,
        makeSession(`session-${index}`, 1000 + index)
      );
    }
  }

  it("frees a slot when the claim is taken, not when the session is admitted", () => {
    fillToCapacity();
    expect(mcpSessions.size).toBe(MAX_SESSIONS);

    const reservation = claimSlot();

    expect(mcpSessions.size).toBe(MAX_SESSIONS - 1);
    expect(closedSessionIds).toEqual(["session-0"]);

    releaseMcpSessionCapacity(reservation);
  });

  it("refuses a claim once every slot is held by a server being built", () => {
    fillToCapacity();

    const claims = Array.from({ length: MAX_SESSIONS }, () => claimSlot());
    // Each claim evicted one session to make room for itself, so the table is
    // now empty and every slot is committed to a server mid-build.
    expect(mcpSessions.size).toBe(0);
    expect(closedSessionIds).toHaveLength(MAX_SESSIONS);

    // Counting the in-flight servers is what makes this reachable; refusing is
    // what makes it a bound. Granting it would be the (MAX_SESSIONS + 1)-th
    // live McpServer with nothing left to evict in exchange.
    expect(reserveMcpSessionCapacity()).toBeUndefined();
    expect(closedSessionIds).toHaveLength(MAX_SESSIONS);

    releaseMcpSessionCapacity(claims[0]);
    // A released slot is immediately re-claimable, so the refusal is a bound,
    // not a latch that wedges the server once a burst has hit it.
    const reclaimed = reserveMcpSessionCapacity();
    expect(reclaimed).toBeDefined();

    for (const claim of claims.slice(1)) {
      releaseMcpSessionCapacity(claim);
    }
    if (reclaimed) {
      releaseMcpSessionCapacity(reclaimed);
    }
  });

  it("counts every server that is built but not yet admitted", () => {
    fillToCapacity();

    const reservations = [claimSlot(), claimSlot(), claimSlot()];

    // Three handlers are mid-build. Live servers are map entries plus claims, so
    // room has to exist for all three at once, not one at a time.
    expect(mcpSessions.size).toBe(MAX_SESSIONS - 3);

    for (const reservation of reservations) {
      releaseMcpSessionCapacity(reservation);
    }
  });

  it("does not double-release a claim that admission already consumed", () => {
    fillToCapacity();
    const reservation = claimSlot();

    admitMcpSession("admitted", makeSession("admitted", 9999), reservation);
    // The handler's `finally` always fires; releasing a consumed claim a second
    // time must not hand a free slot to some other in-flight request.
    releaseMcpSessionCapacity(reservation);

    const afterAdmit = mcpSessions.size;
    const second = claimSlot();
    expect(mcpSessions.size).toBe(afterAdmit - 1);
    releaseMcpSessionCapacity(second);
  });
});

describe("cleanupExpiredMcpSessions", () => {
  it("closes the server of every session it drops", () => {
    const nowMs = 1_000_000;
    mcpSessions.set("expired", makeSession("expired", nowMs - TTL_MS - 1));
    mcpSessions.set("live", makeSession("live", nowMs));

    cleanupExpiredMcpSessions(nowMs);

    expect(mcpSessions.has("expired")).toBe(false);
    expect(mcpSessions.has("live")).toBe(true);
    expect(closedSessionIds).toEqual(["expired"]);
  });
});
