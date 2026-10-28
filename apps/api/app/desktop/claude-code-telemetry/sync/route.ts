import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_REQUEST_MAX_BYTES,
  DesktopClaudeCodeTelemetrySyncAckReason,
  DesktopClaudeCodeTelemetrySyncErrorCode,
  type DesktopClaudeCodeTelemetrySyncResponse,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { Status } from "@repo/api/src/types/result";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS } from "@/lib/fixed-window-rate-limiter";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
} from "@/lib/route-utils";
import {
  rateLimitedResponse,
  readBoundedJsonBody,
  requireComputeTargetId,
} from "../../route-helpers";
import { claudeCodeTelemetryReceiptWrite } from "./claude-code-telemetry-receipt";
import { desktopClaudeCodeTelemetrySyncService } from "./service";

/**
 * ISS-10717 — `POST /desktop/claude-code-telemetry/sync`.
 *
 * The Claude Code OTel lane's ingest. Thin: it gates the compute target, bounds
 * the body, and maps the service's failure taxonomy onto the status codes the
 * desktop client dispatches on.
 *
 * The status split is load-bearing for the lane's retry budget
 * (`apps/desktop/src/main/sync/AGENTS.md` invariant 4): only 400
 * (`ValidationFailed`) is session-attributable and may exhaust a session's
 * budget. 403, 429, 501 and 500 are all lane-wide and defer with the budget
 * intact, so a server-side outage or a version skew can never strand the whole
 * corpus.
 */

/** The desktop client aborts at 30s; the function gets headroom above that. */
export const maxDuration = 60;

export const POST = withAnyAuth<
  DesktopClaudeCodeTelemetrySyncResponse,
  "/desktop/claude-code-telemetry/sync"
>(
  withOperationReceipts(
    OperationKind.Telemetry,
    async ({ user, clerkUserId }, request, _params, receipts) => {
      const { computeTargetId, response: targetResponse } =
        requireComputeTargetId(request);
      if (targetResponse) {
        return targetResponse;
      }

      const { rawBody, response } = await readBoundedJsonBody(
        request,
        DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_REQUEST_MAX_BYTES
      );
      if (response) {
        return response;
      }

      try {
        const result = await desktopClaudeCodeTelemetrySyncService.sync(
          {
            clerkUserId,
            computeTargetId,
            organizationId: user.organizationId,
            rawBody,
            userId: user.id,
          },
          receipts.whenRecording((tx, written) =>
            receipts.record(tx, claudeCodeTelemetryReceiptWrite(written))
          )
        );

        if (result.ok) {
          return successResponse(withOperationReceipt(result.value, receipts));
        }
        if (
          result.error.reason ===
          DesktopClaudeCodeTelemetrySyncAckReason.ValidationFailed
        ) {
          return badRequestResponse("Invalid claude code telemetry payload", {
            code: DesktopClaudeCodeTelemetrySyncErrorCode.ValidationFailed,
          });
        }
        if (result.error.reason === Status.Forbidden) {
          return forbiddenResponse({
            code: DesktopClaudeCodeTelemetrySyncErrorCode.Forbidden,
          });
        }
        if (
          result.error.reason ===
          DesktopClaudeCodeTelemetrySyncAckReason.RateLimited
        ) {
          return rateLimitedResponse(
            DesktopClaudeCodeTelemetrySyncErrorCode.RateLimited,
            FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS
          );
        }
        // 501 Not Implemented, deliberately: this build cannot interpret the
        // payload's protocol version. The desktop client reads 501 as "protocol
        // unavailable" and defers WITHOUT spending budget, which is what keeps a
        // desktop ahead of the API from walking its whole corpus into dead letters.
        if (
          result.error.reason ===
          DesktopClaudeCodeTelemetrySyncAckReason.ProtocolUnsupported
        ) {
          return errorResponse(
            "Unsupported claude code telemetry protocol version",
            new Error(
              DesktopClaudeCodeTelemetrySyncAckReason.ProtocolUnsupported
            ),
            501,
            {
              code: DesktopClaudeCodeTelemetrySyncErrorCode.ProtocolUnsupported,
            }
          );
        }
        return errorResponse(
          "Failed to sync claude code telemetry",
          new Error(String(result.error.reason)),
          500,
          { code: DesktopClaudeCodeTelemetrySyncErrorCode.IngestionFailed }
        );
      } catch (error) {
        return errorResponse(
          "Failed to sync claude code telemetry",
          error,
          500,
          {
            code: DesktopClaudeCodeTelemetrySyncErrorCode.InternalError,
          }
        );
      }
    }
  )
);
