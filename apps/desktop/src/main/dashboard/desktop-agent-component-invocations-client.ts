import {
  type AgentComponentInvocationSyncAckState as AgentComponentInvocationAckState,
  type AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncBatch,
  type AgentComponentInvocationSyncPart,
  type AgentComponentInvocationSyncProtocolVersion,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { DesktopAgentComponentInvocationSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import {
  classifySyncFailure,
  INVOCATION_PARTS_ROUTE_PROFILE,
  SyncFailureClass,
} from "../../shared/sync-failure-classification.js";
import { parseRetryAfterMs } from "../transcript/retry-after-header.js";
import {
  SessionRequestCredentialKind,
  sendSessionClApiRequest,
  unwrapApiEnvelope,
} from "../util/api-response-utils.js";

const INVOCATION_SYNC_REQUEST_TIMEOUT_MS = 30_000;

/**
 * ISS-11426: the 403 codes THIS build can act on. A Set of values, never an
 * object indexed by the server-supplied key, so the untrusted key cannot reach
 * `__proto__`.
 */
const KNOWN_FORBIDDEN_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(DesktopAgentComponentInvocationSyncRestErrorCode)
);

export type DesktopAgentComponentInvocationsClientOptions = {
  fetch?: typeof fetch;
  getAccessToken: () => Promise<string | null>;
  getApiKey?: () => string | null;
  getApiOrigin: () => string | undefined;
  getComputeTargetId: () => string | null;
  onUnauthorized?: (rejectedToken: string) => void;
};

export type AgentComponentInvocationSyncClientResult =
  | { kind: "ack"; ack: AgentComponentInvocationSyncAck }
  | { kind: "unavailable"; retryAfterMs?: number; status?: number }
  | {
      kind: "retry";
      error: string;
      retryAfterMs?: number;
      status?: number;
      /**
       * ISS-11426: the 403 discriminator, when the server sent one. Absent for
       * every other status and for a server predating the coded 403, and the
       * reason fold reads that absence as the status fold it has always used.
       */
      forbiddenCode?: DesktopAgentComponentInvocationSyncRestErrorCode;
    };

export type DesktopAgentComponentInvocationsClient = {
  syncPart(
    part: AgentComponentInvocationSyncPart,
    computeTargetId?: string
  ): Promise<AgentComponentInvocationSyncClientResult>;
};

export function createDesktopAgentComponentInvocationsClient(
  options: DesktopAgentComponentInvocationsClientOptions
): DesktopAgentComponentInvocationsClient {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async syncPart(part, computeTargetId) {
      const request = await resolveRequest(options, computeTargetId);
      if (!request) {
        return { kind: "unavailable" };
      }
      // ISS-4976: the envelope declares the PART's version, not a build-wide
      // constant. That is what an older API's pre-parse gate reads, so a
      // telemetry-carrying part earns the retryable 501 `protocol_unsupported`
      // there instead of the permanent 400 that dead-letters the generation,
      // while a telemetry-free part still declares v1 and is accepted as today.
      const payload: AgentComponentInvocationSyncBatch = {
        protocolVersion: part.protocolVersion,
        parts: [part],
      };

      let response: Response;
      try {
        response = await sendSessionClApiRequest({
          apiOrigin: request.apiOrigin,
          path: "/desktop/agent-sessions/invocations/sync",
          query: { computeTargetId: request.computeTargetId },
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          timeoutMs: INVOCATION_SYNC_REQUEST_TIMEOUT_MS,
          fetch: fetchImpl,
          credential: {
            token: request.token,
            credentialKind: request.credentialKind,
          },
          onUnauthorized: options.onUnauthorized,
        });
      } catch (error) {
        return { kind: "retry", error: errorMessage(error) };
      }

      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("Retry-After"),
        Date.now()
      );
      if (!response.ok) {
        return invocationFailureResult({
          part,
          status: response.status,
          retryAfterMs,
          // ISS-11426: read for 403 ALONE. Every other status on this route
          // carries a message rather than a code, so reading the body for them
          // would spend a parse on nothing; and a 403 is the one status whose
          // two meanings the status cannot separate.
          forbiddenCode:
            response.status === 403
              ? await readForbiddenCode(response)
              : undefined,
        });
      }

      const body = await response.json().catch(() => null);
      const ack = parseAck(unwrapApiEnvelope(body), part.protocolVersion);
      if (!ack) {
        return {
          kind: "retry",
          error: "invocation sync returned an invalid ack",
        };
      }
      if (
        !ack.accepted &&
        ack.reason ===
          AgentComponentInvocationSyncRejectReason.ProtocolUnsupported
      ) {
        return { kind: "unavailable" };
      }
      return { kind: "ack", ack };
    },
  };
}

async function resolveRequest(
  options: DesktopAgentComponentInvocationsClientOptions,
  computeTargetIdOverride?: string
): Promise<{
  apiOrigin: string;
  computeTargetId: string;
  token: string;
  credentialKind: SessionRequestCredentialKind;
} | null> {
  const computeTargetId =
    computeTargetIdOverride ?? options.getComputeTargetId();
  const origin = options.getApiOrigin();
  if (!(computeTargetId && origin)) {
    return null;
  }
  let credential: {
    token: string;
    credentialKind: SessionRequestCredentialKind;
  } | null = null;
  try {
    const token = await options.getAccessToken();
    if (token) {
      credential = {
        token,
        credentialKind: SessionRequestCredentialKind.AccessToken,
      };
    }
  } catch {
    // API-key fallback below is intentionally available after token failures.
  }
  const apiKey = credential ? null : (options.getApiKey?.() ?? null);
  if (apiKey) {
    credential = {
      token: apiKey,
      credentialKind: SessionRequestCredentialKind.ApiKey,
    };
  }
  if (!credential) {
    return null;
  }
  try {
    new URL("/desktop/agent-sessions/invocations/sync", origin);
    return { apiOrigin: origin, computeTargetId, ...credential };
  } catch {
    return null;
  }
}

/**
 * ISS-4976: the ack must echo the version the REQUEST declared. Pinning it to
 * the part rather than to a build-wide constant is what lets this build speak v1
 * for a telemetry-free part and v2 for a telemetry-carrying one without the ack
 * parser rejecting one of them as unrecognizable.
 */
function parseAck(
  value: unknown,
  expectedProtocolVersion: AgentComponentInvocationSyncProtocolVersion
): AgentComponentInvocationSyncAck | null {
  if (!(value && typeof value === "object")) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.accepted !== "boolean" ||
    record.protocolVersion !== expectedProtocolVersion ||
    typeof record.externalGenerationId !== "string" ||
    typeof record.partIndex !== "number" ||
    !Number.isInteger(record.partIndex) ||
    typeof record.partHash !== "string"
  ) {
    return null;
  }
  if (record.accepted) {
    if (!isAckState(record.state)) {
      return null;
    }
    return {
      accepted: true,
      protocolVersion: expectedProtocolVersion,
      externalGenerationId: record.externalGenerationId,
      partIndex: record.partIndex,
      partHash: record.partHash,
      state: record.state,
    };
  }
  if (!isRejectReason(record.reason)) {
    return null;
  }
  return {
    accepted: false,
    protocolVersion: expectedProtocolVersion,
    externalGenerationId: record.externalGenerationId,
    partIndex: record.partIndex,
    partHash: record.partHash,
    reason: record.reason,
  };
}

function isAckState(value: unknown): value is AgentComponentInvocationAckState {
  return Object.values(AgentComponentInvocationSyncAckState).includes(
    value as AgentComponentInvocationAckState
  );
}

function isRejectReason(
  value: unknown
): value is AgentComponentInvocationSyncRejectReason {
  return Object.values(AgentComponentInvocationSyncRejectReason).includes(
    value as AgentComponentInvocationSyncRejectReason
  );
}

function retryResult(
  error: string,
  status: number | undefined,
  retryAfterMs: number | undefined,
  forbiddenCode?: DesktopAgentComponentInvocationSyncRestErrorCode
): AgentComponentInvocationSyncClientResult {
  return {
    kind: "retry",
    ...(status === undefined ? {} : { status }),
    error,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    // Omitted rather than serialized as `undefined` when the server sent no
    // code, so "this server does not speak codes" and "this code is unreadable"
    // stay the same absent value the fold already handles.
    ...(forbiddenCode === undefined ? {} : { forbiddenCode }),
  };
}

function unavailableResult(
  status: number,
  retryAfterMs: number | undefined
): AgentComponentInvocationSyncClientResult {
  return {
    kind: "unavailable",
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One failed part send, as much of it as the class fold below needs. */
type InvocationFailureContext = {
  readonly part: AgentComponentInvocationSyncPart;
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly forbiddenCode:
    | DesktopAgentComponentInvocationSyncRestErrorCode
    | undefined;
};

/**
 * Every Appendix A class folded onto this lane's client result (ISS-8614).
 *
 * It REPLACES two hand-written status sets, `PROTOCOL_UNAVAILABLE_STATUSES` and
 * `PERMANENT_VALIDATION_FAILURE_STATUSES`. Their members are now
 * `INVOCATION_PARTS_ROUTE_PROFILE` resolved against Appendix A's default table,
 * which keeps 400/413 ITEM and 501 PROTOCOL-ABSENT unchanged. **410
 * deliberately drops out**: Appendix A verified it
 * unreachable on every route, so reading it as protocol absence was dead policy
 * rather than debt, and the sibling shrink to PRD-699 C1's 409 is to delete it
 * instead of recording it. It now defers like any other environmental status,
 * which charges nothing either way.
 *
 * **422 deliberately comes IN**, and it is the one status whose EFFECT changes
 * here: PRD-699 v2 (amended 2026-09-09) made it ITEM on every route, where the
 * deleted `PERMANENT_VALIDATION_FAILURE_STATUSES` held only `{400, 413}` and
 * everything else took `recordEnvironmentalRetry`. The route does not emit one
 * today, so it is latent — but the desktop is version-skewed against the cloud,
 * so it is what an already-installed build does the day one starts: a part
 * rejected as invalid walks the permanent counter toward dead-letter instead of
 * retrying forever, which is the amendment's point — inherited from the default
 * table rather than recorded as a deviation, and pinned by
 * `sync-classification-standard-conformance.test.ts`.
 *
 * The fold is three-valued rather than the component lane's two, but not for
 * the retry schedule: the sync service sends `unavailable` and `retry` alike
 * through `recordEnvironmentalRetry`. What the third value buys is the error
 * recorded on the row (`protocol_unavailable`, whose remedy is a server
 * upgrade, rather than the status-derived message) and the lane's health reason
 * (`transport_unavailable`). A `Record` over the closed class union rather than a
 * chain, so a fourth member reds `tsc` here instead of inheriting whichever arm
 * came last.
 */
const FAILURE_RESULT_BY_CLASS: Record<
  SyncFailureClass,
  (
    context: InvocationFailureContext
  ) => AgentComponentInvocationSyncClientResult
> = {
  [SyncFailureClass.ProtocolAbsent]: (context) =>
    unavailableResult(context.status, context.retryAfterMs),
  [SyncFailureClass.Item]: (context) => ({
    kind: "ack",
    ack: {
      accepted: false,
      protocolVersion: context.part.protocolVersion,
      externalGenerationId: context.part.externalGenerationId,
      partIndex: context.part.partIndex,
      partHash: context.part.partHash,
      reason: AgentComponentInvocationSyncRejectReason.ValidationFailed,
    },
  }),
  [SyncFailureClass.Environmental]: (context) =>
    retryResult(
      `invocation sync returned HTTP ${context.status}`,
      context.status,
      context.retryAfterMs,
      context.forbiddenCode
    ),
};

/**
 * Classify one non-2xx response for this route and build the result its class
 * calls for. Only ever reached on `!response.ok` — the shared classifier answers
 * "given that this FAILED, whose fault is it", and a success status is the wrong
 * question for it.
 */
function invocationFailureResult(
  context: InvocationFailureContext
): AgentComponentInvocationSyncClientResult {
  return FAILURE_RESULT_BY_CLASS[
    classifySyncFailure(INVOCATION_PARTS_ROUTE_PROFILE, context.status)
  ](context);
}

/**
 * ISS-11426: the `code` on a 403 envelope, or `undefined` when this server did
 * not send one this build can read.
 *
 * A body that does not parse, an envelope with no `code`, and a `code` naming a
 * class this build has never heard of are the SAME answer — absent — because
 * each leaves the desktop with no more than the status, which is exactly the
 * pre-ISS-11426 input. Guessing from an unreadable name is the collapse this
 * function exists to avoid, one rung down from the one it fixes.
 */
async function readForbiddenCode(
  response: Response
): Promise<DesktopAgentComponentInvocationSyncRestErrorCode | undefined> {
  const body: unknown = await response.json().catch(() => null);
  if (!(body && typeof body === "object")) {
    return undefined;
  }
  const code = Reflect.get(body, "code");
  return KNOWN_FORBIDDEN_CODES.has(code as string)
    ? (code as DesktopAgentComponentInvocationSyncRestErrorCode)
    : undefined;
}
