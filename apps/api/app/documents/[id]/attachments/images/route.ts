import {
  type CreateInlineImageAttachmentResponse,
  MAX_INLINE_IMAGE_ATTACHMENT_REQUEST_BODY_BYTES,
} from "@repo/api/src/types/attachment";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { ApiResult } from "@repo/api/src/types/common";
import type { NextResponse } from "next/server";
import { attachmentInlineImageCreateService } from "@/app/documents/attachment-inline-image-create-service";
import {
  forbiddenAttachmentUploadResponse,
  inlineImageRequestBodyTooLargeResponse,
  mapCreateInlineImageAttachmentFailure,
} from "@/app/documents/attachment-route-responses";
import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import { documentAttachReceiptWrite } from "@/app/documents/document-attach-receipt";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  notFoundResponse,
  readCappedRequestText,
  successResponse,
} from "@/lib/route-utils";
import {
  type CreateInlineImageAttachmentInput,
  createInlineImageAttachmentValidator,
} from "../validators";

export const POST = withAnyAuth<
  CreateInlineImageAttachmentResponse,
  "/documents/[id]/attachments/images"
>(
  withOperationReceipts(
    OperationKind.Attach,
    async ({ authMethod, clerkUserId, user }, request, params, receipts) => {
      if (
        authMethod === "api_key" &&
        !(await isMcpAttachmentUploadEnabled({
          clerkUserId,
          userId: user.id,
        }))
      ) {
        return forbiddenAttachmentUploadResponse();
      }

      const { body, errorResponse: parseError } =
        await parseInlineImageAttachmentBody(request);
      if (parseError) {
        return parseError;
      }

      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Document");
      }

      const result =
        await attachmentInlineImageCreateService.createInlineImageAttachment(
          resolvedId,
          user.organizationId,
          user.id,
          body.filename,
          body.mimeType,
          body.dataBase64,
          receipts.whenRecording((tx) =>
            receipts.record(tx, documentAttachReceiptWrite(resolvedId))
          )
        );
      if (result.ok === false) {
        return mapCreateInlineImageAttachmentFailure(result.error);
      }

      return successResponse(withOperationReceipt(result.value, receipts));
    }
  )
);

async function parseInlineImageAttachmentBody(
  request: Request
): Promise<InlineImageAttachmentBodyResult> {
  const bodyText = await readCappedRequestText(
    request,
    MAX_INLINE_IMAGE_ATTACHMENT_REQUEST_BODY_BYTES
  );
  if (!bodyText.ok) {
    return {
      body: null,
      errorResponse: inlineImageRequestBodyTooLargeResponse(),
    };
  }

  try {
    const rawBody = JSON.parse(bodyText.value) as unknown;
    const parseResult = createInlineImageAttachmentValidator.safeParse(rawBody);
    if (!parseResult.success) {
      return {
        body: null,
        errorResponse: badRequestResponse(
          "Invalid inline image attachment request"
        ),
      };
    }
    return { body: parseResult.data, errorResponse: null };
  } catch {
    return {
      body: null,
      errorResponse: badRequestResponse("Invalid JSON body"),
    };
  }
}

type InlineImageAttachmentBodyResult =
  | {
      body: CreateInlineImageAttachmentInput;
      errorResponse: null;
    }
  | {
      body: null;
      errorResponse: NextResponse<ApiResult<never>>;
    };
