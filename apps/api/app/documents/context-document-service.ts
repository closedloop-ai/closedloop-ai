import { LinkType } from "@repo/api/src/types/artifact";
import { AttachmentPurpose } from "@repo/api/src/types/attachment";
import {
  type CreateDocumentInput,
  type Document,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import { artifactLinksService } from "@/app/artifact-links/service";
import { systemAuditActor } from "@/app/audit/audit-emit-service";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";
import {
  attachmentsService,
  requireAttachmentBucket,
  type SignedAttachmentUpload,
  signDocumentAttachmentUpload,
  storeDocumentAttachmentRow,
} from "./attachments-service";
import {
  createDocumentRecord,
  documentService,
  publishCreatedDocument,
} from "./document-service";

/** Why a context document was not stored; nothing it wrote survives. */
export const ContextDocumentErrorCode = {
  SigningFailed: "signing_failed",
  CreateFailed: "create_failed",
  LinkRejected: "link_rejected",
} as const;
export type ContextDocumentErrorCode =
  (typeof ContextDocumentErrorCode)[keyof typeof ContextDocumentErrorCode];

/** `cause` is the underlying failure, for the route's error log. */
export type ContextDocumentError = {
  code: ContextDocumentErrorCode;
  cause?: unknown;
};

/** What one context document's transaction wrote, for its receipts. */
export type ContextDocumentWrite = {
  documentId: string;
  linkId: string;
  attachmentId?: string;
};

export type ContextDocumentUpload = {
  artifactId: string;
  attachmentId: string;
  uploadUrl: string;
};

/**
 * ISS-12552: a context PRD that PRODUCES the document it was added to.
 *
 * Recorded (the caller hands a record): the PRD, its optional attachment row,
 * the link and the caller's receipts are written in ONE transaction, so a
 * failure at any step, a receipt included, leaves none of them behind and no
 * compensating delete is needed. Network work runs outside it: the upload is
 * signed before it opens, and the room and search projection are published
 * after it commits.
 *
 * Unrecorded (a session caller, or attribution evidence off): main's shape,
 * kept exactly for flag-off parity. The PRD is created and published first,
 * then the upload row and the link each commit on their own, and a failure
 * after the PRD exists deletes it again as the `system` actor.
 */
export const contextDocumentService = {
  /**
   * A PRD for an uploaded document file, with the attachment row the client
   * uploads into. The signed URL is returned only after the commit, so a
   * rolled-back write leaves no object to clean up.
   */
  createWithUpload(
    params: ContextDocumentUploadParams,
    recordWrite?: RecordWriteInTransaction<ContextDocumentWrite>
  ): Promise<Result<ContextDocumentUpload, ContextDocumentError>> {
    return writeInShape(recordWrite, {
      unrecorded: () => createWithUploadUnrecorded(params),
      recorded: (record) => createWithUploadRecorded(params, record),
    });
  },

  /** A PRD holding content the caller already fetched (a Google Doc). */
  createWithContent(
    params: ContextDocumentContentParams,
    recordWrite?: RecordWriteInTransaction<ContextDocumentWrite>
  ): Promise<Result<{ artifactId: string }, ContextDocumentError>> {
    return writeInShape(recordWrite, {
      unrecorded: () => createWithContentUnrecorded(params),
      recorded: (record) => createWithContentRecorded(params, record),
    });
  },
};

type ContextDocumentUploadParams = ContextDocumentParams & {
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

type ContextDocumentContentParams = ContextDocumentParams & {
  title: string;
  content: string;
  fileName: string;
};

async function createWithUploadRecorded(
  params: ContextDocumentUploadParams,
  recordWrite: RecordWriteInTransaction<ContextDocumentWrite>
): Promise<Result<ContextDocumentUpload, ContextDocumentError>> {
  // Chosen up front: the signed key names the PRD before it exists.
  const documentId = uuidv7();
  let bucket: string;
  let signed: SignedAttachmentUpload;
  try {
    bucket = requireAttachmentBucket();
    signed = await signDocumentAttachmentUpload({
      bucket,
      organizationId: params.organizationId,
      documentId,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
    });
  } catch (cause) {
    return Result.err({
      code: ContextDocumentErrorCode.SigningFailed,
      cause,
    });
  }
  const written = await writeContextDocument(
    params,
    { title: params.filename, content: "" },
    documentId,
    async () =>
      await storeDocumentAttachmentRow({
        documentId,
        bucket,
        key: signed.key,
        filename: params.filename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        userId: params.userId,
        purpose: AttachmentPurpose.Context,
      }),
    recordWrite
  );
  if (!written.ok) {
    return written;
  }
  const { attachmentId } = written.value;
  if (attachmentId === undefined) {
    throw new Error("Context upload committed without its attachment row");
  }
  return Result.ok({
    artifactId: written.value.documentId,
    attachmentId,
    uploadUrl: signed.uploadUrl,
  });
}

async function createWithContentRecorded(
  params: ContextDocumentContentParams,
  recordWrite: RecordWriteInTransaction<ContextDocumentWrite>
): Promise<Result<{ artifactId: string }, ContextDocumentError>> {
  const written = await writeContextDocument(
    params,
    {
      title: params.title,
      content: params.content,
      fileName: params.fileName,
    },
    undefined,
    undefined,
    recordWrite
  );
  if (!written.ok) {
    return written;
  }
  return Result.ok({ artifactId: written.value.documentId });
}

type ContextDocumentParams = {
  organizationId: string;
  userId: string;
  /** The document the new PRD is context for; the link's target. */
  sourceDocumentId: string;
  projectId: string;
};

/** Thrown inside the transaction only to roll it back. */
class ContextDocumentRollback extends Error {
  readonly failure: ContextDocumentError;
  constructor(failure: ContextDocumentError) {
    super(failure.code);
    this.failure = failure;
  }
}

async function writeContextDocument(
  params: ContextDocumentParams,
  fields: Pick<CreateDocumentInput, "title" | "content" | "fileName">,
  documentId: string | undefined,
  storeAttachment: (() => Promise<string>) | undefined,
  recordWrite: RecordWriteInTransaction<ContextDocumentWrite> | undefined
): Promise<Result<ContextDocumentWrite, ContextDocumentError>> {
  let committed: { document: Document; write: ContextDocumentWrite };
  try {
    committed = await withDb.tx(async (tx) => {
      const document = await createDocumentRecord(
        tx,
        params.organizationId,
        params.userId,
        {
          ...fields,
          type: DocumentType.Prd,
          status: DocumentStatus.Draft,
          projectId: params.projectId,
        },
        documentId
      );
      if (!document) {
        throw new ContextDocumentRollback({
          code: ContextDocumentErrorCode.CreateFailed,
        });
      }
      const attachmentId = await storeAttachment?.();
      // `createLink` joins this transaction. Its target is a document, never a
      // branch, so it derives nothing; and a link write inside a transaction
      // never evaluates the attribution flag (link-implementation-evidence.ts).
      const link = await artifactLinksService.createLink(
        params.organizationId,
        {
          sourceId: document.id,
          targetId: params.sourceDocumentId,
          linkType: LinkType.Produces,
        }
      );
      if (!link.ok) {
        throw new ContextDocumentRollback({
          code: ContextDocumentErrorCode.LinkRejected,
          cause: link.error,
        });
      }
      const write: ContextDocumentWrite = {
        documentId: document.id,
        linkId: link.value.id,
        ...(attachmentId === undefined ? {} : { attachmentId }),
      };
      await recordWrite?.(tx, write);
      return { document, write };
    });
  } catch (error) {
    if (error instanceof ContextDocumentRollback) {
      return Result.err(error.failure);
    }
    throw error;
  }
  await publishCreatedDocument(committed.document, fields.content ?? null);
  return Result.ok(committed.write);
}

/**
 * Main's upload sequence. Any failure to request the upload answers
 * `SigningFailed` ("Failed to request upload"), as main did for every throw
 * from `requestUpload`; a compensating delete that itself throws propagates.
 */
async function createWithUploadUnrecorded(
  params: ContextDocumentUploadParams
): Promise<Result<ContextDocumentUpload, ContextDocumentError>> {
  const artifact = await documentService.create(
    params.organizationId,
    params.userId,
    {
      title: params.filename,
      type: DocumentType.Prd,
      status: DocumentStatus.Draft,
      projectId: params.projectId,
      content: "",
    }
  );
  if (!artifact) {
    return Result.err({ code: ContextDocumentErrorCode.CreateFailed });
  }

  let upload: Awaited<ReturnType<typeof attachmentsService.requestUpload>>;
  try {
    upload = await attachmentsService.requestUpload(
      artifact.id,
      params.organizationId,
      params.userId,
      params.filename,
      params.mimeType,
      params.sizeBytes
    );
  } catch (cause) {
    await deleteContextDocument(artifact.id, params.organizationId);
    return Result.err({ code: ContextDocumentErrorCode.SigningFailed, cause });
  }

  try {
    const link = await linkContextDocument(params, artifact.id);
    if (!link.ok) {
      throw new Error(`Artifact link rejected with status ${link.error}`);
    }
  } catch (cause) {
    await deleteContextDocument(artifact.id, params.organizationId);
    return Result.err({ code: ContextDocumentErrorCode.LinkRejected, cause });
  }

  return Result.ok({
    artifactId: artifact.id,
    attachmentId: upload.attachmentId,
    uploadUrl: upload.uploadUrl,
  });
}

/**
 * Main's per-document Google Drive sequence. A rejected link answers
 * `LinkRejected` with the rejection status; a link that throws propagates
 * after the compensating delete, as on main.
 */
async function createWithContentUnrecorded(
  params: ContextDocumentContentParams
): Promise<Result<{ artifactId: string }, ContextDocumentError>> {
  const artifact = await documentService.create(
    params.organizationId,
    params.userId,
    {
      type: DocumentType.Prd,
      status: DocumentStatus.Draft,
      projectId: params.projectId,
      title: params.title,
      content: params.content,
      fileName: params.fileName,
    }
  );
  if (!artifact) {
    return Result.err({ code: ContextDocumentErrorCode.CreateFailed });
  }

  let link: Awaited<ReturnType<typeof linkContextDocument>>;
  try {
    link = await linkContextDocument(params, artifact.id);
  } catch (error) {
    await deleteContextDocument(artifact.id, params.organizationId);
    throw error;
  }
  if (!link.ok) {
    await deleteContextDocument(artifact.id, params.organizationId);
    return Result.err({
      code: ContextDocumentErrorCode.LinkRejected,
      cause: link.error,
    });
  }
  return Result.ok({ artifactId: artifact.id });
}

function linkContextDocument(
  params: ContextDocumentParams,
  artifactId: string
) {
  return artifactLinksService.createLink(params.organizationId, {
    sourceId: artifactId,
    targetId: params.sourceDocumentId,
    linkType: LinkType.Produces,
  });
}

/**
 * Compensating cleanup of a PRD this request just created, not a user
 * delete, so the ledger attributes it to `system`.
 */
function deleteContextDocument(
  artifactId: string,
  organizationId: string
): Promise<void> {
  return documentService.delete(artifactId, organizationId, systemAuditActor());
}
