import { httpServiceErrorBodySchema } from "@repo/http-service/errors";
import {
  type ClosedConnectionsResponse,
  type CommentAnchorRequest,
  type CommentAnchorResponse,
  closedConnectionsResponseSchema,
  commentAnchorRefusalSchema,
  commentAnchorRequestSchema,
  commentAnchorResponseSchema,
  type DeleteResponse,
  DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
  DOC_SYNC_REVOKE_PATH,
  DocSyncDocumentCommand,
  DocSyncInternalErrorCode,
  deleteResponseSchema,
  docSyncDocumentPath,
  type FirstOpenSeedProbeResponse,
  firstOpenSeedProbeResponseSchema,
  type ListDocumentsResponse,
  listDocumentsResponseSchema,
  type PlaceCommentAnchorsRequest,
  type PlaceCommentAnchorsResponse,
  placeCommentAnchorsRequestSchema,
  placeCommentAnchorsResponseSchema,
  type ReadCommentAnchorsResponse,
  type ReadTextResponse,
  type RemoveCommentAnchorsRequest,
  type RemoveCommentAnchorsResponse,
  type RenameCommentAnchorsRequest,
  type RenameCommentAnchorsResponse,
  readCommentAnchorsResponseSchema,
  readTextResponseSchema,
  removeCommentAnchorsRequestSchema,
  removeCommentAnchorsResponseSchema,
  renameCommentAnchorsRequestSchema,
  renameCommentAnchorsResponseSchema,
  type SeedIfNeverStoredRequest,
  type SeedIfNeverStoredResponse,
  type SeedVersionRequest,
  type SeedVersionResponse,
  seedIfNeverStoredRequestSchema,
  seedIfNeverStoredResponseSchema,
  seedVersionRequestSchema,
  seedVersionResponseSchema,
} from "@repo/realtime-contract/doc-sync-internal";
import {
  internalRevokeBodySchema,
  type RevokeTarget,
} from "@repo/realtime-contract/internal";
import {
  createInternalServiceCaller,
  type InternalCallFailed,
  InternalCallFailure,
  type InternalCallMethod,
  type InternalServiceConfig,
  parseInternalServiceConfig,
} from "@repo/realtime-server/internal-call";
import type { z } from "zod";
import { env } from "@/env";

export type DocSyncCallFailure = {
  ok: false;
  failure: InternalCallFailure;
  status?: number;
  /** The refusal body's `code`, or {@link DocSyncClientErrorCode.InvalidResponse}. */
  code?: string;
  /** On a 422 comment-anchor refusal: how many times the anchor text matched. */
  matchCount?: number;
};

export type DocSyncCallResult<T> = { ok: true; value: T } | DocSyncCallFailure;

export const DocSyncClientErrorCode = {
  /** A 2xx whose body the contract's response schema refuses. */
  InvalidResponse: "invalid_response",
} as const;
export type DocSyncClientErrorCode =
  (typeof DocSyncClientErrorCode)[keyof typeof DocSyncClientErrorCode];

export type DocSyncInternalClient = {
  addCommentAnchor(
    documentName: string,
    request: CommentAnchorRequest
  ): Promise<DocSyncCallResult<CommentAnchorResponse>>;
  /** PLN-2187 T-3.3: every comment mark in the document, with its selector. */
  readCommentAnchors(
    documentName: string
  ): Promise<DocSyncCallResult<ReadCommentAnchorsResponse>>;
  placeCommentAnchors(
    documentName: string,
    request: PlaceCommentAnchorsRequest
  ): Promise<DocSyncCallResult<PlaceCommentAnchorsResponse>>;
  renameCommentAnchors(
    documentName: string,
    request: RenameCommentAnchorsRequest
  ): Promise<DocSyncCallResult<RenameCommentAnchorsResponse>>;
  removeCommentAnchors(
    documentName: string,
    request: RemoveCommentAnchorsRequest
  ): Promise<DocSyncCallResult<RemoveCommentAnchorsResponse>>;
  readText(documentName: string): Promise<DocSyncCallResult<ReadTextResponse>>;
  /** One attempt; the caller decides whether a failure is worth a retry. */
  seedVersion(
    documentName: string,
    request: SeedVersionRequest
  ): Promise<DocSyncCallResult<SeedVersionResponse>>;
  /** ISS-12508's first-open probe, carrying only the room: one attempt within `timeoutMs`. */
  probeFirstOpenSeed(
    documentName: string,
    options: { timeoutMs: number }
  ): Promise<DocSyncCallResult<FirstOpenSeedProbeResponse>>;
  /** ISS-12508's first-open apply: one attempt within `timeoutMs`. */
  seedIfNeverStored(
    documentName: string,
    request: SeedIfNeverStoredRequest,
    options: { timeoutMs: number }
  ): Promise<DocSyncCallResult<SeedIfNeverStoredResponse>>;
  /**
   * Retries once on a 503 `unload_timeout`: the name stays tombstoned and the
   * row kept, so the delete is retried and never rolled back
   * ({@link DocSyncInternalErrorCode.UnloadTimeout}).
   */
  deleteDocument(
    documentName: string
  ): Promise<DocSyncCallResult<DeleteResponse>>;
  listDocuments(page: {
    after?: string;
    limit: number;
  }): Promise<DocSyncCallResult<ListDocumentsResponse>>;
  /** Closes `target`'s connections and refuses the tokens issued at or before it (PLN-2201 T-7.1). */
  revoke(
    target: RevokeTarget
  ): Promise<DocSyncCallResult<ClosedConnectionsResponse>>;
};

export type DocSyncInternalClientOptions = {
  config: InternalServiceConfig | undefined;
  fetch?: typeof fetch;
  /**
   * Every command but delete, which keeps {@link DOC_SYNC_DELETE_TIMEOUT_MS},
   * and the comment-anchor reads and batches, which keep
   * `commentAnchorTimeoutMs`.
   */
  timeoutMs?: number;
  /** Defaults to {@link DOC_SYNC_COMMENT_ANCHOR_TIMEOUT_MS}. */
  commentAnchorTimeoutMs?: number;
};

/**
 * PLN-2200 T-5.2: the API's client for doc-sync's `/internal/documents/*`
 * commands and `/internal/revoke`. No method throws; each resolves a
 * {@link DocSyncCallResult}. A failure logs
 * {@link DOC_SYNC_INTERNAL_CALL_FAILED_EVENT}, and an unconfigured client logs
 * {@link DOC_SYNC_INTERNAL_NOT_CONFIGURED_EVENT} once.
 */
export function createDocSyncInternalClient(
  options: DocSyncInternalClientOptions
): DocSyncInternalClient {
  const timeoutMs = options.timeoutMs ?? DOC_SYNC_INTERNAL_CALL_TIMEOUT_MS;
  const commentAnchorTimeoutMs =
    options.commentAnchorTimeoutMs ?? DOC_SYNC_COMMENT_ANCHOR_TIMEOUT_MS;
  const caller = createInternalServiceCaller({
    config: options.config,
    fetch: options.fetch,
    events: {
      failed: {
        event: DOC_SYNC_INTERNAL_CALL_FAILED_EVENT,
        message: "Doc-sync internal call failed",
      },
      notConfigured: {
        event: DOC_SYNC_INTERNAL_NOT_CONFIGURED_EVENT,
        message: "Doc-sync internal calls are not configured",
      },
    },
  });

  const call = async <T>(
    request: {
      method: InternalCallMethod;
      path: string;
      query?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    },
    schema: z.ZodType<T>
  ): Promise<DocSyncCallResult<T>> => {
    const response = await caller.call({
      ...request,
      timeoutMs: request.timeoutMs ?? timeoutMs,
    });
    if (!response.ok) {
      return refusal(response);
    }
    const parsed = schema.safeParse(response.body);
    if (parsed.success) {
      return { ok: true, value: parsed.data };
    }
    caller.fail(request.path, InternalCallFailure.Rejected, response.status);
    return {
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: response.status,
      code: DocSyncClientErrorCode.InvalidResponse,
    };
  };

  const invalid = (path: string): DocSyncCallFailure =>
    caller.fail(path, InternalCallFailure.Invalid);

  const deleteOnce = (path: string) =>
    call(
      { method: "DELETE", path, timeoutMs: DOC_SYNC_DELETE_TIMEOUT_MS },
      deleteResponseSchema
    );

  /** A comment-anchor batch: refused with no request when the name or the body is invalid. */
  const postCommentAnchors = <Req, Res>(
    documentName: string,
    command: DocSyncDocumentCommand,
    request: Req,
    requestSchema: z.ZodType<Req>,
    responseSchema: z.ZodType<Res>
  ): Promise<DocSyncCallResult<Res>> => {
    const path = docSyncDocumentPath(documentName, command);
    if (path === undefined) {
      return Promise.resolve(invalid(documentPathTemplate(command)));
    }
    const body = requestSchema.safeParse(request);
    if (!body.success) {
      return Promise.resolve(invalid(path));
    }
    return call(
      {
        method: "POST",
        path,
        body: body.data,
        timeoutMs: commentAnchorTimeoutMs,
      },
      responseSchema
    );
  };

  return {
    addCommentAnchor(documentName, request) {
      const path = docSyncDocumentPath(
        documentName,
        DocSyncDocumentCommand.CommentAnchors
      );
      if (path === undefined) {
        return Promise.resolve(
          invalid(documentPathTemplate(DocSyncDocumentCommand.CommentAnchors))
        );
      }
      const body = commentAnchorRequestSchema.safeParse(request);
      if (!body.success) {
        return Promise.resolve(invalid(path));
      }
      return call(
        { method: "POST", path, body: body.data },
        commentAnchorResponseSchema
      );
    },
    readCommentAnchors(documentName) {
      const path = docSyncDocumentPath(
        documentName,
        DocSyncDocumentCommand.CommentAnchors
      );
      if (path === undefined) {
        return Promise.resolve(
          invalid(documentPathTemplate(DocSyncDocumentCommand.CommentAnchors))
        );
      }
      return call(
        { method: "GET", path, timeoutMs: commentAnchorTimeoutMs },
        readCommentAnchorsResponseSchema
      );
    },
    placeCommentAnchors(documentName, request) {
      return postCommentAnchors(
        documentName,
        DocSyncDocumentCommand.CommentAnchorsPlace,
        request,
        placeCommentAnchorsRequestSchema,
        placeCommentAnchorsResponseSchema
      );
    },
    renameCommentAnchors(documentName, request) {
      return postCommentAnchors(
        documentName,
        DocSyncDocumentCommand.CommentAnchorsRename,
        request,
        renameCommentAnchorsRequestSchema,
        renameCommentAnchorsResponseSchema
      );
    },
    removeCommentAnchors(documentName, request) {
      return postCommentAnchors(
        documentName,
        DocSyncDocumentCommand.CommentAnchorsRemove,
        request,
        removeCommentAnchorsRequestSchema,
        removeCommentAnchorsResponseSchema
      );
    },
    readText(documentName) {
      const path = docSyncDocumentPath(
        documentName,
        DocSyncDocumentCommand.Text
      );
      if (path === undefined) {
        return Promise.resolve(
          invalid(documentPathTemplate(DocSyncDocumentCommand.Text))
        );
      }
      return call({ method: "GET", path }, readTextResponseSchema);
    },
    seedVersion(documentName, request) {
      const path = docSyncDocumentPath(
        documentName,
        DocSyncDocumentCommand.SeedVersion
      );
      if (path === undefined) {
        return Promise.resolve(
          invalid(documentPathTemplate(DocSyncDocumentCommand.SeedVersion))
        );
      }
      const body = seedVersionRequestSchema.safeParse(request);
      if (!body.success) {
        return Promise.resolve(invalid(path));
      }
      return call(
        { method: "POST", path, body: body.data },
        seedVersionResponseSchema
      );
    },
    probeFirstOpenSeed(documentName, { timeoutMs: callTimeoutMs }) {
      const path = docSyncDocumentPath(
        documentName,
        DocSyncDocumentCommand.FirstOpenSeed
      );
      if (path === undefined) {
        return Promise.resolve(
          invalid(documentPathTemplate(DocSyncDocumentCommand.FirstOpenSeed))
        );
      }
      return call(
        { method: "GET", path, timeoutMs: callTimeoutMs },
        firstOpenSeedProbeResponseSchema
      );
    },
    seedIfNeverStored(documentName, request, { timeoutMs: callTimeoutMs }) {
      const path = docSyncDocumentPath(
        documentName,
        DocSyncDocumentCommand.SeedIfNeverStored
      );
      if (path === undefined) {
        return Promise.resolve(
          invalid(
            documentPathTemplate(DocSyncDocumentCommand.SeedIfNeverStored)
          )
        );
      }
      const body = seedIfNeverStoredRequestSchema.safeParse(request);
      if (!body.success) {
        return Promise.resolve(invalid(path));
      }
      return call(
        { method: "POST", path, body: body.data, timeoutMs: callTimeoutMs },
        seedIfNeverStoredResponseSchema
      );
    },
    async deleteDocument(documentName) {
      const path = docSyncDocumentPath(documentName);
      if (path === undefined) {
        return invalid(documentPathTemplate());
      }
      let result = await deleteOnce(path);
      for (
        let attempt = 1;
        attempt < DOC_SYNC_DELETE_ATTEMPTS && isUnloadTimeout(result);
        attempt++
      ) {
        await delay(DOC_SYNC_DELETE_RETRY_DELAY_MS);
        result = await deleteOnce(path);
      }
      return result;
    },
    listDocuments({ after, limit }) {
      const query: Record<string, string> = { limit: String(limit) };
      if (after !== undefined) {
        query.after = after;
      }
      return call(
        { method: "GET", path: DOC_SYNC_INTERNAL_DOCUMENTS_PATH, query },
        listDocumentsResponseSchema
      );
    },
    revoke(target) {
      const body = internalRevokeBodySchema.safeParse({ target });
      if (!body.success) {
        return Promise.resolve(invalid(DOC_SYNC_REVOKE_PATH));
      }
      return call(
        { method: "POST", path: DOC_SYNC_REVOKE_PATH, body: body.data },
        closedConnectionsResponseSchema
      );
    },
  };
}

/**
 * The client for this process, built once from `DOC_SYNC_INTERNAL_URL` and
 * `DOC_SYNC_INTERNAL_OIDC_AUDIENCE`. Either unset makes every call
 * `not_configured`, with no request.
 */
export function docSyncInternalClient(): DocSyncInternalClient {
  cachedClient ??= createDocSyncInternalClient({
    config: parseInternalServiceConfig({
      internalUrl: env.DOC_SYNC_INTERNAL_URL,
      oidcAudience: env.DOC_SYNC_INTERNAL_OIDC_AUDIENCE,
    }),
  });
  return cachedClient;
}

let cachedClient: DocSyncInternalClient | undefined;

/**
 * A refusal's status, the `code` of its body, and a comment-anchor refusal's
 * `matchCount`, each only when the service sent it. A 400 from the list route
 * carries the generic `invalid_body`, so callers branch on the status there.
 */
function refusal(response: InternalCallFailed): DocSyncCallFailure {
  const result: DocSyncCallFailure = { ok: false, failure: response.failure };
  if (response.status !== undefined) {
    result.status = response.status;
  }
  const body = httpServiceErrorBodySchema.safeParse(response.body);
  if (body.success) {
    result.code = body.data.code;
  }
  const anchorRefusal = commentAnchorRefusalSchema.safeParse(response.body);
  if (anchorRefusal.success) {
    result.matchCount = anchorRefusal.data.matchCount;
  }
  return result;
}

function isUnloadTimeout<T>(result: DocSyncCallResult<T>): boolean {
  return (
    !result.ok &&
    result.status === HTTP_SERVICE_UNAVAILABLE &&
    result.code === DocSyncInternalErrorCode.UnloadTimeout
  );
}

/** The route a refused call names in its failure log when the name itself is unaddressable. */
function documentPathTemplate(command?: DocSyncDocumentCommand): string {
  const template = `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/:documentName`;
  return command === undefined ? template : `${template}/${command}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HTTP_SERVICE_UNAVAILABLE = 503;

/** Every command but delete. */
export const DOC_SYNC_INTERNAL_CALL_TIMEOUT_MS = 5000;
/** Above the service's 5 s unload deadline, so its 503 arrives before this client gives up. */
export const DOC_SYNC_DELETE_TIMEOUT_MS = 8000;
/** The first try plus one retry of a 503 `unload_timeout`; the daily sweep retries what is left. */
export const DOC_SYNC_DELETE_ATTEMPTS = 2;
/** Gives a connection the service just closed time to detach before the retry, which would otherwise hit the same unload. */
export const DOC_SYNC_DELETE_RETRY_DELAY_MS = 1000;

/** PLN-2187 T-3.3: the comment-anchor reads and batches, which walk or rewrite the whole document. */
export const DOC_SYNC_COMMENT_ANCHOR_TIMEOUT_MS = 10_000;

export const DOC_SYNC_INTERNAL_CALL_FAILED_EVENT =
  "doc_sync.internal_call_failed";
export const DOC_SYNC_INTERNAL_NOT_CONFIGURED_EVENT =
  "doc_sync.internal_not_configured";
