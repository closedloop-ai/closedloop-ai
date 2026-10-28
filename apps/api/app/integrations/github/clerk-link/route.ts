import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { GitHubClerkLinkSyncResponse } from "@repo/api/src/types/github";
import { GITHUB_CLERK_RELINK_ATTEMPTED_PARAM } from "@repo/api/src/types/github-clerk-link";
import { waitUntil } from "@vercel/functions";
import { syncClerkLinkedIdentity } from "@/app/integrations/github/clerk-link-service";
import { runPostConnectObservedSync } from "@/app/integrations/github/post-connect-sync-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  recordNoOpUnlessRecorded,
  recordOrganizationWrite,
} from "@/lib/organization-write-receipt";
import { successResponse } from "@/lib/route-utils";

/**
 * ISS-7721: the post-connect sync runs in this route's `waitUntil` lane, and the
 * platform bounds that lane by the function's own ceiling rather than by when
 * the response was sent. Undeclared, the chain would be killed at the default
 * mid-sweep — invisibly, since nobody is waiting on it.
 *
 * Route-segment config must be a static literal, so this number cannot import
 * the gate lease it has to agree with; `post-connect-max-duration.test.ts` pins
 * the two together instead.
 */
export const maxDuration = 300;

/**
 * POST /integrations/github/clerk-link
 *
 * PLN-1742 M3: called by the web linking page after Clerk verifies a GitHub
 * external account. Resolves the caller's GitHub identity (Clerk-first),
 * which creates the token-less registry row, and reports whether the link
 * yields a usable credential.
 */
export const POST = withAnyAuth<
  GitHubClerkLinkSyncResponse,
  "/integrations/github/clerk-link"
>(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user }, request, _params, receipts) => {
      const result = await syncClerkLinkedIdentity({
        organizationId: user.organizationId,
        userId: user.id,
        // Read off the URL rather than the body: this route parses no body today,
        // and a presence check needs no schema. Absent reads as "not yet through
        // consent", which is the failure record's quiet default.
        relinkAttempted: new URL(request.url).searchParams.has(
          GITHUB_CLERK_RELINK_ATTEMPTED_PARAM
        ),
        // ISS-12552: the receipt commits with the registry row's
        // create, refresh or unlink marker, after the Clerk and GitHub reads.
        recordRegistryWrite: recordOrganizationWrite(receipts),
      });
      if (result.linked) {
        // A registry row refreshed within its sample interval is not rewritten.
        await recordNoOpUnlessRecorded(receipts);
        // ISS-7721: this is the installation-free lane's connect completion, so it
        // is where the App lane's post-claim reconcile kick
        // (`service/installation-claim.ts`) has its analogue. Only a linked result
        // gets one: without a usable credential the chain has nothing to read with.
        waitUntil(
          runPostConnectObservedSync({ organizationId: user.organizationId })
        );
      }
      return successResponse(withOperationReceipt(result, receipts));
    }
  )
);
