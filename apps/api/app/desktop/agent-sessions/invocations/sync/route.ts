import {
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_BATCH_BYTES,
  type AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncRejectReason,
  isSupportedAgentComponentInvocationSyncProtocolVersion,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncBatchSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { failure } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readBoundedJsonBody } from "@/app/desktop/route-helpers";
import { sanitizePostgresText } from "@/lib/agent-sessions-text-sanitizer";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
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
import { invocationSyncReceiptWrite } from "./invocation-sync-receipt";
import { desktopAgentComponentInvocationsSyncService } from "./service";

/**
 * Dedicated component-invocation sync; session schema v2 is unchanged. Accepts
 * every version in `AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS`
 * — each one the narrowest part shape that predates the next field's arrival —
 * so an older Desktop keeps syncing against this build, and echoes the
 * request's version on the ack so that older client's strict ack parser still
 * recognizes the reply.
 */
export const POST = withAnyAuth<
  AgentComponentInvocationSyncAck,
  "/desktop/agent-sessions/invocations/sync"
>(
  withOperationReceipts(
    OperationKind.DesktopSync,
    async ({ user, clerkUserId, authMethod }, request, _params, receipts) => {
      // ISS-8618: deliberately NOT `requireComputeTargetId`. That helper also
      // shape-checks the id (ISS-8734) and answers a coded 400 for a non-UUID,
      // which this lane's exact per-part ack has no `details.reason` channel to
      // carry — an installed desktop would read the bare 400 as `validation_failed`
      // and charge a per-part dead-letter budget for a lane-wide condition.
      // Converging it is a wire change; this issue is a behavior-preserving one.
      // The BODY scaffold below is shared because it IS byte-identical.
      //
      // The MISSING-id 400 below has the same defect for the same reason, and it
      // predates this issue: uncoded, so the lane charges it to whichever parts are
      // in flight. The desktop client never sends the request without an id, but
      // this route is `withAnyAuth`, so an `sk_live_*` producer can — the same
      // producer `logInvocationSyncValidationFailure` calls out one branch down.
      // ISS-10151 owns coding it.
      const computeTargetId = new URL(request.url).searchParams
        .get("computeTargetId")
        ?.trim();
      if (!computeTargetId) {
        return badRequestResponse("computeTargetId is required");
      }

      const { rawBody, response } = await readBoundedJsonBody(
        request,
        AGENT_COMPONENT_INVOCATION_SYNC_MAX_BATCH_BYTES
      );
      if (response) {
        return response;
      }
      if (hasUnsupportedProtocolVersion(rawBody)) {
        return NextResponse.json(
          failure("Unsupported component invocation sync protocol", {
            code: AgentComponentInvocationSyncRejectReason.ProtocolUnsupported,
          }),
          { status: 501 }
        );
      }
      const parsed = agentComponentInvocationSyncBatchSchema.safeParse(rawBody);
      if (!parsed.success) {
        logInvocationSyncValidationFailure({
          computeTargetId,
          issues: parsed.error.issues,
          organizationId: user.organizationId,
          rawBody,
        });
        return badRequestResponse("Invalid component invocation sync payload");
      }
      const part = parsed.data.parts[0];
      if (!part) {
        return badRequestResponse("Invalid component invocation sync payload");
      }

      try {
        const result = await desktopAgentComponentInvocationsSyncService.sync(
          {
            authMethod,
            clerkUserId,
            computeTargetId,
            organizationId: user.organizationId,
            part,
            userId: user.id,
          },
          receipts.whenRecording((tx, ingested) =>
            receipts.record(tx, invocationSyncReceiptWrite(ingested))
          )
        );
        if (result.ok) {
          return successResponse(withOperationReceipt(result.value, receipts));
        }
        // ISS-11426: the code, not a bare 403. Ownership is the service's only
        // refusal (ISS-11449). The 403 STATUS is what ISS-8599 kept for the
        // transcript lane — changing it would break every installed client at once —
        // with the code additive in the body.
        return forbiddenResponse({ code: result.error });
      } catch (error) {
        return errorResponse("Failed to sync component invocations", error);
      }
    }
  )
);

function hasUnsupportedProtocolVersion(rawBody: unknown): boolean {
  if (
    typeof rawBody !== "object" ||
    rawBody === null ||
    Array.isArray(rawBody)
  ) {
    return false;
  }
  const protocolVersion = Reflect.get(rawBody, "protocolVersion");
  // ISS-4976: the gate is a SET membership test, not equality with one
  // constant. A version this build does not know still answers the retryable
  // `protocol_unsupported` (501) rather than falling through to the `.strict()`
  // schema, whose 400 the Desktop client classes as a permanent
  // `validation_failed` and dead-letters after five attempts.
  //
  // @tamsinb review: the membership test itself is the SHARED predicate, so
  // this gate and the Desktop outbox loader answer "can I handle this version?"
  // from the one tuple the producer picks from and cannot drift apart.
  return (
    typeof protocolVersion === "number" &&
    !isSupportedAgentComponentInvocationSyncProtocolVersion(protocolVersion)
  );
}

/**
 * Best-effort identifiers for a part that FAILED validation, so every field is
 * optional and a wrong-typed one degrades to absent rather than costing the
 * whole log line — `.catch` for the same reason the pull-request ref fields
 * carry it.
 */
const rejectedPartIdentitySchema = z
  .object({
    parts: z
      .array(
        z.object({
          externalGenerationId: z.string().optional().catch(undefined),
          externalSessionId: z.string().optional().catch(undefined),
          partIndex: z.number().int().optional().catch(undefined),
        })
      )
      .optional()
      .catch(undefined),
  })
  .catch({});

/** Bound on issues per log line; one rejected part can raise one per item. */
const MAX_LOGGED_VALIDATION_ISSUES = 20;

/**
 * ISS-9174: values this schema now rejects used to reach `ingestPartInTx` and
 * be logged there as "Agent component invocation ingest failed" — the line that
 * made ISS-9174 findable at all. An upgraded desktop names the failing field
 * locally, but an older client or an `sk_live_*` producer sees only a bare 400,
 * so without this the server keeps no record that the part existed.
 *
 * Issue paths, codes and messages only, never the rejected values: those bytes
 * are exactly the ones no text sink should carry. `unrecognized_keys` embeds a
 * payload-controlled key in its message, so the message is sanitized too.
 */
function logInvocationSyncValidationFailure(context: {
  computeTargetId: string;
  issues: readonly z.core.$ZodIssue[];
  organizationId: string;
  rawBody: unknown;
}): void {
  const part = rejectedPartIdentitySchema.parse(context.rawBody).parts?.[0];
  log.error("Agent component invocation sync payload rejected", {
    organizationId: context.organizationId,
    computeTargetId: context.computeTargetId,
    externalSessionId: part?.externalSessionId,
    externalGenerationId: part?.externalGenerationId,
    partIndex: part?.partIndex,
    issueCount: context.issues.length,
    issues: context.issues
      .slice(0, MAX_LOGGED_VALIDATION_ISSUES)
      .map((issue) => ({
        path: issue.path.map(String).join("."),
        code: issue.code,
        message: sanitizePostgresText(issue.message),
      })),
  });
}
