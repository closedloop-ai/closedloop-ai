import { SeedVersionMode } from "@repo/realtime-contract/doc-sync-internal";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;
const mockPublishVersionToLiveDocument = vi.hoisted(() => vi.fn());
const mockFindByIdSimple = vi.hoisted(() => vi.fn());
const mockGetLatest = vi.hoisted(() => vi.fn());
const mockCreateNewVersion = vi.hoisted(() => vi.fn());
const mockEmitDocumentVersionPublished = vi.hoisted(() => vi.fn());
const mockWithAnyAuthOptions = vi.hoisted(() => [] as unknown[]);

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    options?: unknown
  ) => {
    mockWithAnyAuthOptions.push(options);
    return (request: Request, context: { params: Promise<{ id: string }> }) =>
      handler(mockAuthContext, request, context.params);
  },
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveDocumentId: vi.fn(async (id: string) => id) };
});

vi.mock("@/app/documents/document-service", () => ({
  documentService: { findByIdSimple: mockFindByIdSimple },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getLatest: mockGetLatest,
    createNewVersion: mockCreateNewVersion,
  },
}));

vi.mock("@/app/doc-sync/internal/seed-state", () => ({
  publishVersionToLiveDocument: mockPublishVersionToLiveDocument,
}));

vi.mock("@/app/documents/version-published-signal", () => ({
  emitDocumentVersionPublished: mockEmitDocumentVersionPublished,
}));

const { POST } = await import("./route");

const DOCUMENT = { id: "doc-1", organizationId: "org-1", slug: "PRD-9" };

function reset() {
  return POST(
    createMockRequest({
      method: "POST",
      url: "http://localhost:3002/documents/doc-1/live-draft/reset",
    }),
    createMockRouteContext({ id: "doc-1" })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockFindByIdSimple.mockResolvedValue(DOCUMENT);
  mockGetLatest.mockResolvedValue({ version: 4, content: "# Latest" });
  mockPublishVersionToLiveDocument.mockResolvedValue({
    ok: true,
    value: { applied: true, stale: false, updateBytes: 9 },
  });
});

describe("POST /documents/:id/live-draft/reset", () => {
  it("requires the write scope", () => {
    expect(mockWithAnyAuthOptions).toContainEqual({
      requiredScopes: ["write"],
    });
  });

  it("seeds the latest version's content at its own version, with no new version and no signal", async () => {
    const response = await reset();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { applied: true, stale: false },
    });
    expect(mockFindByIdSimple).toHaveBeenCalledWith(
      "doc-1",
      mockAuthContext.user.organizationId
    );
    expect(mockPublishVersionToLiveDocument).toHaveBeenCalledWith({
      document: DOCUMENT,
      content: "# Latest",
      version: 4,
      mode: SeedVersionMode.Reset,
    });
    expect(mockCreateNewVersion).not.toHaveBeenCalled();
    expect(mockEmitDocumentVersionPublished).not.toHaveBeenCalled();
  });

  it("answers 404 and seeds nothing when the document lookup finds nothing", async () => {
    mockFindByIdSimple.mockResolvedValue(null);

    const response = await reset();

    expect(response.status).toBe(404);
    expect(mockPublishVersionToLiveDocument).not.toHaveBeenCalled();
  });

  it("answers 503 when the seed fails", async () => {
    mockPublishVersionToLiveDocument.mockResolvedValue({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 503,
    });

    const response = await reset();

    expect(response.status).toBe(503);
  });
});
