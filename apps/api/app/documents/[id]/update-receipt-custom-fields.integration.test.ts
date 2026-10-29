import { randomUUID } from "node:crypto";
import {
  MCP_CLIENT_HEADER_VALUE,
  OperationEvidenceHeader,
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import { CUSTOM_FIELD_CHANGE_PREFIX } from "@/lib/operation-receipts/changed-fields";

const state = vi.hoisted(() => ({
  context: null as AuthContext | null,
  scheduled: [] as Promise<unknown>[],
}));

// ISS-12552: receipts are recorded only while attribution-evidence-policy is on.
vi.mock(
  "@/lib/attribution-evidence-policy-feature",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attribution-evidence-policy-feature")
    >()),
    isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  })
);
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context?: { params: Promise<unknown> }) =>
      handler(state.context, request, context?.params),
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    state.scheduled.push(work);
  },
}));

import { PUT as updateDocument } from "@/app/documents/[id]/route";
import { createDocumentRecord } from "@/app/documents/document-service";
import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";

const organizations = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
const customFieldIds = new Set<string>();
const API_KEY_ID = randomUUID();

/**
 * ISS-12552: a document update and the custom fields it sets commit together,
 * with one receipt whose changed fields are read inside that transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document update receipt with custom fields",
  () => {
    afterEach(async () => {
      await Promise.all(state.scheduled.splice(0));
      vi.restoreAllMocks();
      state.context = null;
      const orgIds = organizationIds.splice(0);
      await withDb(async (db) => {
        await db.artifactOperationReceipt.deleteMany({
          where: { organizationId: { in: orgIds } },
        });
        await db.customFieldValue.deleteMany({
          where: { customFieldId: { in: [...customFieldIds] } },
        });
        await db.customField.deleteMany({
          where: { id: { in: [...customFieldIds] } },
        });
      });
      customFieldIds.clear();
      await organizations.cleanup();
    });

    it("rolls the whole update back when a custom field is refused mid-apply", async () => {
      const world = await seedWorld();
      const textFieldId = await seedField(world, CustomFieldType.Text);
      const enumFieldId = await seedField(world, CustomFieldType.Enum);
      // A value can turn invalid between the preflight and the write (a
      // reference target deleted meanwhile); skipping the preflight puts the
      // refusal on the write path.
      vi.spyOn(
        customFieldValuesService,
        "validateValueForEntity"
      ).mockResolvedValue(undefined);

      const response = await updateDocument(
        putRequest(world.documentId, "toolu_refused", {
          title: "Renamed",
          customFields: {
            [textFieldId]: "applied first",
            [enumFieldId]: randomUUID(),
          },
        }),
        { params: Promise.resolve({ id: world.documentId }) }
      );

      expect(response.status).toBe(400);
      const stored = await withDb(async (db) => ({
        title: (
          await db.artifact.findUniqueOrThrow({
            where: { id: world.documentId },
            select: { name: true },
          })
        ).name,
        values: await db.customFieldValue.count({
          where: { entityId: world.documentId },
        }),
      }));
      expect(stored).toEqual({ title: "Original", values: 0 });
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.UpdateFields,
          outcome: OperationReceiptOutcome.Rejected,
          changedFields: [],
          clientCallId: "toolu_refused",
        },
      ]);
    });

    it("does not count a custom field another request changed first", async () => {
      const world = await seedWorld();
      const fieldId = await seedField(world, CustomFieldType.Text);
      const valueId = await seedTextValue(world, fieldId, "before");
      const updateDocumentWrite =
        documentStatusMutationService.updateDocument.bind(
          documentStatusMutationService
        );
      vi.spyOn(
        documentStatusMutationService,
        "updateDocument"
      ).mockImplementation(async (...args) => {
        await commitOnSeparateConnection(valueId, "after");
        return updateDocumentWrite(...args);
      });

      const response = await updateDocument(
        putRequest(world.documentId, "toolu_concurrent", {
          title: "Renamed",
          customFields: { [fieldId]: "after" },
        }),
        { params: Promise.resolve({ id: world.documentId }) }
      );

      expect(response.status).toBe(200);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.UpdateFields,
          outcome: OperationReceiptOutcome.Committed,
          changedFields: ["title"],
          clientCallId: "toolu_concurrent",
        },
      ]);
    });

    it("names a custom field this request moved", async () => {
      const world = await seedWorld();
      const fieldId = await seedField(world, CustomFieldType.Text);
      await seedTextValue(world, fieldId, "before");

      const response = await updateDocument(
        putRequest(world.documentId, "toolu_moved", {
          customFields: { [fieldId]: "after" },
        }),
        { params: Promise.resolve({ id: world.documentId }) }
      );

      expect(response.status).toBe(200);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.UpdateFields,
          outcome: OperationReceiptOutcome.Committed,
          changedFields: [`${CUSTOM_FIELD_CHANGE_PREFIX}${fieldId}`],
          clientCallId: "toolu_moved",
        },
      ]);
    });
  }
);

async function seedWorld() {
  const organizationId = await organizations.create();
  organizationIds.push(organizationId);
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  state.context = createTestAuthContext({
    user: { ...user, organizationId },
    authMethod: "api_key",
    apiKeyScopes: ["read", "write"],
    apiKeyId: API_KEY_ID,
  });
  const document = await withDb.tx((tx) =>
    createDocumentRecord(tx, organizationId, user.id, {
      content: "Integration content",
      projectId,
      status: DocumentStatus.Draft,
      title: "Original",
      type: DocumentType.Prd,
    })
  );
  if (!document) {
    throw new Error("Failed to seed the ISS-12552 document");
  }
  return { organizationId, documentId: document.id };
}

async function seedField(
  world: { organizationId: string },
  fieldType: CustomFieldType
): Promise<string> {
  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId: world.organizationId,
        name: `ISS-12552 ${fieldType} ${randomUUID()}`,
        fieldType,
        entityTypes: [CustomFieldEntityType.Document],
      },
    })
  );
  customFieldIds.add(field.id);
  return field.id;
}

async function seedTextValue(
  world: { organizationId: string; documentId: string },
  fieldId: string,
  value: string
): Promise<string> {
  const row = await withDb((db) =>
    db.customFieldValue.create({
      data: {
        customFieldId: fieldId,
        organizationId: world.organizationId,
        entityType: CustomFieldEntityType.Document,
        entityId: world.documentId,
        textValue: value,
        displayValue: value,
        multiEnumValueIds: [],
        peopleValueIds: [],
      },
    })
  );
  return row.id;
}

/** Another request's write, committed while this one is in flight. */
async function commitOnSeparateConnection(
  valueId: string,
  value: string
): Promise<void> {
  const client = new Client({ connectionString: keys().DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "UPDATE custom_field_values SET text_value = $1, display_value = $1 WHERE id = $2::uuid",
      [value, valueId]
    );
  } finally {
    await client.end();
  }
}

function putRequest(
  documentId: string,
  clientCallId: string,
  body: unknown
): NextRequest {
  return new NextRequest(`http://localhost:3002/documents/${documentId}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": "test-internal-secret",
      [OperationEvidenceHeader.McpClient]: MCP_CLIENT_HEADER_VALUE,
      [OperationEvidenceHeader.ClientCallId]: clientCallId,
    },
  });
}

function readReceipts(organizationId: string) {
  return withDb((db) =>
    db.artifactOperationReceipt.findMany({
      where: { organizationId },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      select: {
        operationKind: true,
        outcome: true,
        changedFields: true,
        clientCallId: true,
      },
    })
  );
}
