import {
  buildInlineAttachmentMarkdownImage,
  buildInlineAttachmentRef,
  CreateInlineImageAttachmentErrorCode,
} from "@repo/api/src/types/attachment";
import type {
  CreateDocumentVersionInlineImageInput,
  CreatedDocumentVersionInlineImage,
} from "@repo/api/src/types/document-version";
import {
  Result,
  type Result as ServiceResult,
} from "@repo/api/src/types/result";
import { log } from "@repo/observability/log";
import { attachmentsService } from "./attachments-service";
import type { CreateInlineImageAttachmentError } from "./inline-image-attachment-contract";

/**
 * Error shape for inline-image placeholder/content validation before storage
 * side effects begin.
 */
export type InlineImageContentError<Code extends string> = {
  code: Code;
  placeholder?: string;
  estimatedContentChars?: number;
  maxContentChars?: number;
};

/** Error-code mapping supplied by the owning create-document/version flow. */
export type InlineImageContentErrorCodes<Code extends string> = {
  DuplicateInlineImagePlaceholder: Code;
  ExpandedContentTooLarge: Code;
  MissingInlineImagePlaceholder: Code;
  OverlappingInlineImagePlaceholder: Code;
};

/** Arguments for one inline-image attachment creation attempt. */
export type CreateInlineImageAttachmentSafelyArgs = {
  documentId: string;
  organizationId: string;
  userId: string;
  inlineImage: CreateDocumentVersionInlineImageInput;
  logScope: string;
  failureReason: string;
};

/**
 * Validate placeholders and final expanded content size before any attachment
 * writes occur.
 */
export function validateInlineImagesBeforeSideEffects<Code extends string>(
  content: string,
  inlineImages: CreateDocumentVersionInlineImageInput[],
  errorCodes: InlineImageContentErrorCodes<Code>,
  maxContentChars: number
): ServiceResult<void, InlineImageContentError<Code>> {
  const placeholders = new Set<string>();
  for (const inlineImage of inlineImages) {
    if (inlineImage.placeholder.length === 0) {
      return Result.err({
        code: errorCodes.MissingInlineImagePlaceholder,
        placeholder: inlineImage.placeholder,
      });
    }
    if (placeholders.has(inlineImage.placeholder)) {
      return Result.err({
        code: errorCodes.DuplicateInlineImagePlaceholder,
        placeholder: inlineImage.placeholder,
      });
    }
    placeholders.add(inlineImage.placeholder);
    if (!content.includes(inlineImage.placeholder)) {
      return Result.err({
        code: errorCodes.MissingInlineImagePlaceholder,
        placeholder: inlineImage.placeholder,
      });
    }
  }

  const overlappingPlaceholder = findOverlappingInlineImagePlaceholder([
    ...placeholders,
  ]);
  if (overlappingPlaceholder !== null) {
    return Result.err({
      code: errorCodes.OverlappingInlineImagePlaceholder,
      placeholder: overlappingPlaceholder,
    });
  }

  const projectedContentSize = estimateExpandedContentSize(
    content,
    inlineImages,
    maxContentChars
  );
  if (projectedContentSize.estimatedChars > projectedContentSize.maxChars) {
    return Result.err({
      code: errorCodes.ExpandedContentTooLarge,
      estimatedContentChars: projectedContentSize.estimatedChars,
      maxContentChars: projectedContentSize.maxChars,
    });
  }

  return Result.ok(undefined);
}

/** Create one inline image attachment and normalize unexpected throws. */
export async function createInlineImageAttachmentSafely({
  documentId,
  failureReason,
  inlineImage,
  logScope,
  organizationId,
  userId,
}: CreateInlineImageAttachmentSafelyArgs): Promise<
  ServiceResult<CreatedInlineImageSource, CreateInlineImageAttachmentError>
> {
  try {
    return await attachmentsService.createInlineImageAttachment(
      documentId,
      organizationId,
      userId,
      inlineImage.filename,
      inlineImage.mimeType,
      inlineImage.dataBase64
    );
  } catch (error) {
    log.error(`${logScope} Inline image creation threw`, {
      documentId,
      error: getSafeInlineImageErrorMessage(error),
      organizationId,
      placeholder: inlineImage.placeholder,
      reason: failureReason,
    });
    return Result.err({
      code: CreateInlineImageAttachmentErrorCode.PersistenceFailed,
    });
  }
}

/** Build the route/service response metadata for a created inline image. */
export function buildCreatedInlineImage(
  source: CreatedInlineImageSource,
  inlineImage: CreateDocumentVersionInlineImageInput
): CreatedDocumentVersionInlineImage {
  const markdownImage = buildInlineAttachmentMarkdownImage(
    source.attachmentRef,
    inlineImage.altText,
    inlineImage.filename
  );
  return {
    attachment: source.attachment,
    attachmentId: source.attachmentId,
    attachmentRef: source.attachmentRef,
    markdownImage,
    placeholder: inlineImage.placeholder,
  };
}

/**
 * Replace all placeholders with Markdown images. Longer placeholders are
 * matched first so nested/overlapping tokens cannot partially replace each
 * other after validation.
 */
export function replaceInlineImagePlaceholders(
  content: string,
  inlineImages: CreatedDocumentVersionInlineImage[]
): string {
  const replacements = [...inlineImages].sort(
    (left, right) => right.placeholder.length - left.placeholder.length
  );
  let result = "";
  let index = 0;

  while (index < content.length) {
    const replacement = replacements.find((candidate) =>
      content.startsWith(candidate.placeholder, index)
    );
    if (replacement) {
      result += replacement.markdownImage;
      index += replacement.placeholder.length;
      continue;
    }
    result += content[index];
    index += 1;
  }

  return result;
}

/** Delete created inline attachments and report how many cleanup attempts failed. */
export async function cleanupCreatedInlineImages({
  createdImages,
  documentId,
  logScope,
  organizationId,
  reason,
  userId,
}: {
  createdImages: CreatedDocumentVersionInlineImage[];
  documentId: string;
  logScope: string;
  organizationId: string;
  reason: string;
  userId: string;
}): Promise<{ failedCount: number }> {
  let failedCount = 0;
  for (const createdImage of createdImages) {
    try {
      const deleteResult = await attachmentsService.deleteAttachment(
        documentId,
        organizationId,
        userId,
        createdImage.attachmentId
      );
      if (!deleteResult.ok) {
        failedCount += 1;
        log.warn(`${logScope} Inline image cleanup failed`, {
          attachmentId: createdImage.attachmentId,
          cleanupErrorCode: deleteResult.error.code,
          documentId,
          organizationId,
          reason,
        });
      }
    } catch (error) {
      failedCount += 1;
      log.warn(`${logScope} Inline image cleanup threw`, {
        attachmentId: createdImage.attachmentId,
        documentId,
        error: getSafeInlineImageErrorMessage(error),
        organizationId,
        reason,
      });
    }
  }
  return { failedCount };
}

function findOverlappingInlineImagePlaceholder(
  placeholders: string[]
): string | null {
  for (const placeholder of placeholders) {
    for (const candidate of placeholders) {
      if (placeholder === candidate) {
        continue;
      }
      if (placeholder.includes(candidate) || candidate.includes(placeholder)) {
        return placeholder.length <= candidate.length ? placeholder : candidate;
      }
    }
  }
  return null;
}

function estimateExpandedContentSize(
  content: string,
  inlineImages: CreateDocumentVersionInlineImageInput[],
  maxContentChars: number
): ProjectedInlineImageContentSize {
  let estimatedChars = content.length;
  for (const inlineImage of inlineImages) {
    const occurrenceCount = countPlaceholderOccurrences(
      content,
      inlineImage.placeholder
    );
    const replacementChars = estimateInlineImageMarkdownChars(inlineImage);
    estimatedChars +=
      occurrenceCount * (replacementChars - inlineImage.placeholder.length);
  }
  return {
    estimatedChars,
    maxChars: maxContentChars,
  };
}

function countPlaceholderOccurrences(content: string, placeholder: string) {
  let count = 0;
  let index = 0;
  while (index < content.length) {
    const nextIndex = content.indexOf(placeholder, index);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    index = nextIndex + placeholder.length;
  }
  return count;
}

function estimateInlineImageMarkdownChars(
  inlineImage: CreateDocumentVersionInlineImageInput
): number {
  return buildInlineAttachmentMarkdownImage(
    ESTIMATED_MAX_INLINE_ATTACHMENT_REF,
    inlineImage.altText,
    inlineImage.filename
  ).length;
}

function getSafeInlineImageErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ProjectedInlineImageContentSize = {
  estimatedChars: number;
  maxChars: number;
};

type CreatedInlineImageSource =
  Awaited<
    ReturnType<typeof attachmentsService.createInlineImageAttachment>
  > extends ServiceResult<infer Value, CreateInlineImageAttachmentError>
    ? Value
    : never;

const ESTIMATED_MAX_INLINE_ATTACHMENT_REF = buildInlineAttachmentRef(
  "x".repeat(512)
);
