/**
 * ISS-8193: a real-Postgres proof that `loadSkillShadowInventory` survives a
 * name set past the bind-parameter ceiling.
 *
 * The unit suite beside this file asserts the `where` OBJECTS the production
 * code emits. It cannot see the half that actually decides whether a session
 * ingests: what Prisma does when ONE statement's predicate wants more bind
 * parameters than it will emit. Measured on this stack (Prisma 7.8 /
 * `@prisma/adapter-pg` / PostgreSQL 16), that is not a slow query and not a
 * truncated read — Prisma refuses the operation outright with P2029 ("the query
 * parameter limit supported by your database is exceeded"), the surrounding
 * session-upsert transaction rolls back, and the desktop retries the identical
 * permanently-failing payload forever.
 *
 * {@link NAMES_PAST_THE_STATEMENT_CEILING} is the measured refusal, not a
 * round number chosen for comfort: driving this same predicate unsliced, 32,700
 * distinct names still succeeded but cost 537 statements as Prisma split what it
 * could, and 32,762 was already refused with P2029. A fixture below that is
 * green against the unfixed code and proves nothing.
 */
import { randomUUID } from "node:crypto";
import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import { withDb } from "@repo/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSkillShadowInventory } from "./skill-shadow";

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const COMPUTE_TARGET_ID = randomUUID();

/**
 * Distinct bare names one payload carries. Two bind parameters each, so the
 * unsliced predicate wanted 66,005 — past what Prisma will emit for one
 * statement and past what it can split its way out of.
 */
const NAMES_PAST_THE_STATEMENT_CEILING = 33_000;

const SHADOWED_SKILL = "iss8193-shadowed-skill";
const GENUINE_COMMAND = "iss8193-genuine-command";
const DEFINED_COMMAND = "iss8193-defined-command";

const LOW_ID = "00000000-0000-7000-8000-00000000aaaa";
const HIGH_ID = "00000000-0000-7000-8000-00000000bbbb";

function payloadBareNames(): string[] {
  const names = Array.from(
    { length: NAMES_PAST_THE_STATEMENT_CEILING - 3 },
    (_, index) => `iss8193-filler-${index}`
  );
  // The rows that must survive the slicing sit at the very end, so a loop that
  // drops its last partial slice loses all three rather than none.
  names.push(SHADOWED_SKILL, GENUINE_COMMAND, DEFINED_COMMAND);
  return names;
}

async function seedComponent(
  db: Awaited<Parameters<Parameters<typeof withDb>[0]>[0]>,
  row: {
    componentKey: string;
    componentKind: string;
    content?: string;
    id?: string;
    // The canonical contract rather than a re-declared literal union
    // (davetho review), so a seed can never drift from the state the
    // production filter matches while typecheck stays green.
    resolvedState?: ComponentResolvedState;
  }
) {
  await db.agentComponent.create({
    data: {
      componentKey: row.componentKey,
      componentKind: row.componentKind,
      computeTargetId: COMPUTE_TARGET_ID,
      content: row.content ?? null,
      externalComponentId: `${row.componentKind}:${row.componentKey}:${row.id ?? "one"}`,
      id: row.id ?? randomUUID(),
      name: row.componentKey,
      organizationId: ORG_ID,
      resolvedState: row.resolvedState ?? ComponentResolvedState.Unresolved,
    },
    select: { id: true },
  });
}

describe.skipIf(!process.env.DATABASE_URL)(
  "loadSkillShadowInventory past the bind ceiling (ISS-8193)",
  () => {
    beforeAll(async () => {
      await withDb(async (db) => {
        await db.organization.create({
          data: {
            clerkId: `clerk_org_${ORG_ID}`,
            id: ORG_ID,
            name: "ISS-8193 bind ceiling org",
            slug: `iss8193-bind-ceiling-${ORG_ID}`,
          },
          select: { id: true },
        });
        await db.user.create({
          data: {
            clerkId: `clerk_user_${USER_ID}`,
            email: "iss8193.bind.ceiling@example.com",
            id: USER_ID,
            organizationId: ORG_ID,
          },
          select: { id: true },
        });
        await db.computeTarget.create({
          data: {
            id: COMPUTE_TARGET_ID,
            machineName: "iss8193-bind-ceiling",
            organizationId: ORG_ID,
            platform: "darwin",
            userId: USER_ID,
          },
          select: { id: true },
        });
        // The same skill key installed at two scopes, so the lowest-`id`
        // tie-break is exercised against real rows and not only the double.
        await seedComponent(db, {
          componentKey: SHADOWED_SKILL,
          componentKind: AgentComponentKind.Skill,
          id: HIGH_ID,
          resolvedState: ComponentResolvedState.Resolved,
        });
        await seedComponent(db, {
          componentKey: SHADOWED_SKILL,
          componentKind: AgentComponentKind.Skill,
          id: LOW_ID,
          resolvedState: ComponentResolvedState.Resolved,
        });
        await seedComponent(db, {
          componentKey: `/${GENUINE_COMMAND}`,
          componentKind: AgentComponentKind.Command,
          resolvedState: ComponentResolvedState.Resolved,
        });
        await seedComponent(db, {
          componentKey: `/${DEFINED_COMMAND}`,
          componentKind: AgentComponentKind.Command,
          content: "# a real .claude/commands file",
          resolvedState: ComponentResolvedState.Unresolved,
        });
      });
    });

    afterAll(async () => {
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

    it("resolves the inventory a payload past the ceiling asks for", async () => {
      const inventory = await withDb.tx((tx) =>
        loadSkillShadowInventory(tx, COMPUTE_TARGET_ID, payloadBareNames())
      );

      expect(inventory.resolvedSkills.get(SHADOWED_SKILL)).toMatchObject({
        id: LOW_ID,
      });
      expect(inventory.resolvedCommandKeys.has(`/${GENUINE_COMMAND}`)).toBe(
        true
      );
      expect(inventory.definedCommandKeys.has(`/${DEFINED_COMMAND}`)).toBe(
        true
      );
      // The evidence the shared phantom predicate actually reads, so a slice
      // loop that collected the sets but never collapsed them is visible here.
      expect(inventory.evidence.resolvedSkillNames.has(SHADOWED_SKILL)).toBe(
        true
      );
      expect(
        inventory.evidence.vouchedCommandKeys.has(`/${DEFINED_COMMAND}`)
      ).toBe(true);
    });

    it("reports no inventory for names this target does not have", async () => {
      const inventory = await withDb.tx((tx) =>
        loadSkillShadowInventory(
          tx,
          COMPUTE_TARGET_ID,
          Array.from(
            { length: NAMES_PAST_THE_STATEMENT_CEILING },
            (_, index) => `iss8193-absent-${index}`
          )
        )
      );

      expect(inventory.resolvedSkills.size).toBe(0);
      expect(inventory.evidence.vouchedCommandKeys.size).toBe(0);
    });
  }
);
