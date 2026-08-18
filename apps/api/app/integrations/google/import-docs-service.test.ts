import { DocumentStatus } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-5291: the Google Drive folder-import path.
 *
 * `importDocsFromFolder` had zero test calls, and so did the error sanitizer it
 * routes every per-document failure through. That pairing is the reason this
 * slice exists rather than a raw branch count: the function's whole job is to
 * import N documents where some subset fails, and it must then report a count
 * and a failure list that a user can act on.
 *
 * Two things it can get wrong quietly, both covered below:
 *   - reporting a truncated population as the real one, so a user who imported
 *     100 of 250 documents is told the folder held 100, and
 *   - letting one bad document fail the whole batch, or conversely counting a
 *     failed document as imported.
 *
 * The sanitizer is driven through the production call site, not directly, since
 * it is module-private — which also proves it is actually wired to the failure
 * path rather than merely existing.
 */

const {
  mockFindUnique,
  mockUpdate,
  mockFindById,
  mockCreate,
  mockListDocsInFolder,
  mockExportDocAsMarkdown,
  mockRefreshAccessToken,
  mockResolveIntegrationToken,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockFindById: vi.fn(),
  mockCreate: vi.fn(),
  mockListDocsInFolder: vi.fn(),
  mockExportDocAsMarkdown: vi.fn(),
  mockRefreshAccessToken: vi.fn(),
  mockResolveIntegrationToken: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      googleIntegration: { findUnique: mockFindUnique, update: mockUpdate },
    }),
}));

vi.mock("@repo/google", () => ({
  exchangeCodeForTokens: vi.fn(),
  exportDocAsMarkdown: mockExportDocAsMarkdown,
  getUserInfo: vi.fn(),
  listDocsInFolder: mockListDocsInFolder,
  refreshAccessToken: mockRefreshAccessToken,
  revokeToken: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: { create: mockCreate },
}));

vi.mock("@/app/projects/service", () => ({
  projectsService: { findById: mockFindById },
}));

vi.mock("@/lib/integration-encryption", () => ({
  encryptTokenPair: vi.fn(),
  resolveIntegrationToken: mockResolveIntegrationToken,
}));

import { log } from "@repo/observability/log";
import { redactLogValue } from "@repo/observability/redact";
import {
  googleService,
  MAX_CONTENT_BYTES,
} from "@/app/integrations/google/service";
import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const PROJECT_ID = "project-1";
const FOLDER_ID = "folder-1";
// Shaped like a real Google OAuth access token, and deliberately bare: the
// `Bearer …` form was already covered by the shared redaction pattern.
const GOOGLE_ACCESS_TOKEN = "ya29.a0AfH6SMBx7Qm-3lKd_9Zt";

function run() {
  return googleService.importDocsFromFolder(
    FOLDER_ID,
    PROJECT_ID,
    ORGANIZATION_ID,
    USER_ID
  );
}

function makeDocs(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `doc-${index}`,
    name: `Doc ${index}`,
    mimeType: "application/vnd.google-apps.document",
  }));
}

function happyPath() {
  mockFindUnique.mockResolvedValue({
    organizationId: ORGANIZATION_ID,
    // Far future, so `ensureValidAccessToken` takes the still-valid branch and
    // no refresh is attempted.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  mockResolveIntegrationToken.mockResolvedValue("access-token-1");
  mockFindById.mockResolvedValue({ id: PROJECT_ID });
  mockListDocsInFolder.mockResolvedValue(makeDocs(2));
  mockExportDocAsMarkdown.mockResolvedValue("# hello");
  mockCreate.mockImplementation((_org, _user, input) =>
    Promise.resolve({
      id: `artifact-${input.title}`,
      slug: `slug-${input.title}`,
      title: input.title,
    })
  );
}

describe("importDocsFromFolder — preconditions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
  });

  it("refuses when the organization has no Google integration", async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await run();

    expect(result).toEqual({
      success: false,
      error: "Google Drive is not connected. Please connect in settings.",
    });
    // Nothing downstream should be consulted once the integration is absent.
    expect(mockListDocsInFolder).not.toHaveBeenCalled();
  });

  it("refuses when the project is not visible to the organization", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await run();

    expect(result).toMatchObject({ success: false });
    // Org scoping: the project lookup is what stops a caller importing into
    // another tenant's project, so it must run before any Drive read.
    expect(mockFindById).toHaveBeenCalledWith(PROJECT_ID, ORGANIZATION_ID);
    expect(mockListDocsInFolder).not.toHaveBeenCalled();
  });

  it("refuses when the access token cannot be resolved", async () => {
    mockResolveIntegrationToken.mockResolvedValue(null);

    const result = await run();

    expect(result).toMatchObject({ success: false });
    expect(mockListDocsInFolder).not.toHaveBeenCalled();
  });
});

describe("importDocsFromFolder — classifying a folder-level failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
  });

  it.each([
    ["a 404", new Error("Request failed with 404"), "Folder not found"],
    [
      "a not-found message",
      new Error("File not found in Drive"),
      "Folder not found",
    ],
    [
      "a 403",
      new Error("Request failed with 403"),
      "Folder not accessible (permission denied)",
    ],
    [
      "a permission-denied message",
      new Error("Permission denied for folder"),
      "Folder not accessible (permission denied)",
    ],
  ])("maps %s to a specific message", async (_label, error, expected) => {
    mockListDocsInFolder.mockRejectedValue(error);

    const result = await run();

    expect(result).toEqual({ success: false, error: expected });
  });

  it("falls back to a generic message for an unrecognized failure", async () => {
    mockListDocsInFolder.mockRejectedValue(new Error("socket hang up"));

    const result = await run();

    // The fallback must not guess: a transport error is not a permission
    // problem, and telling the user it is sends them to the wrong fix.
    expect(result).toEqual({
      success: false,
      error: "Failed to access Google Drive folder",
    });
  });
});

describe("importDocsFromFolder — counting what it actually imported", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
  });

  it("reports a true zero for an empty folder", async () => {
    mockListDocsInFolder.mockResolvedValue([]);

    const result = await run();

    // An empty folder is a SUCCESS with zero, not a failure — and both counts
    // are zero, so the user is not told documents exist that were skipped.
    expect(result).toEqual({
      success: true,
      importedCount: 0,
      totalDocsInFolder: 0,
      artifacts: [],
      failures: [],
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("truncates to the cap and keeps the pre-truncation population (defensive branch)", async () => {
    // REACHABILITY, stated plainly so this test does not overclaim: the real
    // producer cannot deliver 250. `listDocsInFolder` asks Drive for one
    // 100-item page and ignores `nextPageToken`, so `docs.length > 100` is
    // unreachable through production today and `totalDocsInFolder` is always
    // <= 100 — which is also why the import modal has nothing extra to tell
    // the user about a dropped remainder. That cap is pinned directly in
    // `packages/google/__tests__/list-docs-in-folder.test.ts`; if pagination is
    // ever added, that test fails first and this branch goes live.
    //
    // The branch is kept covered because it is live code that would then have
    // to be correct, not because a user hits it today.
    mockListDocsInFolder.mockResolvedValue(makeDocs(250));

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    // `importedCount` is what landed; `totalDocsInFolder` must stay the real
    // pre-truncation size rather than collapsing to the capped count.
    expect(result.importedCount).toBe(100);
    expect(result.totalDocsInFolder).toBe(250);
    expect(mockCreate).toHaveBeenCalledTimes(100);
  });

  it("imports every document when the folder is exactly at the cap", async () => {
    mockListDocsInFolder.mockResolvedValue(makeDocs(100));

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    // Boundary: 100 is not "more than 100", so nothing is dropped and the two
    // counts agree.
    expect(result.importedCount).toBe(100);
    expect(result.totalDocsInFolder).toBe(100);
  });

  it("returns the created artifacts with their identifiers", async () => {
    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    expect(result.artifacts).toEqual([
      { id: "artifact-Doc 0", slug: "slug-Doc 0", title: "Doc 0" },
      { id: "artifact-Doc 1", slug: "slug-Doc 1", title: "Doc 1" },
    ]);
  });

  it("substitutes an empty slug rather than dropping an artifact without one", async () => {
    mockListDocsInFolder.mockResolvedValue(makeDocs(1));
    mockCreate.mockResolvedValue({
      id: "artifact-1",
      slug: null,
      title: "Doc 0",
    });

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    // The document WAS created; a missing slug is a rendering concern, not a
    // reason to report the import as not having happened.
    expect(result.importedCount).toBe(1);
    expect(result.artifacts[0]?.slug).toBe("");
  });
});

describe("importDocsFromFolder — one document failing does not fail the batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
  });

  it("keeps the successes and reports the failure alongside them", async () => {
    mockListDocsInFolder.mockResolvedValue(makeDocs(3));
    mockExportDocAsMarkdown.mockImplementation((docId: string) =>
      docId === "doc-1"
        ? Promise.reject(new Error("403 Permission denied"))
        : Promise.resolve("# hello")
    );

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    // The overall call still succeeds: a partial import is a real outcome and
    // must not be reported as total failure.
    expect(result.importedCount).toBe(2);
    expect(result.totalDocsInFolder).toBe(3);
    expect(result.failures).toEqual([
      {
        docId: "doc-1",
        docTitle: "Doc 1",
        error: "Unable to access document (permission denied)",
      },
    ]);
  });

  it("records a failure when artifact creation returns null", async () => {
    mockListDocsInFolder.mockResolvedValue(makeDocs(1));
    mockCreate.mockResolvedValue(null);

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    // A null return is not a created document. Counting it would report an
    // import the user cannot open.
    expect(result.importedCount).toBe(0);
    expect(result.failures).toHaveLength(1);
  });

  it("counts a wholly failed batch as zero imported, not as an error result", async () => {
    mockListDocsInFolder.mockResolvedValue(makeDocs(2));
    mockExportDocAsMarkdown.mockRejectedValue(new Error("quotaExceeded"));

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    expect(result.importedCount).toBe(0);
    expect(result.failures).toHaveLength(2);
    expect(result.totalDocsInFolder).toBe(2);
  });
});

describe("importDocsFromFolder — bounding concurrent work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
  });

  it("never lets more document imports run at once than the fan-out bound", async () => {
    mockListDocsInFolder.mockResolvedValue(makeDocs(100));

    let inFlight = 0;
    let peakInFlight = 0;
    mockExportDocAsMarkdown.mockImplementation(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Yield without resolving, so every task the limiter has admitted is
      // genuinely overlapping before any of them completes. Without this the
      // tasks would serialize and any ceiling would hold trivially.
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return "# hello";
    });

    await run();

    // Each document import is a DB-backed create. Dropping the limiter turns a
    // 100-document folder into 100 concurrent pooled operations, which is the
    // fan-out the API guardrail exists to prevent.
    expect(peakInFlight).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
    // Pinned to the exact bound, not just "at most the bound": an assertion
    // that only checks the ceiling also passes when the imports never overlap
    // at all, so it would stay green against a limiter of 1 — or against a
    // broken harness that serialized the work and proved nothing about it.
    expect(peakInFlight).toBe(DB_FANOUT_MAX_CONCURRENCY);
    expect(mockCreate).toHaveBeenCalledTimes(100);
  });
});

describe("importDocsFromFolder — the per-document error sanitizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
    mockListDocsInFolder.mockResolvedValue(makeDocs(1));
  });

  it.each([
    ["Permission denied", "Unable to access document (permission denied)"],
    [
      "Request failed with 403",
      "Unable to access document (permission denied)",
    ],
    ["File not found", "Document not found"],
    ["Request failed with 404", "Document not found"],
    [
      "exportSizeLimitExceeded",
      "Document exceeds Google Drive export limit (10MB)",
    ],
    [
      "Export is larger than 10MB",
      "Document exceeds Google Drive export limit (10MB)",
    ],
    ["quotaExceeded", "Google API quota exceeded, try again later"],
    ["hit the rate limit", "Google API quota exceeded, try again later"],
  ])("maps a %s failure to its user-facing message", async (raw, expected) => {
    mockExportDocAsMarkdown.mockRejectedValue(new Error(raw));

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    // Each provider signature is pinned separately: the sanitizer is a chain of
    // `includes` tests, so one clause silently falling through would still be
    // caught by a later clause's generic fallback and look fine in aggregate.
    expect(result.failures[0]?.error).toBe(expected);
  });

  it("falls back to a generic message rather than surfacing raw provider text", async () => {
    mockExportDocAsMarkdown.mockRejectedValue(
      new Error("Bearer ya29.SECRET-TOKEN rejected by googleapis")
    );

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    // This is the sanitizer's actual job: an unrecognized provider error may
    // carry a token or an internal URL, so the client gets a fixed string and
    // the detail stays in the server log.
    expect(result.failures[0]?.error).toBe("Failed to import document");
    expect(result.failures[0]?.error).not.toContain("SECRET-TOKEN");
  });

  it("maps a recognized signature raised by artifact creation, not only by the export", async () => {
    // The export failure and the artifact-creation failure are caught in two
    // DIFFERENT blocks, each calling the sanitizer separately. Every case above
    // drives the export block, so replacing the sanitizer in the creation block
    // with raw text would not move any of them.
    mockCreate.mockRejectedValue(new Error("Request failed with 403"));

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    expect(result.failures[0]?.error).toBe(
      "Unable to access document (permission denied)"
    );
  });

  it("does not leak internal persistence detail when artifact creation throws", async () => {
    mockCreate.mockRejectedValue(
      new Error(
        "PrismaClientKnownRequestError: Invalid `db.document.create()` invocation in /var/task/.next/server/chunks/9182.js"
      )
    );

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    // An unrecognized internal error is the generic string — a Prisma message
    // or a server path reaching this list would be shown to the end user.
    expect(result.failures[0]?.error).toBe("Failed to import document");
    expect(result.failures[0]?.error).not.toContain("Prisma");
    expect(result.failures[0]?.error).not.toContain("/var/task");
  });

  it("keeps a bare access token out of the server log, not only the client string", async () => {
    // The client-facing half above is only one of two sinks. The service also
    // hands `parseError(error)` to `log.error`, and `parseError` returns
    // `Error.message` verbatim — so the credential's last line of defence is
    // the redaction the log serializer applies. googleapis quotes the token
    // bare, WITHOUT a `Bearer` prefix, which is the shape the shared pattern
    // did not previously match.
    mockExportDocAsMarkdown.mockRejectedValue(
      new Error(`Invalid Credentials: ${GOOGLE_ACCESS_TOKEN}`)
    );

    await run();

    const loggedMeta = vi.mocked(log.error).mock.calls.at(-1)?.[1];
    // Serialize exactly the way log.ts does (its `jsonReplacer` delegates to
    // `redactLogValue`), so this asserts the real sink rather than a
    // reimplementation of it.
    const serialized = JSON.stringify(loggedMeta, (key, value) =>
      redactLogValue(key, value)
    );

    expect(serialized).not.toContain(GOOGLE_ACCESS_TOKEN);
    expect(serialized).toContain("[redacted]");
  });
});

describe("importDocsFromFolder — oversized documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPath();
    mockListDocsInFolder.mockResolvedValue(makeDocs(1));
  });

  it("truncates a document past the cap instead of rejecting it", async () => {
    const oversized = "x".repeat(MAX_CONTENT_BYTES + 500);
    mockExportDocAsMarkdown.mockResolvedValue(oversized);

    const result = await run();

    if (!result.success) {
      throw new Error("expected the import to succeed");
    }
    expect(result.importedCount).toBe(1);
    expect(mockCreate.mock.calls[0]?.[2].content).toHaveLength(
      MAX_CONTENT_BYTES
    );
  });

  it("stores a document at exactly the limit unchanged", async () => {
    const exact = "x".repeat(MAX_CONTENT_BYTES);
    mockExportDocAsMarkdown.mockResolvedValue(exact);

    await run();

    // Boundary: the guard is `>`, so a document exactly at the limit keeps
    // every byte.
    expect(mockCreate.mock.calls[0]?.[2].content).toHaveLength(
      MAX_CONTENT_BYTES
    );
  });

  it("caps a CJK document by bytes, not by UTF-16 code units", async () => {
    // Two thirds of the cap in CJK characters: comfortably under a `.length`
    // cap of MAX_CONTENT_BYTES code units, but ~2x the cap in UTF-8 bytes at 3
    // bytes per character. An ASCII fixture cannot catch this, because for
    // ASCII the two measures coincide. Sized off the cap, so the fixture still
    // straddles it if the cap moves.
    const cjk = "漢".repeat(Math.ceil(MAX_CONTENT_BYTES / 3) * 2);
    mockExportDocAsMarkdown.mockResolvedValue(cjk);

    await run();

    const stored = mockCreate.mock.calls[0]?.[2].content as string;
    expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThan(MAX_CONTENT_BYTES);
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(
      MAX_CONTENT_BYTES
    );
    // Not vacuous: the document really was too big and really was shortened.
    expect(stored.length).toBeLessThan(cjk.length);
  });

  it("never splits an astral character across the cut", async () => {
    // The emoji straddles the byte cut: 1,048,575 ASCII bytes then a 4-byte
    // character. Cutting at a fixed index lands inside it and, on the code-unit
    // path, emits the high surrogate alone.
    const straddling = `${"a".repeat(MAX_CONTENT_BYTES - 1)}😀`;
    mockExportDocAsMarkdown.mockResolvedValue(straddling);

    await run();

    const stored = mockCreate.mock.calls[0]?.[2].content as string;
    // A lone surrogate cannot round-trip through UTF-8 — it decodes back as
    // U+FFFD — so equality here is precisely the "no split character" contract.
    expect(Buffer.from(stored, "utf8").toString("utf8")).toBe(stored);
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(
      MAX_CONTENT_BYTES
    );
  });

  it("creates each document as a draft PRD in the requested project", async () => {
    await run();

    expect(mockCreate).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      USER_ID,
      expect.objectContaining({
        projectId: PROJECT_ID,
        status: DocumentStatus.Draft,
        title: "Doc 0",
        fileName: "Doc 0.md",
      })
    );
  });
});
