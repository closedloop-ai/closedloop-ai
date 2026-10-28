import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { ApiResult } from "@repo/api/src/types/common";
import { conflictBody } from "@repo/api/src/types/common";
import {
  GRID_PREFERENCE_CONTRACT_VERSION,
  type GridPreferenceReadResponse,
  GridPreferenceReadStatus,
  type GridPreferenceResetResponse,
  type GridPreferenceRevisionConflict,
  type GridPreferenceUpsertResponse,
  GridPreferenceWriteStatus,
} from "@repo/api/src/types/grid-preferences";
import {
  gridPreferenceReadQuerySchema,
  gridPreferenceResetQuerySchema,
} from "@repo/api/src/types/grid-preferences-schema";
import { Status } from "@repo/api/src/types/result";
import { type NextRequest, NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  parseQueryParams,
  readCappedRequestText,
  successResponse,
} from "@/lib/route-utils";
import { recordGridPreferenceWrite } from "./grid-preference-receipt";
import { gridPreferenceService } from "./grid-preference-service";
import {
  GRID_PREFERENCE_REQUEST_MAX_BYTES,
  gridPreferenceUpsertRequestValidator,
} from "./validators";

export const GET = withAnyAuth<
  GridPreferenceReadResponse,
  "/settings/grid-preferences"
>(async ({ user }, request) => {
  const { params, errorResponse: queryError } = parseQueryParams(
    request,
    gridPreferenceReadQuerySchema
  );
  if (queryError) {
    return queryError;
  }

  try {
    if (params.selector === undefined) {
      const preferences = await gridPreferenceService.listPreferences({
        organizationId: user.organizationId,
        userId: user.id,
      });
      return successResponse({
        status: GridPreferenceReadStatus.List,
        preferences,
        contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      });
    }

    const preference = await gridPreferenceService.getPreference({
      organizationId: user.organizationId,
      userId: user.id,
      ...params.selector,
    });
    if (preference === null) {
      return successResponse({
        status: GridPreferenceReadStatus.Missing,
        selector: params.selector,
        contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      });
    }
    return successResponse({
      status: GridPreferenceReadStatus.Found,
      preference,
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
    });
  } catch (error) {
    return errorResponse("Failed to read grid preferences", error);
  }
});

export const POST = withAnyAuth<
  GridPreferenceUpsertResponse,
  "/settings/grid-preferences"
>(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, request, _params, receipts) => {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        gridPreferenceUpsertRequestValidator,
        { maxBytes: GRID_PREFERENCE_REQUEST_MAX_BYTES }
      );
      if (parseError) {
        return parseError;
      }
      if (!body) {
        return badRequestResponse("Invalid grid preference request body");
      }

      try {
        const result = await gridPreferenceService.upsertPreference(
          {
            organizationId: user.organizationId,
            userId: user.id,
            ...body,
          },
          recordGridPreferenceWrite(receipts)
        );
        if (!result.ok) {
          return staleRevisionResponse(result.error.conflict);
        }
        return successResponse(
          withOperationReceipt(
            {
              status: GridPreferenceWriteStatus.Stored,
              preference: result.value,
              contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
            },
            receipts
          )
        );
      } catch (error) {
        return errorResponse("Failed to write grid preference", error);
      }
    }
  )
);

export const DELETE = withAnyAuth<
  GridPreferenceResetResponse,
  "/settings/grid-preferences"
>(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, request, _params, receipts) => {
      const bodyError = await rejectDeleteBody(request);
      if (bodyError) {
        return bodyError;
      }

      const { params, errorResponse: queryError } = parseQueryParams(
        request,
        gridPreferenceResetQuerySchema
      );
      if (queryError) {
        return queryError;
      }

      try {
        const result = await gridPreferenceService.resetPreference(
          {
            organizationId: user.organizationId,
            userId: user.id,
            ...params,
          },
          recordGridPreferenceWrite(receipts)
        );
        if (!result.ok) {
          return staleRevisionResponse(result.error.conflict);
        }
        return successResponse(withOperationReceipt(result.value, receipts));
      } catch (error) {
        return errorResponse("Failed to reset grid preference", error);
      }
    }
  )
);

function staleRevisionResponse(
  conflict: GridPreferenceRevisionConflict
): NextResponse<ApiResult<never>> {
  return NextResponse.json(
    conflictBody("Grid preference revision conflict", conflict),
    { status: Status.Conflict }
  ) as NextResponse<ApiResult<never>>;
}

async function rejectDeleteBody(
  request: NextRequest
): Promise<NextResponse<ApiResult<never>> | null> {
  try {
    const body = await readCappedRequestText(request, 0);
    if (body.ok && body.bytesRead === 0 && body.value.length === 0) {
      return null;
    }
    return badRequestResponse(
      "DELETE /settings/grid-preferences does not accept a request body"
    );
  } catch (error) {
    return errorResponse("Failed to read grid preference reset body", error);
  }
}
