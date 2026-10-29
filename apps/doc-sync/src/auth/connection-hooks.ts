import type {
  onAuthenticatePayload,
  onUpgradePayload,
} from "@hocuspocus/server";
import { log } from "@repo/observability/log";
import { DESKTOP_RENDERER_ORIGIN } from "@repo/realtime-contract/desktop-renderer-origin";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import type { Revocations } from "@repo/realtime-contract/revocations";
import type { RealtimeTokenPublicKeys } from "@repo/realtime-contract/token";
import { z } from "zod";
import {
  authorizeConnection,
  DocSyncAuthError,
  type DocSyncAuthErrorCode,
} from "./authorize";

export const DOC_SYNC_AUTH_REFUSED_EVENT = "doc_sync.auth_refused";
export const DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT =
  "doc_sync.auth_refused_suppressed";

/** What `onAuthenticate` resolves, which Hocuspocus keeps as `Connection.context`. */
export const docSyncConnectionContextSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
  /** The token's `iat`, epoch seconds, so `connected` can re-check revokes. */
  tokenIssuedAt: z.number(),
});
export type DocSyncConnectionContext = z.infer<
  typeof docSyncConnectionContextSchema
>;

/**
 * The Hocuspocus `onAuthenticate` hook (PLN-2099 E4). A read-only grant makes
 * the connection read-only, so Hocuspocus drops its document updates. A
 * refusal rejects with the {@link DocSyncAuthError}, whose `reason` the client
 * receives in `onAuthenticationFailed`. The token's expiry bounds admission,
 * not the connection: PLN-2186 (PLN-2099 E4) accepts an open connection
 * outliving its token, and the internal revoke (`POST /internal/revoke`)
 * closes connections when access changes.
 *
 * Anyone who reaches the socket can provoke a refusal with any document name,
 * so refusal lines are capped by `refusalLogLimit` (PR #8849 review).
 *
 * A document `isDeleted` reports is refused `unauthorized` before the token is
 * verified, so a token minted before the delete admits nothing (PLN-2200
 * T-3.7). It is checked again once the verify resolves: a delete landing
 * during it finds no connection to close, so admitting this one would attach
 * a client to the deleted name. The client sees the same refusal as any other.
 * A delete landing after this hook resolves is closed by the server's
 * `connected` hook.
 */
export function authenticateWithToken(
  publicKeys: RealtimeTokenPublicKeys,
  {
    revocations,
    refusalLogLimit = DEFAULT_REFUSAL_LOG_LIMIT,
    now = Date.now,
    isDeleted = () => false,
  }: {
    revocations: Pick<Revocations, "covers">;
    refusalLogLimit?: RefusalLogLimit;
    now?: () => number;
    isDeleted?: (documentName: string) => boolean;
  }
) {
  const logRefusal = rateLimitedRefusalLog(refusalLogLimit, now);
  const refuseIfDeleted = (documentName: string) => {
    if (isDeleted(documentName)) {
      throw new DocSyncAuthError(RealtimeErrorCode.Unauthorized);
    }
  };
  return async ({
    token,
    documentName,
    connectionConfig,
  }: Pick<
    onAuthenticatePayload,
    "token" | "documentName" | "connectionConfig"
  >): Promise<DocSyncConnectionContext> => {
    try {
      refuseIfDeleted(documentName);
      const principal = await authorizeConnection(
        token,
        documentName,
        publicKeys,
        revocations
      );
      refuseIfDeleted(documentName);
      connectionConfig.readOnly = principal.readOnly;
      return {
        userId: principal.userId,
        orgId: principal.orgId,
        tokenIssuedAt: principal.tokenIssuedAt,
      };
    } catch (error) {
      if (error instanceof DocSyncAuthError) {
        logRefusal(documentName, error.code);
      }
      throw error;
    }
  };
}

/**
 * The Hocuspocus `onUpgrade` hook: a browser upgrade whose `Origin` is not in
 * `allowedOrigins` is answered 403 on the raw socket. An upgrade with no
 * `Origin` (the desktop main process, server clients) is admitted, as
 * realtime's `REALTIME_ALLOWED_ORIGINS` does, and so is the packaged desktop
 * renderer's exact {@link DESKTOP_RENDERER_ORIGIN} (PLN-2189 T-4.2), which the
 * env list cannot carry because `exactOriginListSchema` rejects opaque
 * origins. Rejecting with no value is Hocuspocus 4.7's signal that the upgrade
 * was answered.
 */
export function refuseDisallowedOrigin(allowedOrigins: readonly string[]) {
  return ({
    request,
    socket,
  }: Pick<onUpgradePayload, "request" | "socket">): Promise<void> => {
    const origin = request.headers.origin;
    if (
      origin === undefined ||
      origin === DESKTOP_RENDERER_ORIGIN ||
      allowedOrigins.includes(origin)
    ) {
      return Promise.resolve();
    }
    socket.end(FORBIDDEN_UPGRADE_RESPONSE);
    return Promise.reject();
  };
}

const FORBIDDEN_UPGRADE_RESPONSE =
  "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/** The most refusal lines one process logs per window. */
type RefusalLogLimit = { maxPerWindow: number; windowMs: number };

const DEFAULT_REFUSAL_LOG_LIMIT: RefusalLogLimit = {
  maxPerWindow: 20,
  windowMs: 60_000,
};

/**
 * Logs at most `maxPerWindow` refusals per window, the window opening at the
 * first refusal after the last one ended. A window that dropped lines ends
 * with one {@link DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT} line carrying the
 * count. Counters only, so no document name an attacker picks is retained.
 */
function rateLimitedRefusalLog(
  { maxPerWindow, windowMs }: RefusalLogLimit,
  now: () => number
): (documentName: string, code: DocSyncAuthErrorCode) => void {
  let windowStart = Number.NEGATIVE_INFINITY;
  let logged = 0;
  let suppressed = 0;
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;

  const endWindow = () => {
    clearTimeout(summaryTimer);
    summaryTimer = undefined;
    if (suppressed > 0) {
      log.info("Doc sync connection refusals suppressed", {
        event: DOC_SYNC_AUTH_REFUSED_SUPPRESSED_EVENT,
        suppressedCount: suppressed,
        windowMs,
      });
    }
    windowStart = Number.NEGATIVE_INFINITY;
    logged = 0;
    suppressed = 0;
  };

  return (documentName, code) => {
    const at = now();
    if (at - windowStart >= windowMs) {
      endWindow();
      windowStart = at;
    }
    if (logged < maxPerWindow) {
      logged += 1;
      log.info("Doc sync connection refused", {
        event: DOC_SYNC_AUTH_REFUSED_EVENT,
        documentName,
        code,
      });
      return;
    }
    suppressed += 1;
    // Unref'd: a pending summary never holds the process open at shutdown.
    summaryTimer ??= setTimeout(endWindow, windowStart + windowMs - at).unref();
  };
}
