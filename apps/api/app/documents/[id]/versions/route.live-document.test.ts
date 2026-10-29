/**
 * PLN-2190 T-4.3: every publish path runs the real `resetDocumentRoom`, which
 * seeds the doc-sync document and then signals, below the route. Only the
 * transports at its edges (Liveblocks, the doc-sync client, `emitSignal`) are
 * mocked.
 */
import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { ChannelKind } from "@repo/realtime-contract/channels";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { DocumentVersionSignalType } from "@repo/realtime-contract/signals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;
const mockCreateNewVersion = vi.hoisted(() => vi.fn());
const mockCreateNewVersionWithInlineImages = vi.hoisted(() => vi.fn());
const mockSeedVersion = vi.hoisted(() => vi.fn());
const mockEmitSignal = vi.hoisted(() => vi.fn());

// ISS-12552: these cases record no operation receipt.
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => false),
}));
vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), flush: vi.fn(async () => undefined), info: vi.fn() },
}));

vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: { params: Promise<{ id: string }> }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveDocumentId: vi.fn(async (id: string) => id) };
});

vi.mock("../../document-version-service", () => ({
  documentVersionService: {
    createNewVersion: mockCreateNewVersion,
    createNewVersionWithInlineImages: mockCreateNewVersionWithInlineImages,
    listVersions: vi.fn(),
  },
}));

vi.mock("@/lib/liveblocks", () => ({
  resetLiveblocksRoom: vi.fn(async () => ({ success: true })),
  updateLiveblocksRoomMetadata: vi.fn(async () => ({ success: true })),
  broadcastLiveblocksRoomEvent: vi.fn(async () => ({ success: true })),
  createLiveblocksRoom: vi.fn(),
  deleteLiveblocksRoom: vi.fn(),
}));

vi.mock("@/app/doc-sync/internal/internal-client", () => ({
  docSyncInternalClient: () => ({ seedVersion: mockSeedVersion }),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) => fn({}),
}));

vi.mock("@repo/realtime-server/emit-signal", () => ({
  emitSignal: mockEmitSignal,
}));

const { POST } = await import("./route");

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DOCUMENT_ID = "01a140d8-7298-7688-8841-0a3cc7d38719";
const STORED_CONTENT = "# Stored\n\nsanitized body";

function publishedDocument(): DocumentDetail {
  return {
    id: DOCUMENT_ID,
    organizationId: ORG_ID,
    slug: "PLN-7",
    type: DocumentType.ImplementationPlan,
    latestVersion: 5,
    latestVersionContent: STORED_CONTENT,
  } as DocumentDetail;
}

function publish(query: string) {
  return POST(
    createMockRequest({
      body: { content: "request body" },
      method: "POST",
      url: `http://localhost:3002/documents/${DOCUMENT_ID}/versions${query}`,
    }),
    createMockRouteContext({ id: DOCUMENT_ID })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockCreateNewVersion.mockResolvedValue(publishedDocument());
  mockSeedVersion.mockResolvedValue({
    ok: true,
    value: { applied: true, stale: false, updateBytes: 40 },
  });
  mockEmitSignal.mockResolvedValue(undefined);
});

describe("POST /documents/:id/versions, live document", () => {
  it("an API-key publish with no reset-room parameter (agent, MCP) seeds and signals", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["write"],
      authMethod: "api_key",
    });

    const response = await publish("");

    expect(response.status).toBe(200);
    expect(mockSeedVersion).toHaveBeenCalledWith(
      generateDocumentRoomId(ORG_ID, "PLN-7"),
      { markdown: STORED_CONTENT, version: 5 }
    );
    expect(mockEmitSignal).toHaveBeenCalledWith(
      expect.anything(),
      `${ChannelKind.DocumentVersions}:${ORG_ID}:${DOCUMENT_ID}`,
      { type: DocumentVersionSignalType.Published, data: { version: 5 } }
    );
  });

  it("an inline-image publish seeds the stored content, not the pre-sanitization body", async () => {
    mockCreateNewVersionWithInlineImages.mockResolvedValue({
      ok: true,
      value: {
        document: publishedDocument(),
        inlineImages: [],
        versionContent: "expanded body before sanitization",
      },
    });

    const response = await POST(
      createMockRequest({
        body: {
          content: "body [[diagram]]",
          inlineImages: [
            {
              altText: "Diagram",
              dataBase64: "aW1hZ2U=",
              filename: "diagram.png",
              mimeType: "image/png",
              placeholder: "[[diagram]]",
            },
          ],
        },
        method: "POST",
        url: `http://localhost:3002/documents/${DOCUMENT_ID}/versions`,
      }),
      createMockRouteContext({ id: DOCUMENT_ID })
    );

    expect(response.status).toBe(200);
    expect(mockCreateNewVersionWithInlineImages).toHaveBeenCalled();
    expect(mockSeedVersion).toHaveBeenCalledWith(
      generateDocumentRoomId(ORG_ID, "PLN-7"),
      { markdown: STORED_CONTENT, version: 5 }
    );
  });

  it("reset-room=false (Save Version) neither seeds nor signals", async () => {
    const response = await publish("?reset-room=false");

    expect(response.status).toBe(200);
    expect(mockSeedVersion).not.toHaveBeenCalled();
    expect(mockEmitSignal).not.toHaveBeenCalled();
  });
});
