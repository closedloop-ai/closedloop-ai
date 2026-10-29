import { randomUUID } from "node:crypto";
import {
  MCP_CLIENT_HEADER_VALUE,
  OperationEvidenceHeader,
} from "@repo/api/src/types/attribution-evidence";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { NextRequest } from "next/server";
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { createDocumentRecord } from "@/app/documents/document-service";

/**
 * ISS-12552: shared setup for route tests proving a write and its receipt
 * commit or roll back together. Pair with the module mocks in
 * `operation-receipt-route.test-mocks.ts`.
 */
export function createReceiptRouteHarness() {
  const organizations = createCommittedTestOrganizationTracker();
  const organizationIds: string[] = [];
  return {
    /** One org, an API-key caller in it, and a project. */
    async seedWorld() {
      const organizationId = await organizations.create();
      organizationIds.push(organizationId);
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      receiptRouteState.context = createTestAuthContext({
        user: { ...user, organizationId },
        authMethod: "api_key",
        apiKeyScopes: ["read", "write", "delete"],
        apiKeyId: randomUUID(),
      });
      return { organizationId, userId: user.id, projectId };
    },
    /** A PRD in the world's project, written without a receipt. */
    async seedDocument(
      world: { organizationId: string; userId: string; projectId: string },
      title: string
    ): Promise<string> {
      const document = await withDb.tx((tx) =>
        createDocumentRecord(tx, world.organizationId, world.userId, {
          content: "Receipt rollback content",
          projectId: world.projectId,
          status: DocumentStatus.Draft,
          title,
          type: DocumentType.Prd,
        })
      );
      if (!document) {
        throw new Error("Failed to seed the ISS-12552 document");
      }
      return document.id;
    },
    async cleanup() {
      await Promise.all(receiptRouteState.scheduled.splice(0));
      receiptRouteState.context = null;
      receiptRouteState.failReceiptInsert = false;
      receiptRouteState.forcedFailures = 0;
      receiptRouteState.failRejectedReceiptInsert = false;
      receiptRouteState.forcedRejectedFailures = 0;
      receiptRouteState.attributionFlagOn = true;
      receiptRouteState.attributionFlagEvaluations = 0;
      const orgIds = organizationIds.splice(0);
      // Receipts carry no foreign key, so the organization delete leaves them.
      await withDb((db) =>
        db.artifactOperationReceipt.deleteMany({
          where: { organizationId: { in: orgIds } },
        })
      );
      await organizations.cleanup();
    },
  };
}

/** Every write the route makes from here on has its receipt insert fail. */
export function failReceiptInserts(): void {
  receiptRouteState.failReceiptInsert = true;
}

/**
 * How many receipt inserts the forced failure broke, so a test can tell a
 * rollback the receipt caused from an unrelated 500.
 */
export function forcedReceiptFailures(): number {
  return receiptRouteState.forcedFailures;
}

/** A request an MCP client sent with an API key. */
export function receiptRouteRequest(
  method: string,
  path: string,
  body?: unknown,
  clientCallId = `toolu_${randomUUID()}`
): NextRequest {
  return new NextRequest(`http://localhost:3002${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": "test-internal-secret",
      [OperationEvidenceHeader.McpClient]: MCP_CLIENT_HEADER_VALUE,
      [OperationEvidenceHeader.ClientCallId]: clientCallId,
    },
  });
}

export function receiptRouteParams<T>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

export function countReceipts(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.artifactOperationReceipt.count({ where: { organizationId } })
  );
}

/** Every rejected receipt the route records from here on fails to store. */
export function failRejectedReceiptInserts(): void {
  receiptRouteState.failRejectedReceiptInsert = true;
}

/** How many rejected-receipt inserts the forced failure broke. */
export function forcedRejectedReceiptFailures(): number {
  return receiptRouteState.forcedRejectedFailures;
}

/**
 * Turn `attribution-evidence-policy` off for the rest of the case. Needs the
 * module mock from `receiptRouteFlagMock`; cleanup turns it back on.
 */
export function turnAttributionFlagOff(): void {
  receiptRouteState.attributionFlagOn = false;
}

/** Turn `attribution-evidence-policy` back on for the rest of the case. */
export function turnAttributionFlagOn(): void {
  receiptRouteState.attributionFlagOn = true;
}

/** A request sent with an API key outside MCP, from a shell or script. */
export function apiKeyRouteRequest(
  method: string,
  path: string,
  body?: unknown
): NextRequest {
  return new NextRequest(`http://localhost:3002${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "Content-Type": "application/json" },
  });
}

/** Every receipt the organization holds, oldest first. */
export function readReceipts(organizationId: string) {
  return withDb((db) =>
    db.artifactOperationReceipt.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        operationKind: true,
        outcome: true,
        source: true,
        targetArtifactId: true,
        createdArtifactId: true,
        changedFields: true,
        route: true,
      },
    })
  );
}
