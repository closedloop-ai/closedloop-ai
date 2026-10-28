import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  MCP_CLIENT_HEADER_VALUE,
  OperationEvidenceHeader,
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { DocumentType } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { commentsService } from "@/app/comments/service";
import type { AuthContext } from "@/lib/auth/with-auth";

const auth = vi.hoisted(() => ({
  context: null as AuthContext | null,
  scheduled: [] as Promise<unknown>[],
  organizationIds: [] as string[],
}));

const flag = vi.hoisted(() => ({ offOrganizationIds: new Set<string>() }));

vi.mock(
  "@/lib/attribution-evidence-policy-feature",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attribution-evidence-policy-feature")
    >()),
    isAttributionEvidenceEnabledForOrganization: vi.fn(
      async (organizationId: string) =>
        !flag.offOrganizationIds.has(organizationId)
    ),
    evaluateAttributionEvidenceForOrganization: vi.fn(
      async (organizationId: string) =>
        !flag.offOrganizationIds.has(organizationId)
    ),
  })
);
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context?: { params: Promise<unknown> }) =>
      handler(auth.context, request, context?.params),
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    auth.scheduled.push(work);
  },
}));

import { POST as createLink } from "@/app/artifact-links/route";
import { PUT as updateDocument } from "@/app/documents/[id]/route";
import { POST as createThread } from "@/app/documents/[id]/threads/route";
import { POST as createVersion } from "@/app/documents/[id]/versions/route";
import { POST as createDocument } from "@/app/documents/route";

const tracker = createCommittedTestOrganizationTracker();
const INTERNAL_SECRET = "test-internal-secret";
const FORGED_SECRET = "not-the-internal-secret";
const API_KEY_ID = randomUUID();

/**
 * ISS-12552: every API-key write through the
 * real routes leaves one receipt, the harness call id is stored only for a
 * request the MCP server actually sent, and the outcome is what the write
 * actually changed.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 operation receipts on API-key writes",
  () => {
    afterEach(async () => {
      await Promise.all(auth.scheduled.splice(0));
      vi.restoreAllMocks();
      auth.context = null;
      flag.offOrganizationIds.clear();
      // Receipts carry no foreign key, so the organization delete leaves them.
      const organizationIds = auth.organizationIds.splice(0);
      await withDb((db) =>
        db.artifactOperationReceipt.deleteMany({
          where: { organizationId: { in: organizationIds } },
        })
      );
      await tracker.cleanup();
    });

    it("records one receipt per write, with what each write changed", async () => {
      const fixture = await seedFixture();
      // Stands in for the Liveblocks write and its projection, and records the
      // receipt in a transaction the way the real projection does.
      vi.spyOn(
        commentsService,
        "createArtifactLevelDocumentThread"
      ).mockImplementation(
        async (_organizationId, _slug, _userId, _body, recordCreated) => {
          const created = { threadId: "th_iss12552", commentId: randomUUID() };
          await withDb.tx(
            (tx) =>
              recordCreated?.(tx, {
                ...created,
                commentRowId: COMMENT_ROW_ID,
              }) ?? Promise.resolve()
          );
          return created;
        }
      );

      const created = await createDocument(
        jsonRequest("POST", "/documents", "toolu_create", {
          type: DocumentType.Prd,
          title: "Attribution receipts",
          content: "first",
          projectId: fixture.projectId,
        }),
        routeParams({})
      );
      expect(created.status).toBe(200);
      const document = await readData(created);
      const documentId = String(document.id);

      for (const callId of ["toolu_version", "toolu_version_again"]) {
        const response = await createVersion(
          jsonRequest("POST", `/documents/${documentId}/versions`, callId, {
            content: "second",
          }),
          routeParams({ id: documentId })
        );
        expect(response.status).toBe(200);
      }

      const updated = await updateDocument(
        jsonRequest("PUT", `/documents/${documentId}`, "toolu_update", {
          fileName: "attribution.md",
        }),
        routeParams({ id: documentId })
      );
      expect(updated.status).toBe(200);

      const commented = await createThread(
        jsonRequest(
          "POST",
          `/documents/${documentId}/threads`,
          "toolu_comment",
          {
            body: "Looks right.",
          }
        ),
        routeParams({ id: documentId })
      );
      expect(commented.status).toBe(200);

      const forged = await createDocument(
        jsonRequest(
          "POST",
          "/documents",
          "toolu_forged",
          {
            type: DocumentType.Prd,
            title: "Forged secret",
            content: "other",
            projectId: fixture.projectId,
          },
          FORGED_SECRET
        ),
        routeParams({})
      );
      expect(forged.status).toBe(200);
      const otherId = String((await readData(forged)).id);

      const linked = await createLink(
        jsonRequest("POST", "/artifact-links", "toolu_link", {
          sourceId: documentId,
          targetId: otherId,
          linkType: LinkType.Produces,
        }),
        routeParams({})
      );
      expect(linked.status).toBe(200);

      const receipts = await readReceipts(fixture.organizationId);
      const mcp = {
        source: OperationSource.Mcp,
        principalUserId: fixture.userId,
        apiKeyId: API_KEY_ID,
        commentId: null,
      };
      expect(receipts).toEqual([
        {
          ...mcp,
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: documentId,
          createdArtifactId: documentId,
          versionNumber: 1,
          changedFields: [],
          clientCallId: "toolu_create",
        },
        {
          ...mcp,
          operationKind: OperationKind.CreateVersion,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: documentId,
          createdArtifactId: null,
          versionNumber: 2,
          changedFields: ["content"],
          clientCallId: "toolu_version",
        },
        {
          ...mcp,
          operationKind: OperationKind.CreateVersion,
          outcome: OperationReceiptOutcome.NoOp,
          targetArtifactId: documentId,
          createdArtifactId: null,
          versionNumber: 3,
          changedFields: [],
          clientCallId: "toolu_version_again",
        },
        {
          ...mcp,
          operationKind: OperationKind.UpdateFields,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: documentId,
          createdArtifactId: null,
          versionNumber: null,
          changedFields: ["fileName"],
          clientCallId: "toolu_update",
        },
        {
          ...mcp,
          operationKind: OperationKind.Comment,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: documentId,
          createdArtifactId: null,
          versionNumber: null,
          changedFields: [],
          clientCallId: "toolu_comment",
          commentId: COMMENT_ROW_ID,
        },
        {
          ...mcp,
          source: OperationSource.Api,
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: otherId,
          createdArtifactId: otherId,
          versionNumber: 1,
          changedFields: [],
          clientCallId: null,
        },
        {
          ...mcp,
          operationKind: OperationKind.LinkCreate,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: documentId,
          createdArtifactId: null,
          versionNumber: null,
          changedFields: [],
          clientCallId: "toolu_link",
        },
      ]);
      const [createReceipt] = await readReceiptIds(fixture.organizationId);
      expect(document.operationReceipt).toEqual({
        operationId: `clop_${createReceipt}`,
        outcome: OperationReceiptOutcome.Committed,
      });
    });

    it("records receipts only for the organization the flag is on for", async () => {
      const off = await seedFixture();
      flag.offOrganizationIds.add(off.organizationId);
      const offWrites = await writeDocumentVersionAndSelfLink(off, "off");
      const on = await seedFixture();
      const onWrites = await writeDocumentVersionAndSelfLink(on, "on");

      expect(offWrites.statuses).toEqual([200, 200, 400]);
      expect(onWrites.statuses).toEqual([200, 200, 400]);
      for (const body of offWrites.bodies) {
        expect(body).not.toHaveProperty("operationReceipt");
      }
      for (const body of onWrites.bodies) {
        expect(body).toHaveProperty("operationReceipt");
      }
      expect(await readReceipts(off.organizationId)).toEqual([]);
      expect(
        (await readReceipts(on.organizationId)).map((receipt) => [
          receipt.operationKind,
          receipt.outcome,
        ])
      ).toEqual([
        [OperationKind.Create, OperationReceiptOutcome.Committed],
        [OperationKind.CreateVersion, OperationReceiptOutcome.Committed],
        [OperationKind.LinkCreate, OperationReceiptOutcome.Rejected],
      ]);
    });
  }
);

async function seedFixture() {
  const organizationId = await tracker.create();
  auth.organizationIds.push(organizationId);
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  auth.context = createTestAuthContext({
    user: { ...user, organizationId },
    authMethod: "api_key",
    apiKeyScopes: ["read", "write"],
    apiKeyId: API_KEY_ID,
  });
  return {
    organizationId,
    userId: user.id,
    projectId,
    context: auth.context,
  };
}

function jsonRequest(
  method: string,
  path: string,
  clientCallId: string,
  body: unknown,
  internalSecret: string = INTERNAL_SECRET
): NextRequest {
  return new NextRequest(`http://localhost:3002${path}`, {
    method,
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": internalSecret,
      [OperationEvidenceHeader.McpClient]: MCP_CLIENT_HEADER_VALUE,
      [OperationEvidenceHeader.ClientCallId]: clientCallId,
    },
  });
}

function routeParams<T>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

async function readData(response: Response): Promise<Record<string, unknown>> {
  const json: { data: Record<string, unknown> } = await response.json();
  return json.data;
}

function readReceipts(organizationId: string) {
  return withDb((db) =>
    db.artifactOperationReceipt.findMany({
      where: { organizationId },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      select: {
        source: true,
        principalUserId: true,
        apiKeyId: true,
        operationKind: true,
        outcome: true,
        targetArtifactId: true,
        createdArtifactId: true,
        versionNumber: true,
        changedFields: true,
        clientCallId: true,
        commentId: true,
      },
    })
  );
}

/** The comment's own row id, which a comment receipt records. */
const COMMENT_ROW_ID = "01a16500-0000-7000-8000-00000000c0de";

async function readReceiptIds(organizationId: string): Promise<string[]> {
  const rows = await withDb((db) =>
    db.artifactOperationReceipt.findMany({
      where: { organizationId },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      select: { id: true },
    })
  );
  return rows.map((row) => row.id);
}

/**
 * A created document, a new version of it, and a refused self-link, each an
 * MCP write carrying a call id, as the fixture's caller.
 */
async function writeDocumentVersionAndSelfLink(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  callPrefix: string
): Promise<{ statuses: number[]; bodies: Record<string, unknown>[] }> {
  auth.context = fixture.context;
  const created = await createDocument(
    jsonRequest("POST", "/documents", `${callPrefix}_create`, {
      type: DocumentType.Prd,
      title: `Flag ${callPrefix}`,
      content: "first",
      projectId: fixture.projectId,
    }),
    routeParams({})
  );
  const document = await readData(created);
  const documentId = String(document.id);
  const versioned = await createVersion(
    jsonRequest(
      "POST",
      `/documents/${documentId}/versions`,
      `${callPrefix}_version`,
      { content: "second" }
    ),
    routeParams({ id: documentId })
  );
  const linked = await createLink(
    jsonRequest("POST", "/artifact-links", `${callPrefix}_link`, {
      sourceId: documentId,
      targetId: documentId,
      linkType: LinkType.RelatesTo,
    }),
    routeParams({})
  );
  return {
    statuses: [created.status, versioned.status, linked.status],
    bodies: [document, await readData(versioned)],
  };
}
