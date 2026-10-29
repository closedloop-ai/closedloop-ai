import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SESSION_MESH_MESSAGE_KIND } from "@repo/api/src/types/session-mesh";
import { vi } from "vitest";
import type { SessionMeshHookEvent } from "../src/main/session-mesh/session-mesh-hook-contract.js";
import {
  SessionMeshRuntime,
  type SessionMeshRuntimeOptions,
} from "../src/main/session-mesh/session-mesh-runtime.js";
import { SESSION_MESH_RUNTIME_MARKER } from "../src/main/session-mesh/session-mesh-runtime-marker.js";
import type { ResolvedSessionMeshWorkspace } from "../src/main/session-mesh/session-mesh-workspace.js";

export const meshToken = "b".repeat(64);
export const meshRepository = "github.com/org/cov-repo";
export const meshCwd = "/repo";

export type MeshIdentity = {
  userId: string;
  organizationId: string;
  computeTargetId: string;
};
export const identityA: MeshIdentity = {
  userId: "user-a",
  organizationId: "org-a",
  computeTargetId: "desktop-a",
};
export const identityB: MeshIdentity = {
  userId: "user-b",
  organizationId: "org-b",
  computeTargetId: "desktop-b",
};

export function sourceKeyOf(identity: MeshIdentity): string {
  return JSON.stringify([
    identity.organizationId,
    identity.userId,
    identity.computeTargetId,
  ]);
}

export type MeshRequest = {
  path: string;
  query: URLSearchParams;
  method: string;
  body: Record<string, unknown> | null;
};

type MessageKind = (typeof SESSION_MESH_MESSAGE_KIND)[number];

export function meshDelivery(input: {
  id: string;
  recipientAgentId: string;
  summary: string;
  kind?: MessageKind;
  authorAgentId?: string | null;
  /** The server's own relevance verdict, as the inbox row carries it. */
  relevance?: Record<string, unknown>;
  paths?: string[];
  /** When the message stops being delivered — a `claim`'s live window. */
  expiresAt?: string;
}) {
  return {
    id: `delivery-${input.id}`,
    messageId: input.id,
    recipientAgentId: input.recipientAgentId,
    status: "queued",
    relevance: input.relevance ?? {},
    queuedAt: "2026-09-01T00:00:00.000Z",
    deliveredAt: null,
    acknowledgedAt: null,
    failureReason: null,
    message: {
      id: input.id,
      kind: input.kind ?? "claim",
      summary: input.summary,
      authorAgentId:
        input.authorAgentId === undefined ? "codex:peer" : input.authorAgentId,
      repository: meshRepository,
      revision: "rev-1",
      paths: input.paths ?? [],
      symbols: [],
      context: {},
      sensitivity: "normal",
      replyToMessageId: null,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    },
  };
}

function rosterView(agentId: string) {
  return {
    agentId,
    repository: meshRepository,
    revision: "rev-1",
    dirtyStateHash: null,
    configurationHash: null,
    harness: "codex",
    capabilities: [],
    lineage: {},
    context: {},
    paths: [],
    symbols: [],
    user: { id: "peer-user", firstName: null, lastName: null },
    expiresAt: "2026-09-01T00:00:00.000Z",
  };
}

export function meshEvent(
  hookType: string,
  data: Record<string, unknown> = {},
  harness: SessionMeshHookEvent["harness"] = "claude"
): SessionMeshHookEvent {
  return { harness, hookType, localToken: meshToken, data };
}

export function sessionEvent(
  hookType: string,
  sessionId = "session-1",
  extra: Record<string, unknown> = {}
): SessionMeshHookEvent {
  return meshEvent(hookType, { session_id: sessionId, cwd: meshCwd, ...extra });
}

function envelope(data: unknown): Response {
  return Response.json({ success: true, data });
}

type Responder = (
  request: MeshRequest
) => Response | undefined | Promise<Response | undefined>;

const createdDirectories: string[] = [];
const createdRuntimes: SessionMeshRuntime[] = [];

/** One Session Mesh runtime wired to a recording cloud fake and a real
 * on-disk ledger directory. Everything created here is torn down by
 * {@link disposeMeshHarnesses}. */
export function createMeshHarness(directory?: string) {
  const dir =
    directory ?? mkdtempSync(path.join(os.tmpdir(), "mesh-cov-iss11283-"));
  if (!directory) {
    createdDirectories.push(dir);
  }
  const requests: MeshRequest[] = [];
  const logs: string[] = [];
  const state: {
    identity: MeshIdentity | null;
    now: number;
    inboxFor: (agentId: string) => ReturnType<typeof meshDelivery>[];
    roster: () => string[];
    rosterCursor?: string;
    respond: Responder;
  } = {
    identity: identityA,
    now: 1_000_000,
    inboxFor: () => [],
    roster: () => ["codex:peer"],
    respond: () => undefined,
  };
  const resolveWorkspace = vi.fn(
    (
      _cwd: string,
      file?: string,
      files?: string[]
    ): Promise<ResolvedSessionMeshWorkspace> =>
      Promise.resolve({
        repository: meshRepository,
        revision: "rev-1",
        paths: files ?? (file ? [file] : []),
        symbols: [],
      })
  );
  const fetchFake = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(String(input));
    const request: MeshRequest = {
      path: url.pathname,
      query: url.searchParams,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    requests.push(request);
    const custom = await state.respond(request);
    if (custom) {
      return custom;
    }
    return defaultResponse(request, state);
  };
  const options: SessionMeshRuntimeOptions = {
    directory: dir,
    localToken: meshToken,
    getIdentity: () => state.identity,
    getAccessToken: () => Promise.resolve("access-token"),
    getApiOrigin: () => "https://api.example.test",
    invalidateAccessToken: () => undefined,
    resolveWorkspace,
    fetch: fetchFake,
    log: (message) => logs.push(message),
    now: () => state.now,
    monotonicNow: () => 0,
  };
  const ledgerFile = path.join(dir, "delivery-ledger.json");
  const markerFile = path.join(dir, SESSION_MESH_RUNTIME_MARKER);
  return {
    directory: dir,
    options,
    requests,
    logs,
    state,
    resolveWorkspace,
    ledgerFile,
    markerFile,
    runtime(overrides: Partial<SessionMeshRuntimeOptions> = {}) {
      const runtime = new SessionMeshRuntime({ ...options, ...overrides });
      createdRuntimes.push(runtime);
      return runtime;
    },
    ledger(): {
      operations: Array<{
        id: string;
        sourceKey: string;
        path: string;
        method: string;
        body: Record<string, unknown>;
        attemptCount: number;
        nextAttemptAt: string | null;
        lastError: string | null;
      }>;
      receipts: Record<
        string,
        {
          agentId: string;
          messageIds: string[];
          evidence?: Record<string, unknown>;
        }
      >;
    } {
      return JSON.parse(readFileSync(ledgerFile, "utf8"));
    },
    markerExists: () => existsSync(markerFile),
    count: (predicate: (request: MeshRequest) => boolean) =>
      requests.filter(predicate).length,
  };
}

function defaultResponse(
  request: MeshRequest,
  state: {
    inboxFor: (agentId: string) => ReturnType<typeof meshDelivery>[];
    roster: () => string[];
    rosterCursor?: string;
  }
): Response {
  if (request.method === "GET" && request.path === "/session-mesh/inbox") {
    return envelope({
      messages: state.inboxFor(request.query.get("agentId") ?? ""),
    });
  }
  if (request.method === "GET" && request.path === "/session-mesh/presence") {
    return envelope({
      agents: state.roster().map(rosterView),
      ...(state.rosterCursor ? { nextCursor: state.rosterCursor } : {}),
    });
  }
  if (request.method === "DELETE") {
    return envelope({ removed: 1 });
  }
  if (request.path === "/session-mesh/presence") {
    return envelope({ presence: { agentId: request.body?.agentId } });
  }
  if (request.path === "/session-mesh/messages") {
    return envelope({ message: { id: randomUUID() } });
  }
  if (request.path === "/session-mesh/feedback") {
    return envelope({ event: { id: "feedback-1" } });
  }
  return envelope({ updated: 1 });
}

export function isPresencePost(request: MeshRequest): boolean {
  return request.method === "POST" && request.path === "/session-mesh/presence";
}

export function isInboxGet(request: MeshRequest): boolean {
  return request.method === "GET" && request.path === "/session-mesh/inbox";
}

/** Resolves to the promise's value if it settled within one macrotask,
 * otherwise to the string "pending". Use it only to observe an IMMEDIATE
 * settlement, such as a refusal the runtime returns as an already-resolved
 * promise. A "pending" result proves only that the promise had not settled
 * after one macrotask, not that it is parked, so no test asserts "pending";
 * parked waiters are proven by releasing them and checking what they get. */
export function valueAfterOneMacrotask<T>(
  promise: Promise<T>
): Promise<T | "pending"> {
  return Promise.race([
    promise,
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

export function disposeMeshHarnesses(): void {
  for (const runtime of createdRuntimes.splice(0)) {
    runtime.stop();
  }
  for (const dir of createdDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
