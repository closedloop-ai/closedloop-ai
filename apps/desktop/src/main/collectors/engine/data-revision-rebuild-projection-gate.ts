/**
 * @file data-revision-rebuild-projection-gate.ts
 * @description ISS-8741: the DATA_REVISION rebuild's entry into the versioned-
 * record substrate — the glue that turns "re-derive this session" into
 * "claim, validate against the target views, then replace atomically".
 *
 * WHAT CHANGED FOR THE REBUILD. It used to hand whatever the parse produced
 * straight to `rebuildSessionFromParse`, which tears the parser-owned rows down
 * and re-imports. A candidate that parsed but was not a well-formed derived
 * record therefore replaced a good projection with a worse one, and the loss was
 * permanent for a TERMINAL session: the rebuild is gated to those, and they do
 * not cycle back through ordinary reimport, so nothing would re-derive them
 * until the next revision bump. Now the candidate has to satisfy the session
 * view's own validator before the teardown is allowed to start.
 *
 * A REFUSED CANDIDATE IS AN ERROR, NOT A SKIP. It is reported through the
 * rebuild's existing failure path, which leaves `data_revision` stale as the
 * durable retry marker and parks the id as outstanding — the same treatment a
 * failed replacement already gets, and the reason a refusal cannot quietly
 * retire a session.
 *
 * Lives beside `data-revision-rebuild.ts` rather than inside it: that file is
 * already at the size the ceiling is meant to catch.
 */

import { truncateUtf8 } from "@closedloop-ai/loops-api/observability/truncate-utf8";
import {
  DerivedProjectionPromotionOutcome,
  type DerivedProjectionRevisionStore,
  promoteDerivedProjection,
} from "../../database/derived-projection-promotion.js";
import type { ProjectionTarget } from "../../database/derived-projection-revision.js";
import { canReplaceSessionProjection } from "../../database/session-projection-replaceability.js";
import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
import type { Harness, NormalizedSession } from "../types.js";
import type { DataRevisionRebuildDatabase } from "./data-revision-rebuild.js";
import { boundedDiagnosticText } from "./historical-parse-worker-diagnostics.js";
import {
  currentSessionProjectionRevision,
  SESSION_PROJECTION_VALIDATORS,
} from "./session-projection-gate.js";

/**
 * The subset of the rebuild's database the gate needs, PICKED from the canonical
 * declaration rather than restated. Restating it would let a field added to
 * `DataRevisionRebuildDatabase` — and branched on by `applyRebuild` — be
 * structurally invisible here while `tsc` stayed green.
 */
export type SessionProjectionGateDatabase = Pick<
  DataRevisionRebuildDatabase,
  | "claimProjectionCandidate"
  | "rebuildSessionFromParse"
  | "releaseProjectionCandidate"
>;

/** What `rebuildSessionFromParse` resolves to, derived from its own signature. */
export type SessionProjectionResult = Awaited<
  ReturnType<DataRevisionRebuildDatabase["rebuildSessionFromParse"]>
>;

export type SessionProjectionPromotionOutcome = {
  readonly result: SessionProjectionResult;
  /** Set when a target view refused the candidate. */
  readonly rejectedBy?: ProjectionTarget;
};

/**
 * Replace one session's derived projection through the gate.
 *
 * Returns the same result shape `rebuildSessionFromParse` always returned, so
 * the caller's accounting is unchanged: a refusal or a failed replacement is
 * `{ rebuilt: false, activeRace: false }`, which the rebuild already treats as
 * retryable.
 */
export async function promoteSessionProjection(
  harness: Harness,
  session: NormalizedSession,
  db: SessionProjectionGateDatabase,
  log: (message: string) => void,
  parsePolicy: ParsePolicy
): Promise<SessionProjectionPromotionOutcome> {
  const promotion = await promoteDerivedProjection<
    NormalizedSession,
    SessionProjectionResult
  >({
    recordKey: session.sessionId,
    revision: currentSessionProjectionRevision(parsePolicy),
    store: projectionRevisionStore(db),
    // ISS-8741 (whitlockk, PR #6507): a candidate the replacement will decline
    // before it opens a transaction is UNBUILDABLE, not promotable. Reported
    // here rather than left to the replacement's own `{ rebuilt: false }`,
    // because that answer is indistinguishable at this layer from a replacement
    // that started and did not land — and treating it as the latter leaves the
    // in-flight marker standing on a session where nothing was ever in flight.
    // The substrate releases the claim on this outcome; the predicate is the
    // replacement's OWN, imported rather than restated.
    buildCandidate: () =>
      canReplaceSessionProjection(session) ? session : null,
    validators: SESSION_PROJECTION_VALIDATORS,
    promote: (candidate, revision) =>
      db.rebuildSessionFromParse(candidate, harness, revision, parsePolicy),
    log,
  });
  if (promotion.outcome === DerivedProjectionPromotionOutcome.Promoted) {
    return { result: promotion.promoted ?? NOT_REBUILT };
  }
  if (
    promotion.outcome === DerivedProjectionPromotionOutcome.CandidateRejected
  ) {
    log(
      `data-revision rebuild [${harness}]: projectionRejected=${diagnostic(session.sessionId, MAX_LOGGED_IDENTIFIER_BYTES)} target=${promotion.rejectedBy} ${diagnostic(promotion.reason ?? "", MAX_LOGGED_REASON_BYTES)}`
    );
    return { result: NOT_REBUILT, rejectedBy: promotion.rejectedBy };
  }
  log(
    `data-revision rebuild [${harness}]: projectionCandidateUnusable=${diagnostic(session.sessionId, MAX_LOGGED_IDENTIFIER_BYTES)} ${diagnostic(describe(promotion.error), MAX_LOGGED_REASON_BYTES)}`
  );
  return { result: NOT_REBUILT };
}

/**
 * Adapt the database's flat claim/release methods into the substrate's store, or
 * `undefined` when it has neither — a wiring without them still gets the
 * validation gate and the atomic replacement, just no durable in-flight marker.
 *
 * CALLED THROUGH `db`, NEVER DETACHED. In production `db` is the db-host method
 * PROXY, whose `get` trap turns every property into a dotted op path and
 * deliberately answers `call` / `bind` / `apply` with `undefined` so a detach
 * attempt fails loudly instead of posting the uncloneable proxy over IPC. A
 * `claimProjectionCandidate.call(db, …)` here therefore threw on every real
 * launch — and `claimQuietly` swallowed it, so the marker silently never
 * persisted while every in-process test stayed green. The type guard below is
 * what lets the calls stay on `db` without an optional-chain the guard has
 * already ruled out.
 */
function projectionRevisionStore(
  db: SessionProjectionGateDatabase
): DerivedProjectionRevisionStore | undefined {
  if (!hasProjectionMarkers(db)) {
    return undefined;
  }
  return {
    claimCandidate: (recordKey, revision) =>
      db.claimProjectionCandidate(recordKey, revision),
    releaseCandidate: (recordKey) => db.releaseProjectionCandidate(recordKey),
  };
}

/** A database that carries BOTH marker methods, or neither. */
type MarkerCapableDatabase = SessionProjectionGateDatabase &
  Required<
    Pick<
      SessionProjectionGateDatabase,
      "claimProjectionCandidate" | "releaseProjectionCandidate"
    >
  >;

function hasProjectionMarkers(
  db: SessionProjectionGateDatabase
): db is MarkerCapableDatabase {
  return Boolean(db.claimProjectionCandidate && db.releaseProjectionCandidate);
}

function describe(error: unknown): string {
  if (error === undefined) {
    return "";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The result a non-promotion reports. Not `activeRace` and not `storageReset`:
 * both of those tell the caller to stop retrying, and a candidate the gate
 * refused is precisely a session that must stay outstanding.
 */
const NOT_REBUILT = { rebuilt: false, activeRace: false } as const;

/**
 * Sanitize and bound one value on its way into an unstructured rebuild log line.
 *
 * The in-process `collector.parse` fallback never crosses the worker protocol
 * boundary, so a `sessionId` — or a Zod-derived rejection reason quoting a field
 * value — reaches this log exactly as the transcript spelled it: control bytes,
 * ANSI, an absolute home path, or an unbounded length included (davetho, PR
 * #6507). `boundedDiagnosticText` is that boundary's own sanitizer, reused
 * rather than restated so a credential family added at its SSOT covers this sink
 * too.
 *
 * It is reused for the SANITIZING half only. Its own cap is the worker
 * protocol's long-TEXT bound (2MB), which is a payload budget rather than a log
 * budget; one rejection is not allowed to write two megabytes into the rebuild
 * log, so the result is capped again here at a size a human reads.
 */
function diagnostic(value: string, maxBytes: number): string {
  return truncateUtf8(boundedDiagnosticText(value), maxBytes);
}

/**
 * The log budget for a record key. Generous next to a real session id (a UUID,
 * or a harness path digest) and small enough that an id the parse invented
 * cannot crowd out the rest of the line.
 */
const MAX_LOGGED_IDENTIFIER_BYTES = 256;

/** The log budget for free-form rejection text (a reason, an error message). */
const MAX_LOGGED_REASON_BYTES = 2048;
