import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { failure } from "@repo/api/src/types/common";
import { DesktopComponentsSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { NextResponse } from "next/server";
import {
  readBoundedJsonBody,
  requireComputeTargetId,
} from "@/app/desktop/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseDesktopAgentComponentsPayload } from "@/lib/desktop-agent-components-parse";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import { writeInShape } from "@/lib/record-write-in-transaction";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
} from "@/lib/route-utils";
import { componentSyncReceiptWrite } from "./component-sync-receipt";
import type { DesktopComponentsSyncResponse } from "./contract";
import { desktopComponentsSyncService } from "./service";

const DESKTOP_COMPONENTS_SYNC_REQUEST_MAX_BYTES = 262_144; // 256 KiB

/**
 * ISS-8145: the explicit function ceiling its sibling desktop write lanes all
 * declare and this one did not, leaving it on the platform default.
 *
 * 60, matching `desktop/agent-sessions/sync`, for
 * the reason they give: the desktop client aborts at 30s, so the function needs
 * headroom ABOVE that — a slow-but-successful sync commits server-side and the
 * client's retry lands on the idempotent upsert, instead of the platform
 * default killing the write mid-flight and answering with something the client
 * cannot taxonomize. Not the 15 of `desktop/telemetry` and `desktop/analytics`:
 * those post a fixed-size record, while this lane's statement count scales with
 * the components in the payload.
 */
export const maxDuration = 60;

/**
 * POST /desktop/components/sync?computeTargetId=<id>
 *
 * Receives a batch of component inventory existence rows materialized by the
 * desktop at transcript-import time. Upserts `AgentComponent` rows in the cloud
 * keyed by `(computeTargetId, componentKind, externalComponentId)`.
 *
 * - 256 KiB request body cap, read through the shared desktop write-lane
 *   `readBoundedJsonBody` so the read is streamed rather than buffered then
 *   measured (ISS-7665).
 * - Accepts any authenticated caller (API-key, desktop-session, or Clerk session).
 * - Verifies compute-target ownership before writing.
 * - Delegates to `desktopComponentsSyncService.sync`; no server-side re-parse.
 *
 * Schema version is validated against the accepted SET,
 * `ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS`, so a bump deploys here before
 * the desktop that stamps it. A well-formed version outside that set is skew and
 * 400s with `schema_version_unsupported`; every other rejection is a coded 422.
 */
export const POST = withAnyAuth<
  DesktopComponentsSyncResponse,
  "/desktop/components/sync"
>(
  withOperationReceipts(
    OperationKind.DesktopSync,
    async ({ user, clerkUserId }, request, _params, receipts) => {
      const { computeTargetId, response: computeTargetIdResponse } =
        requireComputeTargetId(request);
      if (computeTargetIdResponse) {
        return computeTargetIdResponse;
      }

      const { rawBody, response } = await readBoundedJsonBody(
        request,
        DESKTOP_COMPONENTS_SYNC_REQUEST_MAX_BYTES
      );
      if (response) {
        return response;
      }

      // Sanitizes NULs / lone surrogates for Postgres BEFORE validating — a
      // NUL-bearing definition body would otherwise pass the schema and then 500 on
      // the `text` write, leaving the desktop cursor retrying the same poison batch.
      const parsed = parseDesktopAgentComponentsPayload(rawBody);
      if (!parsed.ok) {
        // Version skew is the one rejection an API deploy can fix, and so the only
        // one that earns the cursor-holding 400 (ISS-7978). ISS-8609 puts a CODE on
        // it, so the lane reads the skew off the wire instead of inferring it from
        // the status — which it could only do by folding every 400 the same way,
        // content-attributable ones included. The verdict is the PARSER's because
        // only the parser sees the sanitized payload the schema actually judged;
        // everything else takes the 422 an installed desktop dead-letters.
        if (parsed.schemaVersionSkew) {
          return badRequestResponse("Invalid component sync payload", {
            code: DesktopComponentsSyncRestErrorCode.SchemaVersionUnsupported,
          });
        }
        return NextResponse.json(
          failure("Invalid component sync payload", {
            code: DesktopComponentsSyncRestErrorCode.ValidationFailed,
            details: { reason: parsed.reason },
          }),
          { status: 422 }
        );
      }

      try {
        const input = {
          clerkUserId,
          computeTargetId,
          organizationId: user.organizationId,
          payload: parsed.payload,
          userId: user.id,
        };
        const result = await writeInShape(
          receipts.whenRecording((tx) =>
            receipts.record(tx, componentSyncReceiptWrite())
          ),
          {
            unrecorded: () => desktopComponentsSyncService.sync(input),
            recorded: (recordWrite) =>
              desktopComponentsSyncService.sync(input, recordWrite),
          }
        );

        if (result.ok) {
          return successResponse(result.value);
        }
        // The service's only value error is the ownership/policy gate's 403.
        return forbiddenResponse();
      } catch (error) {
        return errorResponse("Failed to sync component inventory", error);
      }
    }
  )
);
