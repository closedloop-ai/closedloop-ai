import { exportDocAsMarkdown, getDocName } from "@repo/google";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/documents/[id]/context-attachments/gdrive/route";
import { documentService } from "@/app/documents/document-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

// ---------------------------------------------------------------------------
// The gdrive context-attachment route is the sibling of
// `googleService.importDocs`: same `getDocName` / `exportDocAsMarkdown` /
// `documentService.create` failure modes, but its per-doc failure text goes
// into the RESPONSE BODY rather than the log drain. googleapis quotes the
// offending credential bare in its error text, so returning `error.message`
// verbatim ships a live `ya29.` access token to the browser.
//
// These tests drive the real route with a failing googleapis call and assert
// the token never reaches the response. They go RED if the catch block returns
// `error.message` instead of routing through `sanitizeErrorForClient`.
// ---------------------------------------------------------------------------

const LIVE_ACCESS_TOKEN = "ya29.a0AfB_bZlFAKEtokenVALUE1234567890abcdefXYZ";
const PROJECT_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...handlerArgs: unknown[]) => unknown) =>
    (request: { params?: unknown }, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@/lib/identifier-utils", () => ({
  resolveDocumentId: vi.fn((id: string) => Promise.resolve(id)),
}));

vi.mock("@repo/google", () => ({
  getDocName: vi.fn(),
  exportDocAsMarkdown: vi.fn(),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    findById: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: {
    createLink: vi.fn(),
  },
}));

// Keep the REAL `sanitizeErrorForClient` — it is the unit under test here.
// Only the integration/token lookups are stubbed.
vi.mock("@/app/integrations/google/service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/integrations/google/service")>();
  return {
    ...actual,
    googleService: { getIntegration: vi.fn() },
    ensureValidAccessToken: vi.fn(),
  };
});

const { ensureValidAccessToken, googleService, MAX_CONTENT_BYTES } =
  await import("@/app/integrations/google/service");

type GdriveImportOutcome = {
  status: number;
  json: Record<string, unknown>;
  /** The serialized response body, for "must not contain" credential checks. */
  body: string;
};

async function postGdriveImport(
  docIds: string[] = ["doc-1"]
): Promise<GdriveImportOutcome> {
  const response = await POST(
    createMockRequest({
      method: "POST",
      url: "http://localhost:3002/api/artifacts/artifact-1/context-attachments/gdrive",
      body: { docIds, projectId: PROJECT_ID },
    }),
    createMockRouteContext({ id: "artifact-1" })
  );
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json, body: JSON.stringify(json) };
}

describe("POST /documents/:id/context-attachments/gdrive — client error sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(documentService.findById).mockResolvedValue({
      id: "artifact-1",
      projectId: "project-1",
    } as never);
    vi.mocked(googleService.getIntegration).mockResolvedValue({
      id: "integration-1",
    } as never);
    vi.mocked(ensureValidAccessToken).mockResolvedValue({
      success: true,
      accessToken: LIVE_ACCESS_TOKEN,
    } as never);
  });

  it("never returns the raw googleapis message when it quotes a live ya29. token", async () => {
    // googleapis echoes the credential it was called with into the error text.
    vi.mocked(getDocName).mockRejectedValue(
      new Error(
        `Request failed with status code 403: invalid authentication credential Authorization: ${LIVE_ACCESS_TOKEN}`
      )
    );
    vi.mocked(exportDocAsMarkdown).mockRejectedValue(
      new Error("Request failed with status code 403")
    );

    const { status, json, body } = await postGdriveImport();

    expect(status).toBe(200);
    expect(body).not.toContain(LIVE_ACCESS_TOKEN);
    expect(body).not.toContain("ya29.");
    expect(body).not.toContain("invalid authentication credential");
    // 403 maps to the canned permission message, not the raw text.
    expect(json.data).toEqual({
      results: [
        {
          docId: "doc-1",
          error: "Unable to access document (permission denied)",
        },
      ],
    });
  });

  it("falls back to the generic message for an unclassified failure, dropping its text", async () => {
    vi.mocked(getDocName).mockResolvedValue("Quarterly Plan" as never);
    vi.mocked(exportDocAsMarkdown).mockRejectedValue(
      new Error(`socket hang up while bearing token ${LIVE_ACCESS_TOKEN}`)
    );

    const { status, json, body } = await postGdriveImport();

    expect(status).toBe(200);
    expect(body).not.toContain(LIVE_ACCESS_TOKEN);
    expect(body).not.toContain("socket hang up");
    expect(json.data).toEqual({
      results: [{ docId: "doc-1", error: "Failed to import document" }],
    });
  });

  it("sanitizes a failure thrown by the artifact-link step, not just the Google calls", async () => {
    vi.mocked(getDocName).mockResolvedValue("Quarterly Plan" as never);
    vi.mocked(exportDocAsMarkdown).mockResolvedValue("# body" as never);
    vi.mocked(documentService.create).mockResolvedValue({
      id: "artifact-new",
    } as never);
    const { artifactLinksService } = await import(
      "@/app/artifact-links/service"
    );
    vi.mocked(artifactLinksService.createLink).mockRejectedValue(
      new Error(`link failed: File not found for ${LIVE_ACCESS_TOKEN}`)
    );
    vi.mocked(documentService.delete).mockResolvedValue(undefined as never);

    const { status, json, body } = await postGdriveImport();

    expect(status).toBe(200);
    expect(body).not.toContain(LIVE_ACCESS_TOKEN);
    expect(json.data).toEqual({
      results: [{ docId: "doc-1", error: "Document not found" }],
    });
    // The orphaned artifact is still cleaned up on the failure path.
    expect(documentService.delete).toHaveBeenCalledWith(
      "artifact-new",
      mockAuthContext.user.organizationId
    );
  });

  it("logs the raw failure server-side while the response stays sanitized", async () => {
    const logError = vi.spyOn(log, "error").mockImplementation(() => {
      // Swallow the write; the assertion below reads the recorded call.
    });
    vi.mocked(getDocName).mockResolvedValue("Quarterly Plan" as never);
    vi.mocked(exportDocAsMarkdown).mockRejectedValue(
      new Error("socket hang up after 3 retries")
    );

    const { json } = await postGdriveImport();

    // The operator gets the real cause; the browser still gets the canned text.
    expect(logError).toHaveBeenCalledWith(
      "[gdrive-context] Failed to import doc",
      expect.objectContaining({
        docId: "doc-1",
        organizationId: mockAuthContext.user.organizationId,
        error: expect.stringContaining("socket hang up after 3 retries"),
      })
    );
    expect(json.data).toEqual({
      results: [{ docId: "doc-1", error: "Failed to import document" }],
    });
  });
});

describe("POST /documents/:id/context-attachments/gdrive — content byte cap", () => {
  // The cap comes from the service the route imports it from — the assertions
  // below track it rather than restating the literal. `truncate-utf8`'s own
  // unit tests cover the helper; this drives a real multibyte document THROUGH
  // THE ROUTE, so a route that reverts to `.length`/`.slice` cannot stay green.
  //
  // Two thirds of the cap in CJK code units: ~2x the cap in UTF-8 bytes at 3
  // bytes per character, but well under it by `String#length`, so a `.length`
  // cap would not truncate this document at all. Sized off the cap, so the
  // fixture still straddles it if the cap moves.
  const MULTIBYTE_CHARACTER_COUNT = Math.ceil(MAX_CONTENT_BYTES / 3) * 2;
  const MULTIBYTE_DOC = "あ".repeat(MULTIBYTE_CHARACTER_COUNT);
  // The cap over 3 bytes per character, floored: the last WHOLE character that
  // fits, never a split one.
  const EXPECTED_CHARACTERS = Math.floor(MAX_CONTENT_BYTES / 3);

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(documentService.findById).mockResolvedValue({
      id: "artifact-1",
      projectId: "project-1",
    } as never);
    vi.mocked(googleService.getIntegration).mockResolvedValue({
      id: "integration-1",
    } as never);
    vi.mocked(ensureValidAccessToken).mockResolvedValue({
      success: true,
      accessToken: LIVE_ACCESS_TOKEN,
    } as never);
  });

  it("truncates stored content on a UTF-8 byte boundary, not a code-unit count", async () => {
    vi.mocked(getDocName).mockResolvedValue("Quarterly Plan" as never);
    vi.mocked(exportDocAsMarkdown).mockResolvedValue(MULTIBYTE_DOC as never);
    vi.mocked(documentService.create).mockResolvedValue({
      id: "artifact-new",
    } as never);
    const { artifactLinksService } = await import(
      "@/app/artifact-links/service"
    );
    vi.mocked(artifactLinksService.createLink).mockResolvedValue(
      undefined as never
    );

    const { status } = await postGdriveImport();

    expect(status).toBe(200);
    const createArgs = vi.mocked(documentService.create).mock.calls[0]?.[2];
    const content = createArgs?.content ?? "";
    expect(Buffer.byteLength(content, "utf8")).toBe(EXPECTED_CHARACTERS * 3);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
      MAX_CONTENT_BYTES
    );
    // Whole characters only — no lone surrogate or split codepoint at the edge.
    expect(content).toBe(MULTIBYTE_DOC.slice(0, EXPECTED_CHARACTERS));
  });

  it("names the byte cap in structured meta rather than only in the message", async () => {
    const logWarn = vi.spyOn(log, "warn").mockImplementation(() => {
      // Swallow the write; the assertion below reads the recorded call.
    });
    vi.mocked(getDocName).mockResolvedValue("Quarterly Plan" as never);
    vi.mocked(exportDocAsMarkdown).mockResolvedValue(MULTIBYTE_DOC as never);
    vi.mocked(documentService.create).mockResolvedValue({
      id: "artifact-new",
    } as never);
    const { artifactLinksService } = await import(
      "@/app/artifact-links/service"
    );
    vi.mocked(artifactLinksService.createLink).mockResolvedValue(
      undefined as never
    );

    await postGdriveImport();

    // `buildEntry` in @repo/observability/log puts this first argument in the
    // Datadog `message` attribute, which is what a log monitor matches on — so
    // the text is pinned verbatim rather than reworded. The cap travels in
    // `maxBytes`, sourced from the exported constant, so the value cannot drift
    // from what the route actually enforces.
    expect(logWarn).toHaveBeenCalledWith(
      "[gdrive-context] Truncated doc to 1MB",
      expect.objectContaining({
        docId: "doc-1",
        maxBytes: MAX_CONTENT_BYTES,
      })
    );
  });
});

describe("POST /documents/:id/context-attachments/gdrive — bounding concurrent work", () => {
  // The route's own payload cap, which is where an unbounded fan-out would
  // peak: 100 concurrent pooled writes against a 10-connection pool.
  const MAX_DOC_IDS = 100;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(documentService.findById).mockResolvedValue({
      id: "artifact-1",
      projectId: "project-1",
    } as never);
    vi.mocked(googleService.getIntegration).mockResolvedValue({
      id: "integration-1",
    } as never);
    vi.mocked(ensureValidAccessToken).mockResolvedValue({
      success: true,
      accessToken: LIVE_ACCESS_TOKEN,
    } as never);
    vi.mocked(getDocName).mockResolvedValue("Quarterly Plan" as never);
    vi.mocked(documentService.create).mockResolvedValue({
      id: "artifact-new",
    } as never);
  });

  it("never lets more document imports run at once than the fan-out bound", async () => {
    const { artifactLinksService } = await import(
      "@/app/artifact-links/service"
    );
    vi.mocked(artifactLinksService.createLink).mockResolvedValue(
      undefined as never
    );

    let inFlight = 0;
    let peakInFlight = 0;
    vi.mocked(exportDocAsMarkdown).mockImplementation((async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Yield without resolving, so every task the limiter has admitted is
      // genuinely overlapping before any of them completes. Without this the
      // tasks would serialize and any ceiling would hold trivially.
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return "# hello";
    }) as never);

    const docIds = Array.from(
      { length: MAX_DOC_IDS },
      (_unused, index) => `doc-${index}`
    );
    const { status } = await postGdriveImport(docIds);

    expect(status).toBe(200);
    // Each import is a DB-backed create. Dropping the limiter turns a full
    // 100-docId request into 100 concurrent pooled operations, which is the
    // fan-out the API guardrail exists to prevent.
    expect(peakInFlight).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
    // Pinned to the exact bound, not just "at most the bound": an assertion
    // that only checks the ceiling also passes when the imports never overlap
    // at all, so it would stay green against a limiter of 1 — or against a
    // broken harness that serialized the work and proved nothing about it.
    expect(peakInFlight).toBe(DB_FANOUT_MAX_CONCURRENCY);
    expect(documentService.create).toHaveBeenCalledTimes(MAX_DOC_IDS);
  });
});
