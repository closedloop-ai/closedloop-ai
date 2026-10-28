import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  recordNoOpUnlessRecorded,
  recordOrganizationWrite,
} from "@/lib/organization-write-receipt";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { documentTemplatesService } from "../service";
export const POST = withAnyAuth<{ message: string }, "/templates/seed">(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user }, _request, _params, receipts) => {
      try {
        await documentTemplatesService.ensureDefaultTemplates(
          user.organizationId,
          user.id,
          recordOrganizationWrite(receipts)
        );
        // ISS-12552: templates already seeded take the fast path, which
        // writes nothing, so it is recorded as a no-op on its own.
        await recordNoOpUnlessRecorded(receipts);
        return successResponse(
          withOperationReceipt(
            { message: "Default templates ensured successfully" },
            receipts
          )
        );
      } catch (error) {
        return errorResponse("Failed to ensure default templates", error);
      }
    }
  )
);
