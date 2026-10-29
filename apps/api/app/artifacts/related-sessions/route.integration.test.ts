/**
 * ISS-9572 — `POST /artifacts/related-sessions` against Postgres, through the
 * real route, service and batch SQL.
 *
 * Every negative is paired with the positive sibling from the same fixture, so
 * an empty or failed read cannot satisfy it. The foreign session ids count as
 * leaked navigation targets: the host adapters build a session's link from
 * `sessionArtifactId`, so no id in the body means no link to it.
 */
import type { RelatedSessionsBatchResponse } from "@repo/api/src/types/related-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it, vi } from "vitest";
import {
  createDocumentArtifact,
  createRelatedSessionLink,
} from "@/__tests__/support/agent-sessions/related-session.test-fixtures";
import {
  createMockRequest,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (auth: AuthContext, request: Request) => Promise<Response>) =>
    (request: Request) =>
      handler(mockAuthContext, request),
}));

import { POST } from "./route";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb(
  "POST /artifacts/related-sessions against Postgres (ISS-9572)",
  () => {
    it("omits another org's artifact and sessions from a mixed-scope id set, rows and navigation targets alike", async () => {
      await autoRollbackTransaction(async () => {
        const orgA = await createTestOrganization();
        const orgB = await createTestOrganization();
        const userA = await createTestUser(orgA, CALLER_OWNER);
        const userB = await createTestUser(orgB, FOREIGN_OWNER);
        const sessionA = await withSlug(
          createTestSessionDetail({
            organizationId: orgA,
            userId: userA.id,
            label: "caller-a",
          }),
          SLUG.callerSession
        );
        const sessionB1 = await withSlug(
          createTestSessionDetail({
            organizationId: orgB,
            userId: userB.id,
            label: "foreign-b1",
          }),
          SLUG.foreignSessionB1
        );
        const sessionB2 = await withSlug(
          createTestSessionDetail({
            organizationId: orgB,
            userId: userB.id,
            label: "foreign-b2",
          }),
          SLUG.foreignSessionB2
        );
        const docA = await withSlug(
          createDocumentArtifact(orgA, "caller-doc-a"),
          SLUG.callerDoc
        );
        const docEmpty = await withSlug(
          createDocumentArtifact(orgA, "caller-doc-empty"),
          SLUG.callerEmptyDoc
        );
        const docB = await withSlug(
          createDocumentArtifact(orgB, "foreign-doc-b"),
          SLUG.foreignDoc
        );

        await createRelatedSessionLink({
          organizationId: orgA,
          sourceId: sessionA,
          targetId: docA,
          contributedAt: "2026-09-18T10:00:00.000Z",
        });
        // The cross-org edge: an org-A link from an org-B session, newer than
        // the legitimate one so a leak would sort first.
        await createRelatedSessionLink({
          organizationId: orgA,
          sourceId: sessionB1,
          targetId: docA,
          contributedAt: "2026-09-18T11:00:00.000Z",
        });
        // A legitimate org-B relationship the caller must not reach by guessing
        // docB's id.
        await createRelatedSessionLink({
          organizationId: orgB,
          sourceId: sessionB2,
          targetId: docB,
          contributedAt: "2026-09-18T12:00:00.000Z",
        });

        mockAuthContext = createTestAuthContext({ user: userA });
        const response = await POST(
          createMockRequest({
            url: "http://localhost:3002/artifacts/related-sessions",
            method: "POST",
            body: { artifactIds: [docA, docEmpty, docB, sessionA] },
          }),
          { params: Promise.resolve({}) }
        );
        const body = await response.text();
        const envelope: BatchEnvelope = JSON.parse(body);
        const results = envelope.data?.results ?? {};

        expect(response.status).toBe(200);
        expect(envelope.success).toBe(true);
        // docB is omitted as foreign and sessionA as unsupported; docEmpty's
        // present-but-empty key proves the omissions are org and type, not a
        // read that returned nothing.
        expect(Object.keys(results).sort()).toEqual([docA, docEmpty].sort());
        expect(
          results[docA]?.items.map((item) => item.sessionArtifactId)
        ).toEqual([sessionA]);
        expect(results[docA]?.total).toBe(1);
        expect(results[docEmpty]).toEqual({ items: [], total: 0 });

        const callerTokens = [
          docA,
          docEmpty,
          sessionA,
          SLUG.callerSession,
          ...(await readArtifactNames([sessionA])),
          userA.id,
          CALLER_OWNER.firstName,
          CALLER_OWNER.lastName,
        ];
        const foreignTokens = [
          docB,
          sessionB1,
          sessionB2,
          SLUG.foreignDoc,
          SLUG.foreignSessionB1,
          SLUG.foreignSessionB2,
          ...(await readArtifactNames([docB, sessionB1, sessionB2])),
          userB.id,
          FOREIGN_OWNER.firstName,
          FOREIGN_OWNER.lastName,
        ];
        expect(callerTokens.filter((token) => !body.includes(token))).toEqual(
          []
        );
        expect(foreignTokens.filter((token) => body.includes(token))).toEqual(
          []
        );
      });
    });
  }
);

type BatchEnvelope = {
  success: boolean;
  data?: RelatedSessionsBatchResponse;
};

const CALLER_OWNER = { firstName: "Alice", lastName: "Insider" } as const;
const FOREIGN_OWNER = { firstName: "Mallory", lastName: "Outsider" } as const;

/**
 * Neither seeder allocates a slug, so each fixture gets an explicit one; a
 * null slug would leave the slug arm of the identity check asserting nothing.
 */
const SLUG = {
  callerDoc: "PRD-CALLER-A",
  callerEmptyDoc: "PRD-CALLER-EMPTY",
  callerSession: "SES-CALLER-A",
  foreignDoc: "PRD-FOREIGN-B",
  foreignSessionB1: "SES-FOREIGN-B1",
  foreignSessionB2: "SES-FOREIGN-B2",
} as const;

async function withSlug(
  created: Promise<string>,
  slug: string
): Promise<string> {
  const id = await created;
  await withDb((db) =>
    db.artifact.update({ where: { id }, data: { slug }, select: { id: true } })
  );
  return id;
}

/** The stored names, which `createTestSessionDetail` suffixes at random. */
async function readArtifactNames(
  artifactIds: readonly string[]
): Promise<string[]> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: { id: { in: [...artifactIds] } },
      select: { id: true, name: true },
    })
  );
  const nameById = new Map(rows.map((row) => [row.id, row.name]));
  return artifactIds.map((id) => {
    const name = nameById.get(id);
    if (name === undefined) {
      throw new Error(`seeded artifact ${id} was not found`);
    }
    return name;
  });
}
