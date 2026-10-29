/**
 * ISS-9939 / ISS-10262 (marisolashgrove, PR #7289 review) — the Status column
 * SORT compares the raw persisted `artifacts.status` string against a REAL
 * Postgres `ORDER BY`, not a mocked `findMany`. `list-status-sort.test.ts`
 * mocks `findMany` to `[]` and pins only the orderBy SHAPE it is called with;
 * it cannot observe what the database actually does with a stored value
 * outside the three-member lifecycle set.
 *
 * That population is real, not hypothetical: the ISS-5981 migration
 * deliberately leaves a LIVE-AND-ANCHORLESS session (`sessionEndedAt` null,
 * `awaitingInputSince` null) storing the literal `waiting`, permanently, and
 * no later migration drains it. `session-working-set-sort.ts` used to fold
 * that literal (and any unrecognized future spelling) to Active on the
 * desktop side alone, on the false premise that cloud's column was "already
 * normalized" — reopening the exact cross-surface drift ISS-9939 closed,
 * on this one residual population. Both surfaces now compare the raw string
 * with no fold; this suite pins what that raw comparison actually returns
 * from the database.
 */

import { randomUUID } from "node:crypto";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
// Committed, not rolled back: `findSessions` opens its own RepeatableRead
// snapshot (ISS-12881), and `withDb.tx` refuses an isolation level inside an
// ambient transaction (ISS-4669).
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

async function seedSession(
  organizationId: string,
  userId: string,
  computeTargetId: string,
  externalSessionId: string,
  status: string
): Promise<void> {
  await withDb((db) =>
    db.artifact.create({
      data: {
        createdById: userId,
        name: `ISS-10262 status sort session ${externalSessionId}`,
        organizationId,
        // Freeform column (schema: "Intentionally NOT bound to a DB enum") —
        // a literal outside SESSION_STATUS's three members is a REAL,
        // reachable persisted value, not a type error.
        status,
        type: ArtifactType.SESSION,
        session: {
          create: {
            computeTarget: { connect: { id: computeTargetId } },
            errorCount: 0,
            estimatedCost: "0.000000",
            externalSessionId,
            harness: "claude",
            inputTokens: 0,
            lastActivityAt: new Date("2026-06-10T09:00:00.000Z"),
            model: "claude-opus-4",
            outputTokens: 0,
            sessionStartedAt: new Date("2026-06-10T09:00:00.000Z"),
            sessionUpdatedAt: new Date("2026-06-10T09:00:00.000Z"),
          },
        },
      },
      select: { id: true },
    })
  );
}

describeIfDb(
  "ISS-9939 / ISS-10262 status sort against real Postgres (marisolashgrove, #7289 review)",
  () => {
    it("orders a residual `waiting` literal and an unrecognized spelling by their own raw string, not folded into Active", async () => {
      await committedOrganizations.run(async () => {
        const organizationId = await committedOrganizations.create();
        const user = await createTestUser(organizationId);
        const computeTarget = await withDb((db) =>
          db.computeTarget.create({
            data: {
              machineName: "iss10262-status-sort-machine",
              organizationId,
              platform: "darwin",
              userId: user.id,
            },
            select: { id: true },
          })
        );

        const suffix = randomUUID().slice(0, 8);
        const active = `iss10262-active-${suffix}`;
        const error = `iss10262-error-${suffix}`;
        const inactive = `iss10262-inactive-${suffix}`;
        // The ISS-5981 residual population: live, anchorless, still literal.
        const waitingLiteral = `iss10262-waiting-${suffix}`;
        const unrecognized = `iss10262-unrecognized-${suffix}`;

        await seedSession(
          organizationId,
          user.id,
          computeTarget.id,
          active,
          SESSION_STATUS.ACTIVE
        );
        await seedSession(
          organizationId,
          user.id,
          computeTarget.id,
          error,
          SESSION_STATUS.ERROR
        );
        await seedSession(
          organizationId,
          user.id,
          computeTarget.id,
          inactive,
          SESSION_STATUS.INACTIVE
        );
        await seedSession(
          organizationId,
          user.id,
          computeTarget.id,
          waitingLiteral,
          "waiting"
        );
        await seedSession(
          organizationId,
          user.id,
          computeTarget.id,
          unrecognized,
          "some-future-status"
        );

        const ascending = await agentSessionsService.findSessions({
          organizationId,
          filters: { sortBy: "status", sortDir: "asc", quality: "all" },
        });
        // Raw lexicographic order: active < error < inactive <
        // some-future-status < waiting. Neither residual value sorts with
        // "active" — folding either one back into Active would be exactly the
        // regression this suite exists to catch.
        expect(ascending.items.map((item) => item.externalSessionId)).toEqual([
          active,
          error,
          inactive,
          unrecognized,
          waitingLiteral,
        ]);

        const descending = await agentSessionsService.findSessions({
          organizationId,
          filters: { sortBy: "status", sortDir: "desc", quality: "all" },
        });
        expect(descending.items.map((item) => item.externalSessionId)).toEqual([
          waitingLiteral,
          unrecognized,
          inactive,
          error,
          active,
        ]);
      });
    });
  }
);
