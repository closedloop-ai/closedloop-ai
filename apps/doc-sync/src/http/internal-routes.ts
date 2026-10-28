import { internalBodyLimit } from "@repo/http-service/body-limit";
import { errorResponse, HttpServiceErrorCode } from "@repo/http-service/errors";
import { jsonBody } from "@repo/http-service/json-body";
import type { NodeBindings } from "@repo/http-service/node-listener";
import {
  commentAnchorRequestSchema,
  DocSyncDocumentCommand,
  DocSyncInternalErrorCode,
  listDocumentsQuerySchema,
  seedIfNeverStoredRequestSchema,
  seedVersionRequestSchema,
} from "@repo/realtime-contract/doc-sync-internal";
import { internalRevokeBodySchema } from "@repo/realtime-contract/internal";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { validator } from "hono/validator";
import { isCanonicalDocumentName } from "../auth/authorize";
import { CommandOutcome } from "../commands/document-commands";
import {
  commandLabel,
  type InternalCommandEnv,
  InternalCommandLabel,
} from "./command-outcome";
import type { DocSyncHttpDeps } from "./deps";

/** Realtime's value. Each command route applies it itself (PLN-2200 T-3.10). */
export const MAX_INTERNAL_BODY_BYTES = 16 * 1024;

/**
 * PLN-2190 GAP-001: covers the largest version the API stores, an
 * image-bearing version's ~3 MiB seed body and a content-only version inside
 * Vercel's 4.5 MB request limit, re-encoded with a constant envelope.
 */
export const SEED_VERSION_MAX_BODY_BYTES = 5 * 1024 * 1024;

type InternalEnv = { Bindings: NodeBindings } & InternalCommandEnv;

/**
 * The `/internal` routes, mounted behind the OIDC check and the rate limit.
 * Every route first names its command for the failure count
 * (`./command-outcome.ts`), then carries its own body cap, then, on a
 * per-document route, the canonical-name check; a deleted document answers
 * 410 to every per-document command but delete and disconnect.
 */
export function createInternalRoutes(deps: DocSyncHttpDeps): Hono<InternalEnv> {
  const routes = new Hono<InternalEnv>();
  const bodyCap = internalBodyLimit({ maxBytes: MAX_INTERNAL_BODY_BYTES });
  const documentPath = `${DOCUMENTS_PATH}/:documentName`;

  routes.get(
    DOCUMENTS_PATH,
    commandLabel(InternalCommandLabel.ListDocuments),
    bodyCap,
    validator("query", (query, c) => {
      const parsed = listDocumentsQuerySchema.safeParse(query);
      return parsed.success
        ? parsed.data
        : errorResponse(c, HTTP_BAD_REQUEST, HttpServiceErrorCode.InvalidBody);
    }),
    async (c) => {
      const { after, limit } = c.req.valid("query");
      return c.json(
        await deps.commands.listNames(after, limit),
        HTTP_OK,
        NO_STORE
      );
    }
  );

  routes.post(
    `${documentPath}/${DocSyncDocumentCommand.Clear}`,
    commandLabel(InternalCommandLabel.Clear),
    bodyCap,
    documentNameParam,
    async (c) => {
      const result = await deps.commands.clear(documentName(c));
      if (result.kind === CommandOutcome.Deleted) {
        return documentDeleted(c);
      }
      return c.json({ cleared: result.cleared }, HTTP_OK, NO_STORE);
    }
  );

  routes.post(
    `${documentPath}/${DocSyncDocumentCommand.CommentAnchors}`,
    commandLabel(InternalCommandLabel.CommentAnchor),
    bodyCap,
    documentNameParam,
    jsonBody(commentAnchorRequestSchema),
    async (c) => {
      const result = await deps.commands.addCommentAnchor(
        documentName(c),
        c.req.valid("json")
      );
      if (result.kind === CommandOutcome.Deleted) {
        return documentDeleted(c);
      }
      if (result.kind === CommandOutcome.AnchorRefused) {
        return c.json(
          { code: result.code, matchCount: result.matchCount },
          HTTP_UNPROCESSABLE,
          NO_STORE
        );
      }
      return c.json({ anchored: true }, HTTP_OK, NO_STORE);
    }
  );

  routes.post(
    `${documentPath}/${DocSyncDocumentCommand.SeedVersion}`,
    commandLabel(InternalCommandLabel.SeedVersion),
    internalBodyLimit({ maxBytes: SEED_VERSION_MAX_BODY_BYTES }),
    documentNameParam,
    jsonBody(seedVersionRequestSchema),
    async (c) => {
      const result = await deps.commands.seedVersion(
        documentName(c),
        c.req.valid("json")
      );
      if (result.kind === CommandOutcome.Deleted) {
        return documentDeleted(c);
      }
      if (result.kind === CommandOutcome.SeedFailed) {
        return errorResponse(
          c,
          HTTP_INTERNAL_SERVER_ERROR,
          HttpServiceErrorCode.Internal
        );
      }
      return c.json(
        {
          applied: result.applied,
          stale: result.stale,
          updateBytes: result.updateBytes,
        },
        HTTP_OK,
        NO_STORE
      );
    }
  );

  routes.get(
    `${documentPath}/${DocSyncDocumentCommand.FirstOpenSeed}`,
    commandLabel(InternalCommandLabel.FirstOpenSeed),
    bodyCap,
    documentNameParam,
    async (c) => {
      const result = await deps.commands.probeFirstOpenSeed(documentName(c));
      if (result.kind === CommandOutcome.Deleted) {
        return documentDeleted(c);
      }
      return c.json({ state: result.state }, HTTP_OK, NO_STORE);
    }
  );

  routes.post(
    `${documentPath}/${DocSyncDocumentCommand.SeedIfNeverStored}`,
    commandLabel(InternalCommandLabel.SeedIfNeverStored),
    internalBodyLimit({ maxBytes: SEED_VERSION_MAX_BODY_BYTES }),
    documentNameParam,
    jsonBody(seedIfNeverStoredRequestSchema),
    async (c) => {
      const result = await deps.commands.seedIfNeverStored(
        documentName(c),
        c.req.valid("json")
      );
      if (result.kind === CommandOutcome.Deleted) {
        return documentDeleted(c);
      }
      if (result.kind === CommandOutcome.SeedFailed) {
        return errorResponse(
          c,
          HTTP_INTERNAL_SERVER_ERROR,
          HttpServiceErrorCode.Internal
        );
      }
      return c.json(
        { applied: result.applied, updateBytes: result.updateBytes },
        HTTP_OK,
        NO_STORE
      );
    }
  );

  routes.get(
    `${documentPath}/${DocSyncDocumentCommand.Text}`,
    commandLabel(InternalCommandLabel.ReadText),
    bodyCap,
    documentNameParam,
    async (c) => {
      const result = await deps.commands.readText(documentName(c));
      if (result.kind === CommandOutcome.Deleted) {
        return documentDeleted(c);
      }
      if (result.kind === CommandOutcome.NotFound) {
        return errorResponse(c, HTTP_NOT_FOUND, HttpServiceErrorCode.NotFound);
      }
      return c.json({ text: result.text }, HTTP_OK, NO_STORE);
    }
  );

  routes.delete(
    documentPath,
    commandLabel(InternalCommandLabel.Delete),
    bodyCap,
    documentNameParam,
    async (c) => {
      const result = await deps.commands.deleteDocument(documentName(c));
      if (result.kind === CommandOutcome.UnloadTimeout) {
        return errorResponse(
          c,
          HTTP_SERVICE_UNAVAILABLE,
          DocSyncInternalErrorCode.UnloadTimeout
        );
      }
      return c.json(
        { deleted: result.deleted, wasLoaded: result.wasLoaded },
        HTTP_OK,
        NO_STORE
      );
    }
  );

  routes.post(
    REVOKE_PATH,
    commandLabel(InternalCommandLabel.Revoke),
    bodyCap,
    jsonBody(internalRevokeBodySchema),
    (c) => {
      const closedConnections = deps.connections.revoke(
        c.req.valid("json").target
      );
      return c.json({ closedConnections }, HTTP_OK, NO_STORE);
    }
  );

  // A tombstoned name has no connections, so it answers 0 rather than 410.
  routes.post(
    `${documentPath}/${DocSyncDocumentCommand.Disconnect}`,
    commandLabel(InternalCommandLabel.Disconnect),
    bodyCap,
    documentNameParam,
    (c) => {
      const closedConnections = deps.connections.disconnectDocument(
        documentName(c)
      );
      return c.json({ closedConnections }, HTTP_OK, NO_STORE);
    }
  );

  return routes;
}

const DOCUMENTS_PATH = "/documents";
/** `DOC_SYNC_REVOKE_PATH` under the `/internal` mount. */
const REVOKE_PATH = "/revoke";
const NO_STORE = { "cache-control": "no-store" };
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * Refuses any name but a canonical room id, 400. Hono percent-decodes a route
 * param, so a `%` anywhere in the raw path is refused first: the name a
 * command runs on is exactly the one the client sent.
 */
const documentNameParam: MiddlewareHandler<InternalEnv> = async (c, next) => {
  if (c.req.path.includes("%") || !isCanonicalDocumentName(documentName(c))) {
    return errorResponse(
      c,
      HTTP_BAD_REQUEST,
      DocSyncInternalErrorCode.InvalidDocumentName
    );
  }
  await next();
};

function documentName(c: Context<InternalEnv>): string {
  return c.req.param("documentName") ?? "";
}

function documentDeleted(c: Context<InternalEnv>): Response {
  return errorResponse(c, HTTP_GONE, DocSyncInternalErrorCode.DocumentDeleted);
}
