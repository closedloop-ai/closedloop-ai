/**
 * ISS-6757: a real-Postgres proof that the name-level inventory predicate is
 * case-insensitive EQUALITY and not an ILIKE pattern.
 *
 * The unit tests beside this file assert the `where` OBJECT
 * `nameLevelInventoryWhere` builds. They cannot see the half that actually
 * matters: what Prisma compiles `equals` + `mode: "insensitive"` INTO, and
 * whether a backslash in the bound value is the escape character Postgres reads
 * it as. Both are the premise `escapeSqlLikeLiteral` rests on, and if the
 * premise were wrong the failure would be SILENT and total — every
 * `mcp__*`-keyed component would resolve to zero inventory rows and lose its
 * versions, Collaborators and attributed invocations with no error anywhere.
 *
 * So this drives the predicate the production read uses, taken from
 * `resolveDetailIdentityScope`, against real rows: the exact key and a
 * wildcard neighbour that differs from it only where the `_`s are.
 */
import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDetailIdentityScope } from "./content-hash-identity";

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const COMPUTE_TARGET_ID = randomUUID();
const KIND = "mcp_tool";

const EXACT_KEY = "mcp__closedloop__ping";
// Differs from EXACT_KEY only at the four `_` positions, so an unescaped
// `ILIKE 'mcp__closedloop__ping'` matches it too.
const WILDCARD_NEIGHBOUR = "mcpXXclosedloopYYping";
// Same key, raw case: the reason the predicate is case-insensitive at all
// (event-minted rows store the raw-case type, FEA-3750). Escaping must not cost
// this match.
const RAW_CASE_KEY = "MCP__CLOSEDLOOP__PING";

const seeded = new Map<string, string>();

describe.skipIf(!process.env.DATABASE_URL)(
  "nameLevelInventoryWhere against real Postgres (ISS-6757)",
  () => {
    beforeAll(async () => {
      await withDb(async (db) => {
        await db.organization.create({
          data: {
            id: ORG_ID,
            clerkId: `clerk_org_${ORG_ID}`,
            name: "ISS-6757 identity org",
            slug: `iss6757-identity-${ORG_ID}`,
          },
          select: { id: true },
        });
        await db.user.create({
          data: {
            id: USER_ID,
            organizationId: ORG_ID,
            clerkId: `clerk_user_${USER_ID}`,
            email: "iss6757.identity@example.com",
          },
          select: { id: true },
        });
        await db.computeTarget.create({
          data: {
            id: COMPUTE_TARGET_ID,
            organizationId: ORG_ID,
            userId: USER_ID,
            machineName: "iss6757-identity",
            platform: "darwin",
          },
          select: { id: true },
        });
        for (const key of [EXACT_KEY, WILDCARD_NEIGHBOUR, RAW_CASE_KEY]) {
          const id = randomUUID();
          seeded.set(key, id);
          await db.agentComponent.create({
            data: {
              id,
              organizationId: ORG_ID,
              computeTargetId: COMPUTE_TARGET_ID,
              componentKind: KIND,
              externalComponentId: `${KIND}:${key}`,
              name: key,
              componentKey: key,
            },
            select: { id: true },
          });
        }
      });
    });

    afterAll(async () => {
      // Same order the FEA-2923 real-DB suite uses: children first, org last —
      // `users.organization_id` is RESTRICT, so the org delete alone would fail.
      await withDb(async (db) => {
        await db.agentComponent.deleteMany({
          where: { organizationId: ORG_ID },
        });
        await db.computeTarget.deleteMany({
          where: { organizationId: ORG_ID },
        });
        await db.user.deleteMany({ where: { organizationId: ORG_ID } });
        await db.organization.deleteMany({ where: { id: ORG_ID } });
      });
    });

    it("matches the exact key and its raw-case spelling, never the wildcard neighbour", async () => {
      const matched = await withDb(async (db) => {
        const scope = await resolveDetailIdentityScope(
          db,
          ORG_ID,
          KIND,
          null,
          EXACT_KEY
        );
        const rows = await db.agentComponent.findMany({
          where: {
            organizationId: ORG_ID,
            componentKind: KIND,
            ...scope.inventoryWhere,
          },
          select: { componentKey: true },
        });
        return rows.map((row) => row.componentKey).sort();
      });

      expect(matched).toEqual([RAW_CASE_KEY, EXACT_KEY].sort());
    });
  }
);
