import {
  type DocumentVersion,
  MAX_DOCUMENT_VERSION_NUMBER,
} from "@repo/api/src/types/document-version";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (
      request: Request,
      context: { params: Promise<{ id: string; versionRef: string }> }
    ) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    findByIdSimple: vi.fn(),
  },
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveDocumentId: vi.fn(async (id: string) => id),
  };
});

vi.mock("../../../document-version-service", () => ({
  documentVersionService: {
    getByVersion: vi.fn(),
    getByVersionId: vi.fn(),
  },
}));

import { documentService } from "@/app/documents/document-service";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { documentVersionService } from "../../../document-version-service";
import { GET } from "./route";

const DOCUMENT_ID = "doc-1";

// Matches the org on the context `createTestAuthContext` builds, so asserting
// it below proves the route forwards the CALLER's org rather than any string.
const ORGANIZATION_ID = "test-org-id";

// Three versions with DISTINCT bodies. A fixture whose versions share content
// cannot tell "returned version N" apart from "returned the current version",
// which is the defect this route exists to close.
const VERSION_BODIES: Record<number, string> = {
  1: "## The finding\n\nOriginal body of version one.",
  2: "Auto-restored by the sweep. Hold reason: clobbered body.",
  3: "CURRENT body — version three, the latest.",
};

// Real UUIDs: DocumentVersion.id is a `@db.Uuid` column, and the route refuses
// a non-UUID ref before querying, so a fake id here would not exercise the
// lookup path at all.
const VERSION_IDS: Record<number, string> = {
  1: "019ff6e9-4887-7543-bb69-0880d0525f65",
  2: "01a0240a-cd5c-71df-a159-5665d84a8e60",
  3: "01a029d7-4ce3-738d-aa87-f6e87425c419",
};

const ABSENT_BUT_WELL_FORMED_VERSION_ID =
  "01a0294d-1451-7095-9928-b7449e84185f";

function makeVersion(version: number): DocumentVersion {
  return {
    id: VERSION_IDS[version],
    documentId: DOCUMENT_ID,
    version,
    content: VERSION_BODIES[version],
    createdById: "test-user-id",
    createdAt: new Date("2026-08-21T00:00:00.000Z"),
  };
}

async function callRoute(versionRef: string) {
  const response = await GET(
    createMockRequest({
      url: `http://localhost:3002/api/documents/${DOCUMENT_ID}/versions/${versionRef}`,
    }),
    createMockRouteContext({ id: DOCUMENT_ID, versionRef })
  );
  return { body: await response.json(), response };
}

describe("GET /documents/:id/versions/:versionRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(resolveDocumentId).mockImplementation(async (id: string) => id);
    vi.mocked(documentService.findByIdSimple).mockResolvedValue({
      id: DOCUMENT_ID,
      organizationId: "test-org-id",
    } as never);

    vi.mocked(documentVersionService.getByVersion).mockImplementation(
      (_documentId: string, version: number) =>
        Promise.resolve(
          VERSION_BODIES[version] === undefined ? null : makeVersion(version)
        )
    );
    vi.mocked(documentVersionService.getByVersionId).mockImplementation(
      (_documentId: string, _organizationId: string, versionId: string) => {
        const match = Object.entries(VERSION_IDS).find(
          ([, id]) => id === versionId
        );
        return Promise.resolve(match ? makeVersion(Number(match[0])) : null);
      }
    );
  });

  it("returns the REQUESTED version's content, not the current version's", async () => {
    const { body, response } = await callRoute("1");

    expect(response.status).toBe(200);
    expect(body.data.version).toBe(1);
    expect(body.data.content).toBe(VERSION_BODIES[1]);
    // The bug this closes: serving the latest body for a historical request.
    expect(body.data.content).not.toBe(VERSION_BODIES[3]);
  });

  it("resolves each version number to its own distinct body", async () => {
    for (const version of [1, 2, 3]) {
      const { body } = await callRoute(String(version));
      expect(body.data.version).toBe(version);
      expect(body.data.content).toBe(VERSION_BODIES[version]);
    }
  });

  it("resolves a version row id to that row's content", async () => {
    const { body, response } = await callRoute(VERSION_IDS[1]);

    expect(response.status).toBe(200);
    expect(body.data.id).toBe(VERSION_IDS[1]);
    expect(body.data.content).toBe(VERSION_BODIES[1]);
    expect(documentVersionService.getByVersionId).toHaveBeenCalledWith(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      VERSION_IDS[1]
    );
  });

  it("404s for a version number that does not exist", async () => {
    const { body, response } = await callRoute("999");

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
  });

  it("404s for a well-formed version id that does not exist", async () => {
    const { response } = await callRoute(ABSENT_BUT_WELL_FORMED_VERSION_ID);

    expect(response.status).toBe(404);
    // The ref was well-formed, so the lookup must actually have been attempted.
    expect(documentVersionService.getByVersionId).toHaveBeenCalledWith(
      DOCUMENT_ID,
      ORGANIZATION_ID,
      ABSENT_BUT_WELL_FORMED_VERSION_ID
    );
  });

  it.each(["01a0240z-not-a-version", "abc", "not/a/ref", "1.5", "-1"])(
    "rejects the malformed ref %s with a 400 and never queries",
    async (versionRef) => {
      const { response } = await callRoute(versionRef);

      // DocumentVersion.id is a @db.Uuid column: handing it a non-UUID raises
      // P2023 inside the query, which the handler's catch would return as 500.
      expect(response.status).toBe(400);
      expect(documentVersionService.getByVersionId).not.toHaveBeenCalled();
      expect(documentVersionService.getByVersion).not.toHaveBeenCalled();
    }
  );

  it("404s when the artifact is not visible to the caller's org", async () => {
    vi.mocked(documentService.findByIdSimple).mockResolvedValue(null as never);

    const { response } = await callRoute("1");

    expect(response.status).toBe(404);
    // No version row may be read once the org check fails.
    expect(documentVersionService.getByVersion).not.toHaveBeenCalled();
    expect(documentVersionService.getByVersionId).not.toHaveBeenCalled();
  });

  it("rejects a zero ordinal with a 400 rather than querying for it", async () => {
    const { response } = await callRoute("0");

    expect(response.status).toBe(400);
    expect(documentVersionService.getByVersion).not.toHaveBeenCalled();
  });

  // All-digit refs clear VERSION_NUMBER_PATTERN, so only the range check stands
  // between them and the query. `DocumentVersion.version` is a Prisma `Int`:
  // Prisma rejects an out-of-range comparand instead of returning empty, and the
  // handler's catch would surface that as a 500 — the defect class this route
  // exists to close. The overlong ref converts to `Infinity`, which is also not
  // a queryable ordinal.
  it.each([
    ["one past int4 max", `${MAX_DOCUMENT_VERSION_NUMBER + 1}`],
    ["a ref long enough to become Infinity", "9".repeat(400)],
  ])("rejects %s with a 400 and never queries", async (_label, versionRef) => {
    const { response } = await callRoute(versionRef);

    expect(response.status).toBe(400);
    expect(documentVersionService.getByVersion).not.toHaveBeenCalled();
    expect(documentVersionService.getByVersionId).not.toHaveBeenCalled();
  });

  it("still serves the largest ordinal the column can actually hold", async () => {
    vi.mocked(documentVersionService.getByVersion).mockResolvedValue(
      makeVersion(1)
    );

    const { response } = await callRoute(`${MAX_DOCUMENT_VERSION_NUMBER}`);

    // The bound must reject only what the column cannot store: an off-by-one
    // that excluded int4 max itself would pass the rejection test above.
    expect(response.status).toBe(200);
    expect(documentVersionService.getByVersion).toHaveBeenCalledWith(
      DOCUMENT_ID,
      MAX_DOCUMENT_VERSION_NUMBER
    );
  });
});
