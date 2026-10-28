import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { CreatePrArtifactResponse } from "@repo/api/src/types/pull-request-artifact-link";
import { createPrArtifactValidator } from "@repo/api/src/types/pull-request-artifact-link";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { branchUpsertReceiptWrite } from "../branches/upsert-receipt";
import { pullRequestArtifactLinkService } from "./pull-request-artifact-service";
import { createPullRequestArtifactErrorResponse } from "./route-response";

/**
 * POST /artifact-links/pull-requests
 *
 * Deprecated compatibility alias for callers that still submit a PR-shaped
 * payload. The route now materializes a BRANCH artifact and stores the PR as
 * optional current detail, so compatibility clients do not create legacy
 * PULL_REQUEST artifacts.
 *
 * The repositoryId is derived server-side from the project's default
 * repository setting so the client doesn't have to thread it through.
 *
 * ISS-10169 — VERIFYING WHAT THIS WROTE. A 200 from here reports the write it
 * actually performed, so no second request is needed to confirm it:
 * `linkedArtifacts` lists every PRODUCES edge committed (read back from the
 * upsert, and `[]` only when none was asked for), `branchArtifactCreated` says
 * whether `id` names a row this call created or an existing branch it resolved,
 * and `currentPullRequest` carries the number and url of the PR that branch now
 * carries. Previously the response echoed the REQUEST — a caller could not tell
 * "linked" from "did nothing", and `GET /documents/<slug>` does not embed links,
 * so reading the document back was itself a false negative. The sound
 * cross-check remains `GET /artifact-links?artifactId=<uuid>`; it is no longer
 * the only one.
 */
export const POST = withAnyAuth<
  CreatePrArtifactResponse,
  "/artifact-links/pull-requests"
>(
  withOperationReceipts(
    OperationKind.Create,
    async ({ user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          createPrArtifactValidator
        );
        if (parseError) {
          return parseError;
        }

        const result =
          await pullRequestArtifactLinkService.createPullRequestArtifact(
            {
              body,
              createdById: user.id,
              organizationId: user.organizationId,
            },
            receipts.whenRecording((tx, branch) =>
              receipts.record(tx, branchUpsertReceiptWrite(branch))
            )
          );
        if (!result.ok) {
          return createPullRequestArtifactErrorResponse(result.error);
        }

        // ISS-4764: return the whole service result, not just `{ id }` — the
        // label-sync status and the link echo are what let the dialog stop
        // claiming success it cannot observe.
        return successResponse(withOperationReceipt(result.value, receipts));
      } catch (error) {
        return errorResponse("Failed to create pull request artifact", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
