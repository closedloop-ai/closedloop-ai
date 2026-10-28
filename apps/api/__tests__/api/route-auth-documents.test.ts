/**
 * ISS-11409: the document routes Daveth moved from `withAuth` to `withAnyAuth`.
 * `POST /documents/merge` went back to session-only under ISS-11795 and is
 * pinned in `route-auth-session-only.test.ts`.
 *
 * Runs the REAL auth wrappers; only the identity primitives underneath them
 * are replaced (see `route-auth-callers.test-helpers`). Each handler's first
 * org-scoped dependency is spied on, so a case proves the handler ran on
 * behalf of the caller the wrapper resolved, not merely that it answered.
 */
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import {
  BatchQuerySelectionErrorCode,
  batchQuerySelectionError,
} from "@repo/api/src/types/batch-query-selection";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, vi } from "vitest";
import {
  installCallerIdentities,
  itAuthenticatesMovedHandler,
  probe,
  type RouteHandler,
} from "@/__tests__/support/auth/route-auth-callers.test-helpers";

const identifierMocks = vi.hoisted(() => ({
  resolveDocumentId: vi.fn(),
  resolveBatchSelection: vi.fn(),
}));

vi.mock("@repo/auth/server", async () =>
  (
    await import("@/__tests__/support/auth/route-auth-primitives.test-mocks")
  ).routeAuthModuleMocks.clerkServer()
);
vi.mock("@/lib/auth/find-or-create-user", async () =>
  (
    await import("@/__tests__/support/auth/route-auth-primitives.test-mocks")
  ).routeAuthModuleMocks.findOrCreateUser()
);
vi.mock("@/lib/auth/desktop-session-auth", async () =>
  (
    await import("@/__tests__/support/auth/route-auth-primitives.test-mocks")
  ).routeAuthModuleMocks.desktopSessionAuth()
);
vi.mock("@/lib/auth/desktop-managed-pop", async (importOriginal) =>
  (
    await import("@/__tests__/support/auth/route-auth-primitives.test-mocks")
  ).routeAuthModuleMocks.desktopManagedPop(importOriginal)
);
vi.mock("@vercel/functions", async (importOriginal) =>
  (
    await import("@/__tests__/support/auth/route-auth-primitives.test-mocks")
  ).routeAuthModuleMocks.vercelFunctions(importOriginal)
);
vi.mock("@/lib/identifier-utils", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDocumentId: identifierMocks.resolveDocumentId,
}));
vi.mock("@/app/documents/batch-selection-resolver", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveBatchSelection: identifierMocks.resolveBatchSelection,
}));

import { deploymentService } from "@/app/deployments/deployment-service";
import { GET as getPreviewDeployment } from "@/app/documents/[id]/preview-deployment/route";
import {
  GET as getRating,
  PUT as putRating,
} from "@/app/documents/[id]/rating/route";
import { GET as getBatchMeta } from "@/app/documents/batch-meta/route";
import { POST as postBatchMoveV2 } from "@/app/documents/batch-move/v2/route";
import { batchSelectionErrorResponse } from "@/app/documents/batch-selection-resolver";
import { GET as getBySlug } from "@/app/documents/by-slug/[slug]/route";
import { documentService } from "@/app/documents/document-service";
import { documentEvaluationService } from "@/app/documents/evaluation-service";
import { notFoundResponse, successResponse } from "@/lib/route-utils";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const SLUG = "PRD-42";
const META = { [SLUG]: { title: "Plan the thing" } };
const RATING = { average: 4, count: 1, userRating: null };
const SELECTION_ERROR = batchQuerySelectionError(
  BatchQuerySelectionErrorCode.SelectionEmpty,
  { resolvedTotal: 0 }
);

function asHandler(handler: unknown): RouteHandler {
  return handler as RouteHandler;
}

describe("ISS-11409 document routes moved to withAnyAuth", () => {
  beforeEach(() => {
    installCallerIdentities();
    identifierMocks.resolveDocumentId.mockResolvedValue(DOCUMENT_ID);
    identifierMocks.resolveBatchSelection.mockResolvedValue(
      Result.err(SELECTION_ERROR)
    );
    vi.spyOn(documentService, "findBySlug").mockResolvedValue(null);
    vi.spyOn(documentService, "batchFetchDocumentMeta").mockResolvedValue(
      META as never
    );
    vi.spyOn(
      deploymentService,
      "findLatestPreviewForDocument"
    ).mockResolvedValue(null);
    vi.spyOn(documentEvaluationService, "getRating").mockResolvedValue(
      RATING as never
    );
    vi.spyOn(documentEvaluationService, "upsertRating").mockResolvedValue(
      Result.ok(RATING) as never
    );
  });

  itAuthenticatesMovedHandler({
    name: "GET /documents/by-slug/[slug]",
    handler: asHandler(getBySlug),
    request: { method: "GET", path: `/documents/by-slug/${SLUG}` },
    params: () => ({ slug: SLUG }),
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: () => notFoundResponse("Artifact"),
    ranAs: (identity) => [
      probe(documentService.findBySlug, SLUG, identity.organizationId),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "GET /documents/batch-meta",
    handler: asHandler(getBatchMeta),
    request: { method: "GET", path: `/documents/batch-meta?slugs=${SLUG}` },
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: () => successResponse(META),
    ranAs: (identity) => [
      probe(documentService.batchFetchDocumentMeta, identity.organizationId, [
        SLUG,
      ]),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "GET /documents/[id]/preview-deployment",
    handler: asHandler(getPreviewDeployment),
    request: {
      method: "GET",
      path: `/documents/${DOCUMENT_ID}/preview-deployment`,
    },
    params: () => ({ id: DOCUMENT_ID }),
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: () => successResponse(null),
    ranAs: (identity) => [
      probe(
        identifierMocks.resolveDocumentId,
        DOCUMENT_ID,
        identity.organizationId
      ),
      probe(
        deploymentService.findLatestPreviewForDocument,
        DOCUMENT_ID,
        identity.organizationId
      ),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "GET /documents/[id]/rating",
    handler: asHandler(getRating),
    request: { method: "GET", path: `/documents/${DOCUMENT_ID}/rating` },
    params: () => ({ id: DOCUMENT_ID }),
    requiredScopes: [ApiKeyScope.Read],
    reachedResponse: () => successResponse(RATING),
    ranAs: (identity) => [
      probe(
        documentEvaluationService.getRating,
        DOCUMENT_ID,
        identity.userId,
        identity.organizationId
      ),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "PUT /documents/[id]/rating",
    handler: asHandler(putRating),
    request: {
      method: "PUT",
      path: `/documents/${DOCUMENT_ID}/rating`,
      body: { score: 4 },
    },
    params: () => ({ id: DOCUMENT_ID }),
    requiredScopes: [ApiKeyScope.Write],
    reachedResponse: () => successResponse(RATING),
    ranAs: (identity) => [
      probe(
        documentEvaluationService.upsertRating,
        DOCUMENT_ID,
        identity.userId,
        identity.organizationId,
        4,
        undefined,
        undefined
      ),
    ],
  });

  itAuthenticatesMovedHandler({
    name: "POST /documents/batch-move/v2",
    handler: asHandler(postBatchMoveV2),
    request: {
      method: "POST",
      path: "/documents/batch-move/v2",
      body: { documentIds: [DOCUMENT_ID], targetProjectId: TARGET_PROJECT_ID },
    },
    requiredScopes: [
      ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeProject],
    ],
    reachedResponse: () => batchSelectionErrorResponse(SELECTION_ERROR),
    ranAs: (identity) => [
      probe(
        identifierMocks.resolveBatchSelection,
        expect.objectContaining({ documentIds: [DOCUMENT_ID] }),
        identity.organizationId
      ),
    ],
  });
});
