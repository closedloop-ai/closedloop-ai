/**
 * @file mock-cloud-server.ts
 * @description Stage-0 soak-harness mock of the cloud boundary the Desktop
 * sync lanes talk to. Mocks at the HTTP/socket boundary ONLY — everything
 * inside the app (outbox drain, chunker, compression, retry ladders, db-host)
 * is the real production code under test.
 *
 * Two surfaces:
 *  1. HTTP mock of the BFF (`apiOrigin`): `/desktop/session/refresh`,
 *     `/desktop/identity`, and the sync ingest endpoints — most importantly
 *     `POST /desktop/agent-sessions/sync`, which records every received
 *     session/chunk id (raw receive count AND deduped set, so re-send waste is
 *     measured, not hidden) and acks `{ success: true, data: { synced: true } }`.
 *  2. Socket.IO mock of the CloudRelay (`relayOrigin`, namespace
 *     `/desktop-gateway`): answers `desktop.hello` with a `desktop.hello.ack`
 *     carrying the pinned computeTargetId and the server capabilities
 *     (`agentSessionSync`, `agentSessionSyncCompression`,
 *     `agentSessionSyncActivityChunking`) so the app exercises the REAL gzip +
 *     chunking paths, exactly as production negotiates them.
 *
 * The dedupe model mirrors the real cloud upsert (FEA-3788): a session is keyed
 * by `externalSessionId`; a chunked session (chunk.index/chunk.total) counts as
 * ASSEMBLED once a full contiguous chunk sequence for one (sessionId,
 * dataRevision) has been received. Re-sends are accepted idempotently (the real
 * upsert is idempotent) — they inflate `rawSessionReceives` but not the deduped
 * set. ISS-6101: complete deliveries are counted BOTH per session and per
 * (session, dataRevision), because the upsert REPLACES a session when the
 * revision differs — so only a repeat of the SAME revision is a duplicate.
 *
 * NOT under test here, deliberately: PoP signature verification, real auth
 * (any bearer token is accepted; the fixed access token is what the app is
 * GIVEN), rate limiting.
 */

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { gunzipSync } from "node:zlib";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "@repo/api/src/types/agent-session";
import { Server as SocketIoServer } from "socket.io";
import {
  buildReadBackResponse,
  type ContentState,
  ContentViolationKind,
  freshContentState,
  type ReadBackResponse,
  recordBatchViolation,
  recordSessionContent,
} from "./soak-cloud-content";

export const MOCK_ACCESS_TOKEN = "soak-harness-access-token";
export const MOCK_REFRESH_TOKEN = "soak-harness-refresh-token";
export const MOCK_ROTATED_REFRESH_TOKEN = "soak-harness-rotated-refresh-token";
export const MOCK_USER_ID = "soak-harness-user";
export const MOCK_ORGANIZATION_ID = "soak-harness-organization";
export const MOCK_GATEWAY_ID = "50a45047-50a4-4507-8a45-50a450475047";
const TOKEN_EXPIRY = "2027-12-31T00:00:00.000Z";
/**
 * The wire schema version this mock — standing in for the CLOUD — requires, read
 * from the cloud's own contract in `@repo/api`. That is the constant
 * `apps/api/lib/desktop-agent-sessions-schema.ts` re-exports and pins with
 * `z.literal(...)`, so the mock enforces the same version the real ingest does
 * instead of re-declaring the literal.
 *
 * Importing it does NOT make the check circular: the app under test declares its
 * own copy in `apps/desktop/src/main/agent-sync/agent-session-sync-contract.ts`,
 * a separate declaration this module deliberately does not read. The mock
 * therefore still notices the desktop producer drifting away from the cloud —
 * which is the only drift worth noticing — while avoiding the copied literal.
 *
 * A mismatch is RECORDED, not rejected: the mock stays version-skew tolerant
 * like the real cloud, and the harness scores the violation.
 */
const EXPECTED_SYNC_SCHEMA_VERSION = AGENT_SESSION_SYNC_SCHEMA_VERSION;

/** One raw receive of one session payload (a whole session or one chunk). */
export type SessionReceive = {
  externalSessionId: string;
  chunkIndex: number | null;
  chunkTotal: number | null;
  dataRevision: number | null;
  encoding: "gzip" | "identity";
  batchId: string;
  syncMode: string;
  receivedAt: string;
};

export type MockCloudStats = {
  helloCount: number;
  refreshCount: number;
  identityCount: number;
  /** Every session payload received, in order (chunks counted individually). */
  rawSessionReceives: number;
  /** Distinct externalSessionIds with at least one fully-assembled delivery. */
  syncedSessionIds: string[];
  /** sessionId -> raw payload receive count (re-send waste per session). */
  receivesBySession: Record<string, number>;
  /**
   * sessionId -> COMPLETE deliveries (an unchunked payload, or a fully
   * assembled chunk sequence), across ALL data revisions. >1 means the session
   * reached the cloud more than once — which a data-revision rebuild makes
   * CORRECT, so this is a waste/volume signal, not a violation. Score
   * duplicates off {@link deliveriesBySessionRevision}.
   */
  deliveriesBySession: Record<string, number>;
  /**
   * ISS-6101: `${sessionId}#${dataRevision}` -> COMPLETE deliveries of that
   * exact revision. This is the DUPLICATE oracle: the real cloud upserts a
   * session keyed by id and REPLACES it when `dataRevision` differs, so a
   * second delivery carrying a NEWER revision is a required re-sync (the boot
   * data-revision rebuild re-derives sessions and re-enqueues them mid-cycle),
   * while a second delivery of the SAME revision is the same payload arriving
   * twice — genuine duplicate delivery, with or without a crash.
   *
   * Contains ONLY real revisions (integer >= 1, production's floor). Deliveries
   * carrying no usable revision are counted in
   * {@link unrevisionedDeliveriesBySession} instead — see `recordDelivery` for
   * why they cannot be scored on this axis.
   */
  deliveriesBySessionRevision: Record<string, number>;
  /**
   * ISS-6101: sessionId -> COMPLETE deliveries that declared no usable
   * `dataRevision` (absent, or a value below production's `.int().min(1)` floor
   * such as the ISS-4572 `-1` import-pending sentinel).
   *
   * Reported, never failed on its own: production types the field `.nullish()`,
   * so an absent revision is legal, and an unusable one is already scored as a
   * `data_revision_invalid` content violation. What this exists to prevent is
   * the third option — such a delivery being silently dropped from every
   * revision-keyed oracle and so leaving no trace at all.
   */
  unrevisionedDeliveriesBySession: Record<string, number>;
  /**
   * ISS-6101: `${sessionId}#${dataRevision}` for each complete delivery whose
   * revision was BELOW the session's forward-only bar. The real upsert rejects
   * such a payload as stale, so the send is wasted work that would silently not
   * land. Keying duplicates on the revision must not make a revision REGRESSION
   * invisible.
   *
   * The bar is `max(committed, staged)`, NOT the committed revision alone —
   * production folds `pendingChunkRevision` (written by chunk 0, before its
   * sequence can complete) into the same high-water mark. See
   * `highWaterRevision`.
   */
  staleRevisionDeliveries: string[];
  /**
   * Raw receives that were NECESSARY to produce the recorded deliveries: 1 per
   * unchunked delivery, and `chunk.total` per fully-assembled chunk sequence.
   * Subtracting this (rather than the delivery COUNT) from `rawSessionReceives`
   * is what keeps ordinary activity chunking — which this mock always
   * negotiates on — out of the re-send-waste metric.
   *
   * A STALE delivery is deliberately excluded: the cloud would reject it, so
   * its receives bought nothing and belong in `resendWaste` rather than netting
   * out of it.
   */
  deliveredReceiveUnits: number;
  /** Sessions received in a chunked sequence that never completed. */
  incompleteChunkSessions: string[];
  invocationPartReceives: number;
  componentBatchReceives: number;
  transcriptRequests: number;
  /** Paths of requests the mock did not recognize (404s served). */
  unknownPaths: string[];
  gzipBatches: number;
  identityBatches: number;
  /** Batches whose declared `schemaVersion` was not the expected contract version. */
  unexpectedSchemaVersions: number[];
  /**
   * Batches that declared NO usable `schemaVersion` at all (absent, `null`, or
   * non-numeric). Production pins the field with `z.literal(...)`, so this is a
   * rejection there, not a tolerated omission.
   */
  batchesMissingSchemaVersion: number;
};

export type MockCloudServer = {
  apiOrigin: string;
  relayOrigin: string;
  computeTargetId: string;
  /** Path the harness GETs for the ISS-6099 read-back pass. */
  readBackPath: string;
  stats: () => MockCloudStats;
  /**
   * ISS-6099 read-back, taken IN PROCESS. `readBackPath` serves the identical
   * corpus over HTTP; the harness uses the HTTP route so the read-back really
   * crosses the boundary, and this accessor exists for focused tests.
   */
  readBack: () => ReadBackResponse;
  /** Reset per-cycle counters (keeps servers listening). */
  resetStats: () => void;
  close: () => Promise<void>;
};

/**
 * ISS-6099 read-back route. Deliberately under `/desktop/` so it shares the
 * mock's origin, and deliberately NOT a path the app ever calls, so a stray
 * client request could never be mistaken for the harness's own read-back.
 */
export const READ_BACK_PATH = "/desktop/agent-sessions/soak-readback";
/**
 * Bound on the ISS-6099 read-back request. Generous because the response
 * carries one index entry per delivered session (~3,000 on the reference
 * snapshot), but explicit so a wedged read-back fails the cycle instead of
 * hanging the battery.
 */
const READ_BACK_TIMEOUT_MS = 60_000;

type ChunkAssembly = {
  total: number;
  seen: Set<number>;
};

type MockState = {
  helloCount: number;
  refreshCount: number;
  identityCount: number;
  rawReceives: SessionReceive[];
  synced: Set<string>;
  deliveries: Map<string, number>;
  /** ISS-6101: keyed `${sessionId}#${dataRevision}` — see the stat's doc. */
  deliveriesByRevision: Map<string, number>;
  /** ISS-6101: deliveries with no usable revision — see the stat's doc. */
  unrevisionedDeliveries: Map<string, number>;
  /** ISS-6101: highest revision completely delivered per session, so far. */
  highestRevisionBySession: Map<string, number>;
  /**
   * ISS-6101: the revision an OPEN chunk sequence has staged for a session —
   * production's `pendingChunkRevision`, set by chunk 0 and cleared when the
   * sequence commits. Part of the forward-only bar; see `highWaterRevision`.
   */
  pendingRevisionBySession: Map<string, number>;
  /** ISS-6101: deliveries below that high-water mark — see the stat's doc. */
  staleRevisionDeliveries: string[];
  /** Raw receives consumed by the deliveries above — see the stat's doc. */
  deliveredReceiveUnits: number;
  /** key: `${sessionId}#${dataRevision}` for chunked sequences. */
  assemblies: Map<string, ChunkAssembly>;
  invocationPartReceives: number;
  componentBatchReceives: number;
  transcriptRequests: number;
  unknownPaths: string[];
  /** ISS-6099: what was inside the envelopes. See `soak-cloud-content.ts`. */
  content: ContentState;
  unexpectedSchemaVersions: Set<number>;
  batchesMissingSchemaVersion: number;
};

function freshState(): MockState {
  return {
    helloCount: 0,
    refreshCount: 0,
    identityCount: 0,
    rawReceives: [],
    synced: new Set(),
    deliveries: new Map(),
    deliveriesByRevision: new Map(),
    unrevisionedDeliveries: new Map(),
    highestRevisionBySession: new Map(),
    pendingRevisionBySession: new Map(),
    staleRevisionDeliveries: [],
    deliveredReceiveUnits: 0,
    assemblies: new Map(),
    invocationPartReceives: 0,
    componentBatchReceives: 0,
    transcriptRequests: 0,
    unknownPaths: [],
    content: freshContentState(),
    unexpectedSchemaVersions: new Set(),
    batchesMissingSchemaVersion: 0,
  };
}

export async function startMockCloudServer(options: {
  computeTargetId: string;
  /** Optional injected fault: when set, sync POSTs 503 until the flag clears. */
  isSyncOutage?: () => boolean;
}): Promise<MockCloudServer> {
  let state = freshState();

  const httpServer = createServer((request, response) => {
    routeHttp(request, response, state, options).catch(() => undefined);
  });
  await listen(httpServer);

  const relayHttpServer = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const io = new SocketIoServer(relayHttpServer, {
    transports: ["websocket"],
  });
  io.of("/desktop-gateway").on("connection", (socket) => {
    socket.on("desktop.hello", (payload: { messageId?: string }) => {
      state.helloCount += 1;
      socket.emit("desktop.hello.ack", {
        protocolVersion: "1",
        messageId: `ack-${payload?.messageId ?? state.helloCount}`,
        timestamp: new Date().toISOString(),
        computeTargetId: options.computeTargetId,
        sessionId: `soak-relay-session-${state.helloCount}`,
        serverTime: new Date().toISOString(),
        serverCapabilities: {
          agentSessionSync: true,
          agentSessionSyncCompression: true,
          agentSessionSyncActivityChunking: true,
        },
      });
    });
    // Presence / command acks are accepted and dropped — this harness measures
    // the sync lanes, not the Engineer command path.
    socket.on("desktop.presence", () => undefined);
  });
  await listen(relayHttpServer);

  return {
    apiOrigin: originOf(httpServer),
    relayOrigin: originOf(relayHttpServer),
    computeTargetId: options.computeTargetId,
    readBackPath: READ_BACK_PATH,
    stats: () => snapshotStats(state),
    readBack: () => buildReadBackResponse(state.content),
    resetStats: () => {
      state = freshState();
    },
    close: async () => {
      io.close();
      await closeServer(relayHttpServer);
      await closeServer(httpServer);
    },
  };
}

function snapshotStats(state: MockState): MockCloudStats {
  const receivesBySession: Record<string, number> = Object.create(null);
  let gzipBatches = 0;
  let identityBatches = 0;
  const batchesSeen = new Set<string>();
  for (const receive of state.rawReceives) {
    receivesBySession[receive.externalSessionId] =
      (receivesBySession[receive.externalSessionId] ?? 0) + 1;
    if (!batchesSeen.has(receive.batchId)) {
      batchesSeen.add(receive.batchId);
      if (receive.encoding === "gzip") {
        gzipBatches += 1;
      } else {
        identityBatches += 1;
      }
    }
  }
  const incomplete: string[] = [];
  for (const [key, assembly] of state.assemblies) {
    // A completed assembly's `seen` is cleared on delivery, so only a
    // partially-filled set is a genuinely incomplete sequence.
    if (assembly.seen.size > 0 && assembly.seen.size < assembly.total) {
      incomplete.push(key);
    }
  }
  const deliveriesBySession: Record<string, number> = Object.create(null);
  for (const [id, count] of state.deliveries) {
    deliveriesBySession[id] = count;
  }
  const deliveriesBySessionRevision: Record<string, number> =
    Object.create(null);
  for (const [key, count] of state.deliveriesByRevision) {
    deliveriesBySessionRevision[key] = count;
  }
  const unrevisionedDeliveriesBySession: Record<string, number> =
    Object.create(null);
  for (const [id, count] of state.unrevisionedDeliveries) {
    unrevisionedDeliveriesBySession[id] = count;
  }
  return {
    helloCount: state.helloCount,
    refreshCount: state.refreshCount,
    identityCount: state.identityCount,
    rawSessionReceives: state.rawReceives.length,
    syncedSessionIds: [...state.synced].sort(),
    receivesBySession,
    deliveriesBySession,
    deliveriesBySessionRevision,
    unrevisionedDeliveriesBySession,
    staleRevisionDeliveries: [...state.staleRevisionDeliveries],
    deliveredReceiveUnits: state.deliveredReceiveUnits,
    incompleteChunkSessions: incomplete.sort(),
    invocationPartReceives: state.invocationPartReceives,
    componentBatchReceives: state.componentBatchReceives,
    transcriptRequests: state.transcriptRequests,
    unknownPaths: [...new Set(state.unknownPaths)].sort(),
    gzipBatches,
    identityBatches,
    unexpectedSchemaVersions: [...state.unexpectedSchemaVersions].sort(
      (a, b) => a - b
    ),
    batchesMissingSchemaVersion: state.batchesMissingSchemaVersion,
  };
}

async function routeHttp(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState,
  options: { isSyncOutage?: () => boolean }
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (request.method === "POST" && pathname === "/desktop/session/refresh") {
    await handleSessionRefresh(request, response, state);
    return;
  }
  if (request.method === "GET" && pathname === "/desktop/identity") {
    handleIdentity(response, state);
    return;
  }
  // Checked BEFORE the sync ingest routes so a read-back can never be counted
  // as a delivery, and before the unknown-path 404 so it never pollutes
  // `unknownPaths`.
  if (request.method === "GET" && pathname === READ_BACK_PATH) {
    await drainBody(request);
    writeJson(response, buildReadBackResponse(state.content));
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/desktop/agent-sessions/sync"
  ) {
    await handleAgentSessionSync(request, response, state, options);
    return;
  }
  if (
    request.method === "POST" &&
    pathname === "/desktop/agent-sessions/invocations/sync"
  ) {
    await handleInvocationPartSync(request, response, state);
    return;
  }
  if (request.method === "POST" && pathname === "/desktop/components/sync") {
    await handleComponentSync(request, response, state);
    return;
  }
  if (pathname.includes("/transcript")) {
    await handleTranscript(request, response, state);
    return;
  }
  await handleUnknownPath(request, response, state, pathname);
}

/**
 * Classify a batch's declared `schemaVersion` against the cloud contract.
 *
 * Production pins the field with `z.literal(AGENT_SESSION_SYNC_SCHEMA_VERSION)`,
 * so ABSENT, `null`, and a non-numeric value are all rejected there exactly as a
 * wrong number is. Recording only numeric mismatches therefore scored the worst
 * case — a producer that stopped emitting the field at all — as a clean batch.
 * Absence is tracked separately from the wrong-number set only because that set
 * is `number[]`; both feed the same violation kind when the cycle is scored.
 */
function recordSchemaVersion(state: MockState, declared: unknown): void {
  if (typeof declared === "number") {
    if (declared !== EXPECTED_SYNC_SCHEMA_VERSION) {
      state.unexpectedSchemaVersions.add(declared);
    }
    return;
  }
  state.batchesMissingSchemaVersion += 1;
}

/**
 * Check the batch's `sessionCount` against the sessions it actually carried.
 *
 * Production refines the payload with
 * `sessionCount !== sessions.length -> session_count_mismatch` and types the
 * field `z.number().int().nonnegative()`, so an absent, non-numeric or
 * disagreeing count is rejected there. The mock previously ignored the field
 * entirely and drained the batch cleanly, which is the same
 * accepts-what-production-rejects blindness as the schemaVersion case. Recorded
 * rather than rejected, so the mock stays version-skew tolerant.
 */
function recordSessionCount(
  state: MockState,
  declared: unknown,
  actual: number
): void {
  if (
    typeof declared !== "number" ||
    !Number.isInteger(declared) ||
    declared < 0
  ) {
    recordBatchViolation(
      state.content,
      ContentViolationKind.SessionCountMismatch,
      `batch declared no usable sessionCount while carrying ${actual} sessions`
    );
    return;
  }
  if (declared !== actual) {
    recordBatchViolation(
      state.content,
      ContentViolationKind.SessionCountMismatch,
      `batch declared sessionCount ${declared} while carrying ${actual} sessions`
    );
  }
}

function recordSyncBatch(
  state: MockState,
  batch: unknown,
  contentEncoding: string | string[] | undefined
): void {
  const parsed = batch as {
    batchId?: string;
    syncMode?: string;
    // `unknown` for the same reason as `schemaVersion`: an absent or
    // non-numeric count is the regression this has to be able to see.
    sessionCount?: unknown;
    // `unknown`, not `number`: an ABSENT or non-numeric `schemaVersion` is
    // exactly the producer regression this must be able to see, and typing it
    // `number` would let the classifier below assume the shape it is checking.
    schemaVersion?: unknown;
    sessions?: {
      externalSessionId?: string;
      dataRevision?: number | null;
      chunk?: { index: number; total: number } | null;
    }[];
  };
  const batchId = parsed.batchId ?? "unknown-batch";
  const syncMode = parsed.syncMode ?? "unknown";
  const encoding = contentEncoding === "gzip" ? "gzip" : "identity";
  recordSchemaVersion(state, parsed.schemaVersion);
  const sessions = parsed.sessions ?? [];
  recordSessionCount(state, parsed.sessionCount, sessions.length);
  for (const session of sessions) {
    const id = session.externalSessionId ?? "unknown-session";
    // ISS-6099: the payload BODY, not just its envelope. Recorded before the
    // envelope bookkeeping so a content violation is retained even for a
    // receive the envelope path treats as an ordinary chunk.
    recordSessionContent(
      state.content,
      session as Record<string, unknown>,
      session.chunk ?? null
    );
    state.rawReceives.push({
      externalSessionId: id,
      chunkIndex: session.chunk?.index ?? null,
      chunkTotal: session.chunk?.total ?? null,
      dataRevision: session.dataRevision ?? null,
      encoding,
      batchId,
      syncMode,
      receivedAt: new Date().toISOString(),
    });
    recordEnvelopeDelivery(
      state,
      id,
      session.dataRevision ?? null,
      session.chunk ?? null
    );
  }
}

/**
 * The ENVELOPE half of one receive: which ids the cloud considers delivered,
 * how many times, and what those deliveries cost in raw receives. Content lives
 * in `soak-cloud-content.ts`; keeping the two halves in separate functions is
 * also what keeps `recordSyncBatch` under the cognitive-complexity ceiling.
 */
function recordEnvelopeDelivery(
  state: MockState,
  id: string,
  dataRevision: number | null,
  chunk: { index: number; total: number } | null
): void {
  if (!chunk) {
    recordDelivery(state, id, dataRevision, 1);
    return;
  }
  if (chunk.index === 0) {
    stagePendingRevision(state, id, dataRevision);
  }
  const key = `${id}#${dataRevision ?? "null"}#${chunk.total}`;
  let assembly = state.assemblies.get(key);
  if (!assembly) {
    assembly = { total: chunk.total, seen: new Set() };
    state.assemblies.set(key, assembly);
  }
  assembly.seen.add(chunk.index);
  if (assembly.seen.size >= assembly.total) {
    // The whole sequence — not one receive — is what this delivery cost.
    recordDelivery(state, id, dataRevision, assembly.total);
    // Reset so a full re-send of the same sequence counts as a SECOND
    // delivery instead of vanishing into an already-satisfied set.
    assembly.seen.clear();
  }
}

/**
 * ISS-6101: stage the revision chunk 0 has opened a sequence for, BEFORE that
 * sequence can complete.
 *
 * Production's `resolveRevisionStanding`
 * (`apps/api/app/agent-sessions/service/chunk-revision-gating.ts`) measures the
 * forward-only bar against `max(existingRevision, existingPendingRevision)`,
 * and `pendingChunkRevision` is written by chunk 0. A mock whose bar advanced
 * only on full assembly would score the interleaving rev-75-chunk-0 →
 * rev-72-whole → rev-75-chunk-1 as clean, while production rejects the rev-72
 * payload as stale — exactly the regression this oracle exists to catch.
 *
 * Staged only when the revision is not BELOW the bar, mirroring `shouldReplace`:
 * a stale chunk 0 is foreign there and leaves the marker alone. (Equality is
 * staged rather than split out, because the bar is a `max` — restaging the
 * value already standing cannot move it.)
 */
function stagePendingRevision(
  state: MockState,
  id: string,
  dataRevision: number | null
): void {
  if (!isRealRevision(dataRevision)) {
    return;
  }
  const bar = highWaterRevision(state, id);
  if (bar === null || dataRevision >= bar) {
    state.pendingRevisionBySession.set(id, dataRevision);
  }
}

/**
 * ISS-6101: the forward-only bar an incoming revision is measured against — the
 * highest revision this session has any state for, COMMITTED or STAGED. Mirrors
 * production's `maxRevision(existingRevision, existingPendingRevision)`.
 */
function highWaterRevision(state: MockState, id: string): number | null {
  const committed = state.highestRevisionBySession.get(id);
  const staged = state.pendingRevisionBySession.get(id);
  if (committed === undefined) {
    return staged ?? null;
  }
  if (staged === undefined) {
    return committed;
  }
  return Math.max(committed, staged);
}

function originOf(server: HttpServer): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function listen(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Sockets held open by keep-alive would hang close; sever them.
    server.closeAllConnections?.();
  });
}

function writeJson(response: ServerResponse, data: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(data));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function drainBody(request: IncomingMessage): Promise<void> {
  // Consume and discard so keep-alive parsing stays coherent.
  for await (const _chunk of request) {
    // discard
  }
}

/** Echoed fields the ISS-4976 client-side `parseAck` requires back verbatim. */
type InvocationPartEcho = {
  protocolVersion?: unknown;
  externalGenerationId?: unknown;
  partIndex?: unknown;
  partHash?: unknown;
};

async function handleSessionRefresh(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState
): Promise<void> {
  state.refreshCount += 1;
  await drainBody(request);
  writeJson(response, {
    accessToken: MOCK_ACCESS_TOKEN,
    accessTokenExpiresAt: TOKEN_EXPIRY,
    refreshToken: MOCK_ROTATED_REFRESH_TOKEN,
    refreshTokenExpiresAt: TOKEN_EXPIRY,
    userId: MOCK_USER_ID,
    organizationId: MOCK_ORGANIZATION_ID,
  });
}

function handleIdentity(response: ServerResponse, state: MockState): void {
  state.identityCount += 1;
  writeJson(response, {
    userId: MOCK_USER_ID,
    organizationId: MOCK_ORGANIZATION_ID,
    email: "soak@example.test",
    firstName: "Soak",
    lastName: "Harness",
    organizationName: "Soak Org",
    organizationSlug: "soak-org",
    sessionSyncPolicyEnabled: true,
    sessionSyncPolicySupported: true,
  });
}

async function handleAgentSessionSync(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState,
  options: { isSyncOutage?: () => boolean }
): Promise<void> {
  if (options.isSyncOutage?.()) {
    await drainBody(request);
    response.statusCode = 503;
    writeJson(response, { success: false, error: "injected outage" });
    return;
  }
  const body = await readBody(request);
  let batch: unknown;
  try {
    const raw =
      request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body;
    batch = JSON.parse(raw.toString("utf8"));
  } catch {
    response.statusCode = 400;
    writeJson(response, { success: false, error: "unparseable body" });
    return;
  }
  recordSyncBatch(state, batch, request.headers["content-encoding"]);
  writeJson(response, { success: true, data: { synced: true } });
}

/**
 * Invocation-parts lane. The client requires the ack to ECHO protocolVersion/
 * externalGenerationId/partIndex/partHash from the request part (ISS-4976
 * `parseAck`), so the body is parsed and echoed. One part per request in the
 * production sender.
 */
async function handleInvocationPartSync(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState
): Promise<void> {
  const body = await readBody(request);
  let part: InvocationPartEcho | null = null;
  let protocolVersion: unknown = null;
  try {
    const parsedBody = JSON.parse(body.toString("utf8")) as {
      protocolVersion?: unknown;
      parts?: unknown[];
    };
    protocolVersion = parsedBody.protocolVersion ?? null;
    part = (parsedBody.parts?.[0] ?? null) as InvocationPartEcho | null;
  } catch {
    part = null;
  }
  if (!part) {
    response.statusCode = 400;
    writeJson(response, { success: false, error: "unparseable part" });
    return;
  }
  state.invocationPartReceives += 1;
  writeJson(response, {
    success: true,
    data: {
      accepted: true,
      protocolVersion: part.protocolVersion ?? protocolVersion,
      externalGenerationId: part.externalGenerationId ?? "",
      partIndex: part.partIndex ?? 0,
      partHash: part.partHash ?? "",
      state: "activated",
    },
  });
}

/**
 * Component-inventory lane — any 2xx is `Accepted` (the client ignores the
 * body).
 */
async function handleComponentSync(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState
): Promise<void> {
  await drainBody(request);
  state.componentBatchReceives += 1;
  writeJson(response, { success: true, data: { accepted: true } });
}

async function handleTranscript(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState
): Promise<void> {
  await drainBody(request);
  state.transcriptRequests += 1;
  writeJson(response, { success: true, data: {} });
}

async function handleUnknownPath(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState,
  pathname: string
): Promise<void> {
  await drainBody(request);
  state.unknownPaths.push(`${request.method} ${pathname}`);
  response.statusCode = 404;
  writeJson(response, { success: false, error: "not found" });
}

/**
 * Is `declared` a revision the CLOUD would treat as a real one?
 *
 * Production bounds the field with `.int().min(1).max(MAX_SUPPORTED_DATA_REVISION)`
 * and `.nullish()`, so ABSENT is legal but any other unusable value is not. This
 * is the same floor `resolveDataRevision` applies on the content side; it is
 * stated as a predicate here rather than left implicit, because the envelope
 * oracle deriving its own looser notion of "real" is exactly how the two halves
 * of this mock would drift apart.
 *
 * The floor is what makes the ISS-4572 import-pending sentinel safe. `write-core.ts`
 * stamps `data_revision = DATA_REVISION_IMPORT_PENDING` (-1) at the import gate and
 * seals the real revision only after every later group commits, so a session can
 * genuinely reach the sync path still carrying the sentinel. A sentinel is not a
 * revision: comparing it against a high-water mark would score a session that is
 * legitimately parked for re-derivation as a stale REGRESSION — a false cycle
 * failure — and folding it into the duplicate key would make two unrelated
 * re-derivations look like one payload delivered twice.
 */
function isRealRevision(declared: number | null): declared is number {
  return declared !== null && Number.isInteger(declared) && declared >= 1;
}

/**
 * ISS-6101: record ONE complete delivery of `id`, both across all revisions
 * (`deliveries`, the volume signal) and for the exact `dataRevision` the
 * payload carried (`deliveriesByRevision`, the duplicate oracle). Both counters
 * advance from the same call site so the two views cannot drift.
 *
 * A delivery whose revision is ABSENT or UNUSABLE is UNKNOWN on the revision
 * axis — deliberately not treated as the revision `null`. It cannot be scored a
 * duplicate, because two unknown-revision deliveries may carry two different
 * revisions and nothing here can tell them apart; and it cannot be scored stale,
 * because there is no value to compare against the high-water mark. Scoring it
 * either way would invent a fact the payload never stated. It is counted on its
 * OWN axis instead, so it stays visible rather than vanishing behind an early
 * return — an unusable value is already a `data_revision_invalid` content
 * violation, and a legitimately absent one is legal under production's
 * `.nullish()`, so neither needs a second, guessed verdict here.
 *
 * `receiveUnits` — what this delivery COST in raw receives (1 unchunked,
 * `chunk.total` for an assembled sequence). It is credited to
 * `deliveredReceiveUnits` only when the delivery would actually LAND: a stale
 * one would be rejected by the forward-only upsert, so crediting it would net
 * its receives out of `resendWaste` and hide the purest waste in the cycle.
 */
function recordDelivery(
  state: MockState,
  id: string,
  dataRevision: number | null,
  receiveUnits: number
): void {
  state.synced.add(id);
  state.deliveries.set(id, (state.deliveries.get(id) ?? 0) + 1);
  if (!isRealRevision(dataRevision)) {
    state.unrevisionedDeliveries.set(
      id,
      (state.unrevisionedDeliveries.get(id) ?? 0) + 1
    );
    state.deliveredReceiveUnits += receiveUnits;
    return;
  }
  const revisionKey = `${id}#${dataRevision}`;
  state.deliveriesByRevision.set(
    revisionKey,
    (state.deliveriesByRevision.get(revisionKey) ?? 0) + 1
  );
  const bar = highWaterRevision(state, id);
  if (bar !== null && dataRevision < bar) {
    state.staleRevisionDeliveries.push(revisionKey);
    return;
  }
  state.deliveredReceiveUnits += receiveUnits;
  // A committing apply clears the staged sequence marker, as
  // `resolvePendingChunkPatch` does; a stale one returned above and leaves it
  // standing, so the newer sequence's remaining chunks still measure against it.
  state.pendingRevisionBySession.delete(id);
  const committed = state.highestRevisionBySession.get(id);
  if (committed === undefined || dataRevision > committed) {
    state.highestRevisionBySession.set(id, dataRevision);
  }
}

/**
 * ISS-6099 read-back pass — GET the retained corpus back over the mock's own
 * HTTP boundary rather than reaching into its memory, so the pass exercises a
 * real request/response round trip. A failure returns `null`, which the record
 * scores as an INCOMPLETE read-back; it is never silently treated as clean.
 *
 * What this proves and what it does not: it proves every session the envelope
 * bookkeeping counted as delivered is retrievable afterwards with its content
 * intact. It cannot prove cloud-side persistence semantics — no mock can — and
 * the harness should not be read as claiming otherwise.
 */
export async function readBackFromCloud(
  mock: MockCloudServer,
  notes: string[]
): Promise<ReadBackResponse | null> {
  try {
    const response = await fetch(`${mock.apiOrigin}${mock.readBackPath}`, {
      signal: AbortSignal.timeout(READ_BACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      notes.push(`read-back failed: HTTP ${response.status}`);
      return null;
    }
    return (await response.json()) as ReadBackResponse;
  } catch (error) {
    notes.push(`read-back failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}
