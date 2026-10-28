/**
 * Cross-organization authorization guard for `attachmentsService` (ISS-6741).
 *
 * `requireDocument()` is the single org boundary behind all seven entry points
 * that call it: with its `organizationId` predicate removed, any org can list,
 * download, delete and upload against another org's document. The pre-existing
 * suites could not observe that — the route tests mock the whole service away,
 * and the service test drove a `findFirst` mock that returned `null` for every
 * input.
 *
 * So this suite drives a fake artifact/attachment store that actually evaluates
 * the Prisma `where` it is handed. Each case pairs a positive control (the
 * OWNING org reaches the operation's success path against this exact fixture)
 * with the denial (a DIFFERENT org is refused), so a fixture that is simply
 * broken fails the positive half instead of passing the negative one.
 */
import {
  AttachmentPurpose,
  CreateInlineImageAttachmentErrorCode,
} from "@repo/api/src/types/attachment";
import { Result } from "@repo/api/src/types/result";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("@repo/database", () => {
  const tx = vi.fn();
  const withDbFn = Object.assign(vi.fn(), { tx });
  return {
    withDb: withDbFn,
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      BRANCH: "BRANCH",
      DEPLOYMENT: "DEPLOYMENT",
    },
  };
});

vi.mock("@repo/aws", () => ({
  deleteArtifact: vi.fn(),
  getSignedDownloadUrl: vi.fn(),
  getSignedDownloadUrlWithDisposition: vi.fn(),
  getSignedUploadUrl: vi.fn(),
  putAttachmentObject: vi.fn(),
}));

vi.mock("@repo/aws/keys", () => ({
  keys: () => ({
    FILE_ATTACHMENTS_BUCKET: process.env.FILE_ATTACHMENTS_BUCKET,
  }),
}));

vi.mock("@paralleldrive/cuid2", () => ({
  createId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { createId } from "@paralleldrive/cuid2";
import {
  deleteArtifact,
  getSignedDownloadUrl,
  getSignedDownloadUrlWithDisposition,
  getSignedUploadUrl,
  putAttachmentObject,
} from "@repo/aws";
import { ArtifactType, withDb } from "@repo/database";
import {
  ARTIFACT_ID,
  MOCK_CUID,
  makeAttachmentRecord,
  ORG_ID,
  USER_ID,
} from "@/__tests__/support/documents/attachments-service.test-fixtures";
import { PNG_BASE64 } from "@/__tests__/utils/image-fixtures";
import { isRecord } from "@/lib/type-guards";
import { attachmentInlineImageCreateService } from "../attachment-inline-image-create-service";
import {
  attachmentServiceInternalsForTesting,
  attachmentsService,
  DeleteAttachmentErrorCode,
  DOCUMENT_NOT_FOUND_ERROR,
} from "../attachments-service";

const mockWithDb = withDb as unknown as Mock & { tx: Mock };
const mockGetSignedUploadUrl = getSignedUploadUrl as unknown as Mock;
const mockGetSignedDownloadUrl = getSignedDownloadUrl as unknown as Mock;
const mockGetSignedDownloadUrlWithDisposition =
  getSignedDownloadUrlWithDisposition as unknown as Mock;
const mockDeleteArtifact = deleteArtifact as unknown as Mock;
const mockPutAttachmentObject = putAttachmentObject as unknown as Mock;
const mockCreateId = createId as unknown as Mock;

/** The organization that does NOT own {@link ARTIFACT_ID}. */
const OTHER_ORG_ID = "org-not-the-owner";
const CONTEXT_ATTACHMENT_ID = "attach-context-1";
const INLINE_ATTACHMENT_ID = "attach-inline-1";
const CREATED_ATTACHMENT_ID = "attach-created-1";
const SIGNED_UPLOAD_URL = "https://s3.example.com/presigned-upload";
const SIGNED_DOWNLOAD_URL = "https://s3.example.com/presigned-download";
const SIGNED_PREVIEW_URL = "https://s3.example.com/presigned-preview";
const OWNED_ATTACHMENT_KEY = `attachments/${ORG_ID}/${ARTIFACT_ID}/${MOCK_CUID}`;

type ArtifactRow = { id: string; organizationId: string; type: string };
type AttachmentRow = ReturnType<typeof makeAttachmentRecord>;
type WhereClause = Record<string, unknown>;
type QueryArgs = { where: WhereClause; select?: unknown; data?: unknown };

type SettledOutcome =
  | { status: "resolved"; value: unknown }
  | { status: "threw"; error: unknown };

type FakeDatabase = {
  artifactFindFirst: Mock<(args: QueryArgs) => Promise<unknown>>;
  attachmentCreate: Mock<(args: QueryArgs) => Promise<unknown>>;
  attachmentDeleteMany: Mock<(args: QueryArgs) => Promise<unknown>>;
};

type AttachmentOperation = {
  name: string;
  invoke: (organizationId: string) => Promise<unknown>;
  /** Shape the OWNING org's call must resolve to — the positive control. */
  allowed: Record<string, unknown> | Record<string, unknown>[];
  /** Exact outcome a NON-owning org's call must produce. */
  denied: SettledOutcome;
};

/**
 * `requireDocument` reports a denial by throwing, which every caller that does
 * not translate it into a `Result` propagates verbatim.
 */
const DENIED_BY_THROW: SettledOutcome = {
  status: "threw",
  error: new Error(DOCUMENT_NOT_FOUND_ERROR),
};

let fakeDb: FakeDatabase;

describe("attachmentsService cross-organization access (ISS-6741)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    attachmentServiceInternalsForTesting.clearSignedDownloadUrlCache();
    process.env.FILE_ATTACHMENTS_BUCKET = "test-bucket";
    mockCreateId.mockReturnValue(MOCK_CUID);
    mockGetSignedUploadUrl.mockResolvedValue(SIGNED_UPLOAD_URL);
    mockGetSignedDownloadUrl.mockResolvedValue(SIGNED_PREVIEW_URL);
    mockGetSignedDownloadUrlWithDisposition.mockResolvedValue(
      SIGNED_DOWNLOAD_URL
    );
    mockPutAttachmentObject.mockResolvedValue(undefined);
    mockDeleteArtifact.mockResolvedValue(undefined);
    seedDatabase();
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "FILE_ATTACHMENTS_BUCKET");
  });

  for (const operation of buildOrgScopedOperations()) {
    it(`denies ${operation.name} against a document owned by another organization`, async () => {
      // Positive control: this exact fixture is reachable for the owning org,
      // so the denial below cannot be a broken-fixture false green.
      expect(await operation.invoke(ORG_ID)).toMatchObject(operation.allowed);

      seedDatabase();
      vi.clearAllMocks();
      // Without this a cached signature could satisfy the "never signed"
      // assertions below without the signer being reached at all.
      attachmentServiceInternalsForTesting.clearSignedDownloadUrlCache();
      mockCreateId.mockReturnValue(MOCK_CUID);

      const outcome = await settle(() => operation.invoke(OTHER_ORG_ID));
      expect(outcome).toEqual(operation.denied);

      // The harm ISS-6741 describes: a non-owning org must never be handed
      // presigned S3 material for, nor mutate, another org's attachments.
      expect(mockGetSignedDownloadUrlWithDisposition).not.toHaveBeenCalled();
      expect(mockGetSignedDownloadUrl).not.toHaveBeenCalled();
      expect(mockGetSignedUploadUrl).not.toHaveBeenCalled();
      expect(mockPutAttachmentObject).not.toHaveBeenCalled();
      expect(mockDeleteArtifact).not.toHaveBeenCalled();
      expect(fakeDb.attachmentCreate).not.toHaveBeenCalled();
      expect(fakeDb.attachmentDeleteMany).not.toHaveBeenCalled();
    });
  }

  it("scopes the document ownership lookup on organizationId, id and type", async () => {
    await attachmentsService.listByDocument(ARTIFACT_ID, ORG_ID);

    expect(fakeDb.artifactFindFirst).toHaveBeenCalledTimes(1);
    expect(fakeDb.artifactFindFirst.mock.calls[0][0].where).toEqual({
      id: ARTIFACT_ID,
      organizationId: ORG_ID,
      type: ArtifactType.DOCUMENT,
    });
  });
});

/**
 * Every public entry point that routes through `requireDocument`. Keeping them
 * in one table means a new consumer of that guard is one row, not a new suite.
 */
function buildOrgScopedOperations(): AttachmentOperation[] {
  return [
    {
      name: "requestUpload",
      invoke: (organizationId) =>
        attachmentsService.requestUpload(
          ARTIFACT_ID,
          organizationId,
          USER_ID,
          "report.pdf",
          "application/pdf",
          4096
        ),
      allowed: {
        attachmentId: CREATED_ATTACHMENT_ID,
        key: OWNED_ATTACHMENT_KEY,
        uploadUrl: SIGNED_UPLOAD_URL,
      },
      denied: DENIED_BY_THROW,
    },
    {
      name: "requestDirectUpload",
      invoke: (organizationId) =>
        attachmentsService.requestDirectUpload(
          ARTIFACT_ID,
          organizationId,
          USER_ID,
          "report.pdf",
          "application/pdf",
          4096
        ),
      allowed: {
        ok: true,
        value: { attachmentId: CREATED_ATTACHMENT_ID },
      },
      denied: DENIED_BY_THROW,
    },
    {
      name: "createInlineImageAttachment",
      invoke: (organizationId) =>
        attachmentInlineImageCreateService.createInlineImageAttachment(
          ARTIFACT_ID,
          organizationId,
          USER_ID,
          "diagram.png",
          "image/png",
          PNG_BASE64
        ),
      allowed: {
        ok: true,
        value: { attachmentId: CREATED_ATTACHMENT_ID },
      },
      denied: deniedWithResultCode(
        CreateInlineImageAttachmentErrorCode.DocumentNotFound
      ),
    },
    {
      name: "listByDocument",
      invoke: (organizationId) =>
        attachmentsService.listByDocument(ARTIFACT_ID, organizationId),
      allowed: [{ id: CONTEXT_ATTACHMENT_ID }],
      denied: DENIED_BY_THROW,
    },
    {
      name: "getDownloadUrl",
      invoke: (organizationId) =>
        attachmentsService.getDownloadUrl(
          ARTIFACT_ID,
          organizationId,
          CONTEXT_ATTACHMENT_ID
        ),
      allowed: { downloadUrl: SIGNED_DOWNLOAD_URL },
      denied: DENIED_BY_THROW,
    },
    {
      name: "deleteAttachment",
      invoke: (organizationId) =>
        attachmentsService.deleteAttachment(
          ARTIFACT_ID,
          organizationId,
          USER_ID,
          CONTEXT_ATTACHMENT_ID
        ),
      allowed: { ok: true },
      denied: deniedWithResultCode(DeleteAttachmentErrorCode.DocumentNotFound),
    },
    {
      name: "resolveInlineImages",
      invoke: (organizationId) =>
        attachmentsService.resolveInlineImages(ARTIFACT_ID, organizationId, [
          INLINE_ATTACHMENT_ID,
        ]),
      allowed: {
        images: [
          { attachmentId: INLINE_ATTACHMENT_ID, url: SIGNED_PREVIEW_URL },
        ],
        skipped: [],
      },
      denied: DENIED_BY_THROW,
    },
  ];
}

/** Denial for the callers that translate the guard into an error `Result`. */
function deniedWithResultCode(code: string): SettledOutcome {
  return { status: "resolved", value: Result.err({ code }) };
}

async function settle(run: () => Promise<unknown>): Promise<SettledOutcome> {
  try {
    return { status: "resolved", value: await run() };
  } catch (error) {
    return { status: "threw", error };
  }
}

/** True when `value` is a Prisma `{ in: [...] }` list filter. */
function isListFilter(value: unknown): value is { in: unknown[] } {
  return isRecord(value) && Array.isArray(value.in);
}

function matchesWhere(
  row: Record<string, unknown>,
  where: WhereClause,
  organizationIdOf: (artifactId: unknown) => string | undefined
): boolean {
  return Object.entries(where).every(([field, expected]) => {
    if (field === "artifact") {
      return (
        isRecord(expected) &&
        organizationIdOf(row.artifactId) === expected.organizationId
      );
    }
    if (isListFilter(expected)) {
      return expected.in.includes(row[field]);
    }
    return row[field] === expected;
  });
}

/**
 * Installs a fake store that evaluates the `where` it is given, so dropping a
 * predicate from a query changes what the service can reach — which is the
 * whole point of this suite. `withDb` and `withDb.tx` share one store.
 */
function seedDatabase(): void {
  const artifacts: ArtifactRow[] = [
    { id: ARTIFACT_ID, organizationId: ORG_ID, type: ArtifactType.DOCUMENT },
  ];
  let attachments: AttachmentRow[] = [
    makeAttachmentRecord({ id: CONTEXT_ATTACHMENT_ID }),
    makeAttachmentRecord({
      id: INLINE_ATTACHMENT_ID,
      mimeType: "image/png",
      purpose: AttachmentPurpose.Inline,
    }),
  ];

  const organizationIdOf = (artifactId: unknown): string | undefined =>
    artifacts.find((artifact) => artifact.id === artifactId)?.organizationId;
  const selectAttachments = (where: WhereClause): AttachmentRow[] =>
    attachments.filter((row) => matchesWhere(row, where, organizationIdOf));

  const artifactFindFirst = vi.fn(({ where }: QueryArgs) =>
    Promise.resolve(
      artifacts.find((row) => matchesWhere(row, where, organizationIdOf)) ??
        null
    )
  );
  const attachmentCreate = vi.fn(({ data }: QueryArgs) => {
    const created = makeAttachmentRecord({
      ...(isRecord(data) ? data : {}),
      id: CREATED_ATTACHMENT_ID,
    });
    attachments = [...attachments, created];
    return Promise.resolve(created);
  });
  const attachmentDeleteMany = vi.fn(({ where }: QueryArgs) => {
    const doomed = new Set(selectAttachments(where).map((row) => row.id));
    attachments = attachments.filter((row) => !doomed.has(row.id));
    return Promise.resolve({ count: doomed.size });
  });

  const client = {
    artifact: { findFirst: artifactFindFirst },
    fileAttachment: {
      create: attachmentCreate,
      deleteMany: attachmentDeleteMany,
      findFirst: vi.fn(({ where }: QueryArgs) =>
        Promise.resolve(selectAttachments(where)[0] ?? null)
      ),
      findMany: vi.fn(({ where }: QueryArgs) =>
        Promise.resolve(selectAttachments(where))
      ),
    },
    oAuthRateLimit: {
      create: vi.fn(() => Promise.resolve({ id: "rate-limit-row" })),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      findUnique: vi.fn(() => Promise.resolve(null)),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
  };

  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(client)
  );
  mockWithDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(client)
  );

  fakeDb = { artifactFindFirst, attachmentCreate, attachmentDeleteMany };
}
