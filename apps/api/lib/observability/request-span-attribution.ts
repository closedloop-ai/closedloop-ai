// ---------------------------------------------------------------------------
// Request-scoped span attribution for the `request_completed` emitter
// (ISS-7217 / ISS-7221 / ISS-7224).
//
// The span is emitted from a `finally` in the auth wrappers (or, for a route
// that authenticates itself, `withRequestCompleted`), which is the one
// place in the request that knows the status code and the duration — and the
// one place that knows nothing about WHY a 5xx happened, WHICH tenant made the
// call, or WHAT artifact the handler touched. Those three facts are known
// deeper in, by ~200 route catch blocks and by the routes themselves.
//
// AsyncLocalStorage rather than a threaded parameter, because the highest-value
// recorder is `errorResponse(message, error)` in `route-utils.ts`: it already
// receives the real error at every route catch, and it has no access to the
// `Request`. Instrumenting it in place attributes every one of those failures
// at once; threading would have meant editing every call site and every
// signature between them.
//
// The AsyncLocalStorage instance lives on a `Symbol.for` slot, NOT a
// module-local binding. ISS-5857 established in this repo that a module-local
// binding does not survive bundling: Turbopack merges a shared module into each
// importer's chunk group, so `route-utils` and a route handler can end up
// holding two different copies. Two copies here would mean the route's write
// landing in a store the emitter never reads — a silent, total loss with no
// error anywhere, which is exactly the failure mode `setTraceContextProvider`
// hit before it moved onto the same kind of slot.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";
import type { SpanErrorSource } from "@closedloop-ai/telemetry-contract/span";
import { parseDesktopClientAttributionHeaders } from "@repo/api/src/types/desktop-client-attribution";
import type {
  ArtifactStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import type { ListQueryRefusal } from "@repo/api/src/types/list-query-expression";
import {
  ListQueryExecution,
  type ListQueryExecution as ListQueryExecutionValue,
  type ListQueryObservation,
  ListQuerySource,
  type ListQuerySource as ListQuerySourceValue,
} from "@repo/api/src/types/list-query-observability";
import type { RequestCompletedSpanAttribution } from "@repo/observability/telemetry/request-completed";
import { resolveSpanErrorType } from "@repo/observability/telemetry/span-error-cause";

const REQUEST_SPAN_ATTRIBUTION_STORAGE = Symbol.for(
  "closedloop.api.requestSpanAttributionStorage"
);

type RequestSpanAttributionState = RequestCompletedSpanAttribution & {
  listQuery?: ListQueryObservation;
  invalidListQueryCountFields?: Set<RequestListQueryCountField>;
};

type RequestSpanAttributionStorage =
  AsyncLocalStorage<RequestSpanAttributionState>;

type RequestSpanAttributionGlobal = typeof globalThis & {
  [REQUEST_SPAN_ATTRIBUTION_STORAGE]?: RequestSpanAttributionStorage;
};

/**
 * Run `handler` with a fresh attribution store bound to the current request.
 *
 * Called by each auth wrapper, and by `withRequestCompleted`, around its whole
 * body — including its own `catch` and `finally` — so a failure the wrapper
 * itself produces is still inside the scope that the emitter reads.
 */
export function runWithRequestSpanAttribution<T>(handler: () => Promise<T>) {
  return requestSpanAttributionStorage().run({}, handler);
}

/**
 * Record the authenticated identity: the organization, which desktop telemetry
 * already carries as `app.organization.id` (ISS-7221), and the internal
 * database user, as the canonical `user.id` (ISS-8748).
 *
 * One recorder for both rather than two, so the two facts cannot be recorded at
 * different points in a wrapper. Every caller stands at the same
 * post-authentication boundary — auth has resolved a live user against a live
 * org — and an unauthenticated, rejected, or unverifiable-org request records
 * neither. A fabricated tenant or actor is worse than a missing one: it would
 * make "which org is failing" and "who was affected" answerable and wrong.
 *
 * `userId` is the internal database UUID only. Nothing derived from the request
 * and no personal field — email, display name, Clerk id — is accepted here; the
 * span schema's UUID constraint is the second half of that guarantee.
 */
export function recordRequestAuthenticatedIdentity(identity: {
  organizationId: string;
  userId: string;
}): void {
  const store = requestSpanAttributionStorage().getStore();
  if (!store) {
    return;
  }
  if (identity.organizationId) {
    store.organizationId = identity.organizationId;
  }
  if (identity.userId) {
    store.userId = identity.userId;
  }
}

/**
 * Record the Desktop install and build the caller ATTESTED to (ISS-8749).
 *
 * A separate recorder from {@link recordRequestAuthenticatedIdentity} because
 * the two have different standing, and collapsing them would hide that: the
 * identity is what the server established, this is what the client said about
 * itself. Nothing downstream may authenticate, authorize, scope a tenant, or
 * route on these values — the API reads them once, here, into a telemetry store
 * and nowhere else.
 *
 * Called before the auth decision, so a rejected request carries it too
 * (ISS-11431): the attestation is the only way a 401 burst names the installs
 * it rejected, and the absent server identity keeps it from being read as one.
 * Parsing is total and per-field: absent headers (every Desktop build older than this change), a
 * malformed value, and a hostile value all resolve to an absent attribute, and
 * one bad header never costs the other.
 */
export function recordRequestClientAttribution(headers: Headers): void {
  const store = requestSpanAttributionStorage().getStore();
  if (!store) {
    return;
  }
  const attested = parseDesktopClientAttributionHeaders(headers);
  if (attested.installationId) {
    store.installationId = attested.installationId;
  }
  if (attested.clientVersion) {
    store.clientVersion = attested.clientVersion;
  }
}

/**
 * Record the artifact a request touched, read from the PERSISTED row rather
 * than the path or the request body (ISS-7224). `/documents/{id}` carries no
 * type, and a body-derived type would describe what the caller ASKED for, not
 * what the row is.
 *
 * Typed against the canonical `DocumentType` / `ArtifactStatus` — the same
 * consts the rest of the codebase uses, never a telemetry-local re-spelling —
 * so a path segment, a slug, or a title cannot be passed here at all.
 */
export function recordRequestArtifact(artifact: {
  type: DocumentType;
  status: ArtifactStatus;
}): void {
  const store = requestSpanAttributionStorage().getStore();
  if (!store) {
    return;
  }
  store.artifactType = artifact.type;
  store.artifactStatus = artifact.status;
}

/**
 * Record the sync batch this request carried (ISS-7227).
 *
 * The desktop already mints `AgentSessionSyncBatch.batchId` per attempt and
 * records it on its own failure diagnostic, so recording the SAME value here —
 * rather than minting a server-side id the client could never name — is what
 * makes the two halves of a failed sync one query. Same reasoning ISS-7221 used
 * to give the cl-api emitter `app.organization.id` rather than a second
 * spelling.
 *
 * Called only with an id already validated as a UUID — by the ingest schema on
 * the parsed body, or, ahead of the rate limiter, by the fixed-size batch-id
 * read that shares that schema's shape — and the span schema re-checks it
 * independently, so a version-skewed producer costs itself the attribute and
 * nothing else on the line.
 */
export function recordRequestSyncBatch(batch: { batchId: string }): void {
  const store = requestSpanAttributionStorage().getStore();
  if (!store) {
    return;
  }
  store.syncBatchId = batch.batchId;
}

/** Record the request's bounded, value-free list-query source. */
export function recordRequestListQuerySource(
  source: ListQuerySourceValue
): void {
  updateListQueryObservation({ source });
}

/** Record which production list-query execution path served the request. */
export function recordRequestListQueryExecution(
  execution: ListQueryExecutionValue
): void {
  updateListQueryObservation({ execution });
}

/** Record a typed canonical-query refusal without its filter values. */
export function recordRequestListQueryRefusal(refusal: ListQueryRefusal): void {
  updateListQueryObservation({
    source: ListQuerySource.Canonical,
    execution: ListQueryExecution.Refused,
    refusal,
  });
}

/**
 * Record honest population counts after a list read completes.
 *
 * Impossible counts are omitted independently so one corrupt field cannot
 * erase a valid sibling or fabricate a plausible value. Their bounded field
 * names ride the existing monitored `request_completed` structured event.
 */
export function recordRequestListQueryCounts(counts: {
  matchedCount: number;
  resultCount: number;
}): void {
  const store = requestSpanAttributionStorage().getStore();
  if (!store) {
    return;
  }
  const matchedCount = validatedRequestListQueryCount(
    counts.matchedCount,
    RequestListQueryCountField.Matched
  );
  const resultCount = validatedRequestListQueryCount(
    counts.resultCount,
    RequestListQueryCountField.Result
  );
  updateListQueryObservation({ matchedCount, resultCount });
}

/** Record the rows an in-memory fallback actually inspected. */
export function recordRequestListQueryScannedCount(scannedCount: number): void {
  updateListQueryObservation({
    scannedCount: validatedRequestListQueryCount(
      scannedCount,
      RequestListQueryCountField.Scanned
    ),
  });
}

/** Bounded fields added to the existing monitored `request_completed` event. */
export function getRequestListQueryLogFields(): Record<
  string,
  string | number
> {
  const store = requestSpanAttributionStorage().getStore();
  const observation = store?.listQuery;
  if (!(observation || store?.invalidListQueryCountFields?.size)) {
    return {};
  }
  return {
    ...(observation?.source === undefined
      ? {}
      : { list_query_source: observation.source }),
    ...(observation?.execution === undefined
      ? {}
      : { list_query_execution: observation.execution }),
    ...(observation?.refusal === undefined
      ? {}
      : { list_query_refusal: observation.refusal }),
    ...(observation?.matchedCount === undefined
      ? {}
      : { list_query_matched_count: observation.matchedCount }),
    ...(observation?.resultCount === undefined
      ? {}
      : { list_query_result_count: observation.resultCount }),
    ...(observation?.scannedCount === undefined
      ? {}
      : { list_query_scanned_count: observation.scannedCount }),
    ...(store?.invalidListQueryCountFields?.size
      ? {
          list_query_invalid_count_fields: [
            ...store.invalidListQueryCountFields,
          ]
            .sort()
            .join(","),
        }
      : {}),
  };
}

/**
 * Record the cause of a server error (ISS-7217).
 *
 * The cause is reduced to a class name plus, where present, a stable machine
 * code — never a message. `resolveSpanErrorType` owns that reduction and its
 * sanitizer reuse; this function owns only which LAYER is claiming the failure.
 *
 * Last write wins: the recorder that ran last is the one whose response the
 * client actually received.
 */
export function recordRequestErrorCause(
  error: unknown,
  errorSource: SpanErrorSource
): void {
  const store = requestSpanAttributionStorage().getStore();
  if (!store) {
    return;
  }
  store.errorSource = errorSource;
  store.errorType = resolveSpanErrorType(error);
}

/**
 * Read the attribution accumulated for the current request.
 *
 * Returns a copy so the emitter cannot mutate the live store, and `undefined`
 * outside a request scope (module init, a cron drain, a unit test that did not
 * open one) — where the emitter simply emits the span it always emitted.
 */
export function getRequestSpanAttribution():
  | RequestCompletedSpanAttribution
  | undefined {
  const store = requestSpanAttributionStorage().getStore();
  if (!store) {
    return undefined;
  }
  const {
    invalidListQueryCountFields: _invalidListQueryCountFields,
    listQuery: _listQuery,
    ...attribution
  } = store;
  return attribution;
}

function updateListQueryObservation(update: ListQueryObservation): void {
  const store = requestSpanAttributionStorage().getStore();
  if (!store) {
    return;
  }
  store.listQuery = { ...store.listQuery, ...update };
}

function requestSpanAttributionStorage(): RequestSpanAttributionStorage {
  const scope = globalThis as RequestSpanAttributionGlobal;
  const existing = scope[REQUEST_SPAN_ATTRIBUTION_STORAGE];
  if (existing) {
    return existing;
  }
  const created: RequestSpanAttributionStorage = new AsyncLocalStorage();
  scope[REQUEST_SPAN_ATTRIBUTION_STORAGE] = created;
  return created;
}

function isTelemetryCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

const RequestListQueryCountField = {
  Matched: "matched",
  Result: "result",
  Scanned: "scanned",
} as const;

type RequestListQueryCountField =
  (typeof RequestListQueryCountField)[keyof typeof RequestListQueryCountField];

function validatedRequestListQueryCount(
  value: number,
  field: RequestListQueryCountField
): number | undefined {
  if (isTelemetryCount(value)) {
    return value;
  }
  const store = requestSpanAttributionStorage().getStore();
  if (store) {
    store.invalidListQueryCountFields ??= new Set();
    store.invalidListQueryCountFields.add(field);
  }
  return undefined;
}
