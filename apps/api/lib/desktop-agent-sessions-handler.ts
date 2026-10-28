import type { DesktopAgentSessionsAck } from "@repo/api/src/types/agent-session";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { agentSessionsService } from "@/app/agent-sessions/service";
import type { UpsertSessionsBatchOptions } from "@/app/agent-sessions/service/upsert-sessions-batch";
import { DesktopAgentSessionsClientRejectionError } from "./desktop-agent-sessions-errors";
import {
  type DesktopAgentSessionsPayloadDiagnostic,
  DesktopAgentSessionsPayloadDiagnosticCode,
} from "./desktop-agent-sessions-pr-number-preprocess";
import {
  DesktopAgentSessionsAckReason,
  type DesktopAgentSessionsPayload,
  parseDesktopAgentSessionsPayload,
  readDesktopAgentSessionsBatchId,
} from "./desktop-agent-sessions-schema";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter";
import { recordRequestSyncBatch } from "./observability/request-span-attribution";

export type DesktopAgentSessionsHandlerContext = {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  targetId: string;
  /** ISS-12552: an API-key caller's per-session receipt, in each slice's transaction. */
  recordSessionWrite?: UpsertSessionsBatchOptions["recordSessionWrite"];
};

export type DesktopAgentSessionsHandlerDeps = {
  rateLimiter?: DesktopAgentSessionsRateLimiter;
  upsertBatch?: (
    context: {
      organizationId: string;
      userId: string;
      computeTargetId: string;
    },
    payload: DesktopAgentSessionsPayload,
    recordSessionWrite?: UpsertSessionsBatchOptions["recordSessionWrite"]
  ) => Promise<{ persistedSessionIds: string[] }>;
  now?: () => number;
};

export class DesktopAgentSessionsRateLimiter extends FixedWindowRateLimiter {}

/** Stable warning event for accepted sync payloads that drop int4-unsafe PR refs. */
export const DESKTOP_AGENT_SESSIONS_OVERSIZED_PR_REFS_DROPPED_EVENT =
  "desktop_agent_sessions_oversized_pr_refs_dropped";

const defaultRateLimiter = new DesktopAgentSessionsRateLimiter();

export async function handleDesktopAgentSessionsEvent(
  payload: unknown,
  context: DesktopAgentSessionsHandlerContext,
  deps: DesktopAgentSessionsHandlerDeps = {}
): Promise<DesktopAgentSessionsAck> {
  // ISS-7227: read the join key off the RAW body BEFORE the limiter. The
  // desktop writes a failure record carrying this same batch id for a
  // `rate_limited` rejection too, so a recorder placed after the limiter would
  // leave precisely the throttled failure population unjoinable. Only the
  // fixed-size id is read here — one declared property plus a UUID check; the
  // O(payload) sanitize + parse stays behind the limiter, which is the cost the
  // limiter exists to withhold. An unreadable or non-UUID id records nothing,
  // so the request is attributed by omission, never by a guessed id.
  const rawBatchId = readDesktopAgentSessionsBatchId(payload);
  if (rawBatchId) {
    recordRequestSyncBatch({ batchId: rawBatchId });
  }

  // FEA-2258: rate-limit BEFORE parsing/sanitizing so an abusive (authenticated
  // or compromised) target is throttled with a cheap in-memory check before the
  // handler pays the O(payload) Zod parse + recursive sanitize cost.
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter;
  if (
    !rateLimiter.attempt(buildRateLimitKey(context), deps.now?.() ?? Date.now())
  ) {
    log.warn("Desktop agent sessions request rate limit exceeded", {
      computeTargetId: context.targetId,
      organizationId: context.organizationId,
      userId: context.userId,
    });
    emitTelemetryMetric({
      metric: "agent_sessions.sync.failed",
      organizationId: context.organizationId,
      computeTargetId: context.targetId,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    });
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    };
  }

  const parsed = parseDesktopAgentSessionsPayload(payload);
  if (!parsed.ok) {
    log.warn("Desktop agent sessions validation failed", {
      computeTargetId: context.targetId,
      reason: parsed.reason,
    });
    emitTelemetryMetric({
      metric: "agent_sessions.sync.failed",
      organizationId: context.organizationId,
      computeTargetId: context.targetId,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
      // ISS-5090: return the stable, value-free field/path summary the server
      // already logs, so the desktop can record WHY a payload was rejected. It
      // is what lets an operator tell a genuine local-data defect apart from
      // capability/version skew without server log access.
      detail: parsed.reason,
    };
  }
  // ISS-7227: re-record from the PARSED payload — the value persistence
  // actually uses. It differs from the pre-limiter read above only when
  // sanitizing recovers a UUID the raw bytes did not spell, and in that case
  // the parsed id is the correct one, so parsed deliberately writes last. Still
  // ahead of the upsert, so a request that fails it still carries the join key;
  // the ingestion 500 is the whole reason the key exists.
  recordRequestSyncBatch({ batchId: parsed.payload.batchId });
  reportDesktopAgentSessionPayloadDiagnostics(parsed.diagnostics, context);

  const upsertBatch = deps.upsertBatch ?? agentSessionsService.upsertSessions;

  let persistedSessionIds: string[];
  try {
    ({ persistedSessionIds } = await upsertBatch(
      {
        organizationId: context.organizationId,
        userId: context.userId,
        computeTargetId: context.targetId,
      },
      parsed.payload,
      context.recordSessionWrite
    ));
  } catch (error) {
    // ISS-7768: every deterministic, client-shaped rejection lands here, not just
    // the token-transport collision. Re-sending the identical payload reproduces
    // it, so answering `ingestion_failed` (500) would tell the desktop to defer
    // the same doomed bytes on a transient-server budget; `validation_failed`
    // (400) routes it to the bisection that can actually resolve it.
    if (error instanceof DesktopAgentSessionsClientRejectionError) {
      log.warn("Desktop agent sessions validation failed", {
        computeTargetId: context.targetId,
        reason: error.message,
      });
      emitTelemetryMetric({
        metric: "agent_sessions.sync.failed",
        organizationId: context.organizationId,
        computeTargetId: context.targetId,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      });
      // No `detail` rides this branch. ISS-5090's `details.reason` is still an
      // ack field and still reaches the desktop, but only from the PARSE guard
      // above, which has a value-free field/path summary to put in it; a thrown
      // rejection has nothing to add beyond its class identity, and the field is
      // omitted rather than serialized as a `null` an older client never expected.
      return {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      };
    }
    log.error("Desktop agent sessions ingestion failed", {
      computeTargetId: context.targetId,
      organizationId: context.organizationId,
      error,
    });
    emitTelemetryMetric({
      metric: "agent_sessions.sync.failed",
      organizationId: context.organizationId,
      computeTargetId: context.targetId,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    };
  }

  // Goal stage 2 (atomic row-level ack): when the batch opted in, return the
  // `externalSessionId`s this request actually PERSISTED, so the desktop clears
  // exactly those outbox rows. These come from `upsertSessions`, NOT from the
  // sent payload: echoing the sent ids would let the desktop clear a row the
  // server never stored, which is exactly the silent loss this stage exists to
  // remove. The desktop's bounded `ack_omitted` budget re-sends an omitted row
  // and recoverably dead-letters it if it never lands.
  //
  // ISS-8781: more kinds of slice are absent from the echo than the two this
  // comment used to name — no count in prose, because it goes stale the moment a
  // path is added. A no-write HOLD (a foreign chunk, either revision
  // sentinel, or a revision-less payload mid chunk sequence); a slice that THREW
  // and was isolated so it could not reject the rest of the batch; a slice that
  // COMMITTED while a monitored-activity target stays unresolved, so the session
  // IS in the cloud and its id is still withheld; and a tail the ingest runtime
  // budget never reached. `service/session-omission-report.ts` names each
  // withheld id with its cause; `SessionOmissionCause` is the enumeration.
  //
  // REQUEST-GATED: installed desktops parse the success response with a
  // `.strict()` validator, so the field must never appear for a batch that did
  // not ask for it.
  if (parsed.payload.wantsAcceptedSessionIds === true) {
    return { accepted: true, acceptedSessionIds: persistedSessionIds };
  }
  return { accepted: true };
}

function reportDesktopAgentSessionPayloadDiagnostics(
  diagnostics: readonly DesktopAgentSessionsPayloadDiagnostic[] | undefined,
  context: DesktopAgentSessionsHandlerContext
): void {
  if (!diagnostics?.length) {
    return;
  }
  for (const diagnostic of diagnostics) {
    if (
      diagnostic.code !==
      DesktopAgentSessionsPayloadDiagnosticCode.OversizedPullRequestRefDropped
    ) {
      continue;
    }
    log.warn(DESKTOP_AGENT_SESSIONS_OVERSIZED_PR_REFS_DROPPED_EVENT, {
      artifactRefCount: diagnostic.artifactRefCount,
      computeTargetId: context.targetId,
      droppedRefCount: diagnostic.artifactRefCount + diagnostic.prRefCount,
      maxPrNumber: diagnostic.maxPrNumber,
      organizationId: context.organizationId,
      prRefCount: diagnostic.prRefCount,
      samples: diagnostic.samples,
      sessionCount: diagnostic.sessionCount,
      userId: context.userId,
    });
  }
}

function buildRateLimitKey(
  context: DesktopAgentSessionsHandlerContext
): string {
  return `direct:${context.organizationId}:${context.userId}:${context.targetId}`;
}
