/**
 * @file desktop-claude-code-telemetry-client.ts
 * @description ISS-10717 — the HTTP transport for the desktop→cloud Claude Code
 * telemetry lane.
 *
 * The result union IS the lane's failure taxonomy, and the split is the whole
 * point (invariant 4 in `main/sync/AGENTS.md`): only `rejected` is attributable
 * to the session and may burn its retry budget. `unavailable` and `retry` are
 * lane-wide and must defer with the budget intact, or one server-side outage
 * stops the whole corpus permanently.
 *
 * ── Version skew ───────────────────────────────────────────────────────────
 * A desktop AHEAD of the API is the common case: desktop tags cut from `main`
 * while the API deploys from `production`, so `/desktop/claude-code-telemetry/sync`
 * may not exist yet. 404/410/501 are read as `unavailable` — the lane backs off
 * without spending budget — rather than as a failure of the session. A 501 is
 * also what the route answers for an unsupported `protocolVersion`, so both
 * shapes of skew land on the same budget-preserving branch. That is the
 * ISS-4976 / ISS-7795 lesson made structural: a newer field must never reach a
 * `.strict()` boundary that answers a permanent 400.
 */

import {
  DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION,
  type DesktopClaudeCodeDropCounterInput,
  type DesktopClaudeCodeSessionTelemetryInput,
  type DesktopClaudeCodeTelemetrySyncAck,
  desktopClaudeCodeTelemetrySyncAckSchema,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import {
  SessionRequestCredentialKind,
  sendSessionClApiRequest,
  unwrapApiEnvelope,
} from "../util/api-response-utils.js";

const TELEMETRY_SYNC_REQUEST_TIMEOUT_MS = 30_000;
const TELEMETRY_SYNC_PATH = "/desktop/claude-code-telemetry/sync";
/** Statuses that mean "this API build does not serve this protocol". */
const PROTOCOL_UNAVAILABLE_STATUSES = new Set([404, 410, 501]);
/**
 * Statuses that mean the PAYLOAD is wrong — the only session-attributable class.
 *
 * 413 is deliberately absent, matching the routine lane: the producer bounds its
 * own body against the same shared cap the route enforces, so a 413 can only
 * mean the deployed route's cap DISAGREES with this build's, which is a property
 * of the deployment exactly like a 429 or a 5xx.
 */
const ROW_REJECTED_STATUSES = new Set([400]);

export const DesktopClaudeCodeTelemetryClientResultKind = {
  Ack: "ack",
  Rejected: "rejected",
  Unavailable: "unavailable",
  Retry: "retry",
  Deferred: "deferred",
} as const;

export type DesktopClaudeCodeTelemetryClientResult =
  | {
      kind: typeof DesktopClaudeCodeTelemetryClientResultKind.Ack;
      ack: DesktopClaudeCodeTelemetrySyncAck;
    }
  | {
      kind: typeof DesktopClaudeCodeTelemetryClientResultKind.Rejected;
      status: number;
    }
  | {
      kind: typeof DesktopClaudeCodeTelemetryClientResultKind.Unavailable;
      status?: number;
    }
  | {
      kind: typeof DesktopClaudeCodeTelemetryClientResultKind.Retry;
      error: string;
      status?: number;
    }
  | { kind: typeof DesktopClaudeCodeTelemetryClientResultKind.Deferred };

export type DesktopClaudeCodeTelemetryClientOptions = {
  fetch?: typeof fetch;
  getAccessToken: () => Promise<string | null>;
  getApiKey?: () => string | null;
  getApiOrigin: () => string | undefined;
  getComputeTargetId: () => string | null;
  onUnauthorized?: (rejectedToken: string) => void;
};

export type DesktopClaudeCodeTelemetryClient = {
  syncSession(
    input: {
      /** Omitted on a counters-only delivery. */
      session?: DesktopClaudeCodeSessionTelemetryInput;
      dropCounters: readonly DesktopClaudeCodeDropCounterInput[];
    },
    /** Rechecked after credential resolution, immediately before network egress. */
    canStillSend?: () => boolean
  ): Promise<DesktopClaudeCodeTelemetryClientResult>;
};

export function createDesktopClaudeCodeTelemetryClient(
  options: DesktopClaudeCodeTelemetryClientOptions
): DesktopClaudeCodeTelemetryClient {
  return {
    async syncSession({ session, dropCounters }, canStillSend) {
      if (isSendSuperseded(canStillSend)) {
        return { kind: DesktopClaudeCodeTelemetryClientResultKind.Deferred };
      }
      const request = await resolveRequest(options, canStillSend);
      if (isSendSuperseded(canStillSend)) {
        return { kind: DesktopClaudeCodeTelemetryClientResultKind.Deferred };
      }
      if (!request) {
        // No origin, no token, or no compute target: a LANE-WIDE precondition,
        // not a property of this session.
        return { kind: DesktopClaudeCodeTelemetryClientResultKind.Unavailable };
      }

      try {
        const response = await sendSessionClApiRequest({
          apiOrigin: request.apiOrigin,
          path: TELEMETRY_SYNC_PATH,
          query: { computeTargetId: request.computeTargetId },
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          // An absent `session` is OMITTED, never serialized as `null`: the
          // receiving schema declares the field optional, not nullable, so a
          // `null` would be a validation failure rather than a counters-only
          // delivery.
          body: JSON.stringify({
            protocolVersion:
              DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION,
            ...(session ? { session } : {}),
            dropCounters,
          }),
          timeoutMs: TELEMETRY_SYNC_REQUEST_TIMEOUT_MS,
          fetch: options.fetch,
          credential: {
            token: request.token,
            credentialKind: request.credentialKind,
          },
          onUnauthorized: options.onUnauthorized,
        });
        return await classifyTelemetryResponse(response, canStillSend);
      } catch (error) {
        if (isSendSuperseded(canStillSend)) {
          return { kind: DesktopClaudeCodeTelemetryClientResultKind.Deferred };
        }
        return {
          kind: DesktopClaudeCodeTelemetryClientResultKind.Retry,
          error: errorMessage(error),
        };
      }
    },
  };
}

async function resolveRequest(
  options: DesktopClaudeCodeTelemetryClientOptions,
  canStillSend?: () => boolean
): Promise<{
  apiOrigin: string;
  computeTargetId: string;
  token: string;
  credentialKind: SessionRequestCredentialKind;
} | null> {
  const origin = options.getApiOrigin();
  if (!origin) {
    return null;
  }
  const computeTargetId = options.getComputeTargetId();
  if (!computeTargetId) {
    return null;
  }
  const accessToken = await options.getAccessToken();
  if (canStillSend && !canStillSend()) {
    return null;
  }
  if (accessToken) {
    return {
      apiOrigin: origin,
      computeTargetId,
      token: accessToken,
      credentialKind: SessionRequestCredentialKind.AccessToken,
    };
  }
  const apiKey = options.getApiKey?.() ?? null;
  if (!apiKey) {
    return null;
  }
  return {
    apiOrigin: origin,
    computeTargetId,
    token: apiKey,
    credentialKind: SessionRequestCredentialKind.ApiKey,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSendSuperseded(canStillSend?: () => boolean): boolean {
  return canStillSend !== undefined && !canStillSend();
}

async function classifyTelemetryResponse(
  response: Response,
  canStillSend?: () => boolean
): Promise<DesktopClaudeCodeTelemetryClientResult> {
  // An old account's response cannot advance the machine-wide drop watermark.
  if (isSendSuperseded(canStillSend)) {
    return { kind: DesktopClaudeCodeTelemetryClientResultKind.Deferred };
  }
  if (PROTOCOL_UNAVAILABLE_STATUSES.has(response.status)) {
    return {
      kind: DesktopClaudeCodeTelemetryClientResultKind.Unavailable,
      status: response.status,
    };
  }
  if (ROW_REJECTED_STATUSES.has(response.status)) {
    return {
      kind: DesktopClaudeCodeTelemetryClientResultKind.Rejected,
      status: response.status,
    };
  }
  if (!response.ok) {
    return {
      kind: DesktopClaudeCodeTelemetryClientResultKind.Retry,
      status: response.status,
      error: `claude code telemetry sync returned HTTP ${response.status}`,
    };
  }

  const body = await response.json().catch(() => null);
  if (isSendSuperseded(canStillSend)) {
    return { kind: DesktopClaudeCodeTelemetryClientResultKind.Deferred };
  }
  const parsed = desktopClaudeCodeTelemetrySyncAckSchema.safeParse(
    unwrapApiEnvelope(body)
  );
  if (!parsed.success) {
    return {
      kind: DesktopClaudeCodeTelemetryClientResultKind.Retry,
      error: "claude code telemetry sync returned an invalid ack",
    };
  }
  return {
    kind: DesktopClaudeCodeTelemetryClientResultKind.Ack,
    ack: parsed.data,
  };
}
