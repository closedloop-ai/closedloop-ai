import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  branchRef,
  pullRequestRef,
  seedPublicRepo,
} from "@/__tests__/integration/agent-session-pr-sync-helpers";
import {
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "@/__tests__/utils/db-helpers";

const mocks = vi.hoisted(() => ({
  auth: {
    clerkUserId: "clerk-route-fragment-user",
    user: {
      id: "user-route-fragment",
      organizationId: "org-route-fragment",
    },
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(mocks.auth, request),
}));

import { POST } from "./route";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb(
  "POST /desktop/agent-sessions/sync numeric fidelity (FEA-2728)",
  () => {
    // Token counts above the old int4 ceiling (2,147,483,647) and a cost above the
    // old Decimal(10,6) $9,999.999999 cap must round-trip byte-exact through
    // parse -> handler -> service -> Postgres. Tokens travel the wire as JSON
    // numbers (deliberately kept within the 2^53 safe-integer envelope, not
    // stringified) and land in BigInt (int8) columns; cost lands in Decimal(14,6).
    // This guards against any Number()/parseInt narrowing hop the widened columns
    // alone would not catch.
    it("carries >2^31 token counts and >$10k cost without truncation", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: user.id, organizationId };
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );

        const session = buildSyncedSession({
          externalSessionId: "route-numeric-fidelity-session",
          tokenUsageByModel: [
            {
              model: "claude-opus-4",
              inputTokens: 2_500_000_000,
              outputTokens: 1_000_000,
              cacheReadTokens: 3_000_000_000,
              cacheWriteTokens: 4_000_000_000,
              estimatedCostUsd: 12_345.678_901,
            },
          ],
        });

        const response = await POST(
          batchRequest(buildBatchPayload(session), computeTarget.id),
          routeContext()
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ success: true, data: { synced: true } });

        const detail = await readSessionTotals(
          computeTarget.id,
          session.externalSessionId
        );
        expect(detail).not.toBeNull();
        // Session-level totals (summed across models) land in BigInt columns
        // exactly — no int4 truncation at 3e9 / 4e9.
        expect(detail?.inputTokens).toBe(2_500_000_000n);
        expect(detail?.cacheReadTokens).toBe(3_000_000_000n);
        expect(detail?.cacheWriteTokens).toBe(4_000_000_000n);
        // Decimal(14,6) preserves a cost above the old $9,999.999999 cap.
        expect(Number(detail?.estimatedCost)).toBe(12_345.678_901);

        const usage = await readTokenUsageRow(
          detail?.artifactId ?? "",
          "claude-opus-4"
        );
        expect(usage).not.toBeNull();
        expect(usage?.inputTokens).toBe(2_500_000_000n);
        expect(usage?.cacheReadTokens).toBe(3_000_000_000n);
        expect(usage?.cacheWriteTokens).toBe(4_000_000_000n);
        expect(Number(usage?.estimatedCost)).toBe(12_345.678_901);
      });
    });
  }
);

describeIfDb(
  "POST /desktop/agent-sessions/sync legacy field tolerance (FEA-2728)",
  () => {
    it("ingests old-desktop payloads carrying removed issues / attribution.issueId", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: user.id, organizationId };
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );

        const session = buildSyncedSession({
          externalSessionId: "route-legacy-issue-fields-session",
        });
        // Simulate a pre-FEA-2728 Desktop build still emitting the removed wire
        // fields. Built as an untyped literal (not DesktopAgentSessionsPayload)
        // so it mirrors an old client without an unsafe cast; the route parses
        // raw JSON and the ingest Zod schema strips these unknown keys. FEA-2728
        // requires this to succeed, never reject with validation_failed.
        const legacyBody = {
          schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
          batchId: "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7d",
          syncMode: AgentSessionSyncMode.Incremental,
          sessionCount: 1,
          sessions: [
            {
              ...session,
              issues: ["FEA-9999"],
              attribution: {
                issueId: "FEA-9999",
                repositoryFullName: "acme/legacy",
              },
            },
          ],
        };

        const response = await POST(
          new NextRequest(
            `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${computeTarget.id}`,
            { body: JSON.stringify(legacyBody), method: "POST" }
          ),
          routeContext()
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          success: true,
          data: { synced: true },
        });

        // The session lands; the stripped legacy fields simply aren't persisted
        // (their columns are gone), while other attribution still applies.
        const detail = await readSessionRepository(
          computeTarget.id,
          session.externalSessionId
        );
        expect(detail?.repositoryFullName).toBe("acme/legacy");
      });
    });
  }
);

describeIfDb(
  "POST /desktop/agent-sessions/sync org isolation (FEA-2734 FR11)",
  () => {
    it("rejects a sync that targets another org's compute target and never cross-writes", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        // Org A is the authenticated caller. Its session-sync policy is ON so
        // the positive-control sync to its OWN target succeeds; the FEA-4169
        // org-policy gate keys off the authenticated org id (orgA).
        const orgA = await createTestOrganization();
        const userA = await createTestUser(orgA, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: userA.id, organizationId: orgA };
        const targetA = await createComputeTarget(orgA, userA.id);

        // Org B is a different tenant with its own compute target.
        const orgB = await createTestOrganization();
        const userB = await createTestUser(orgB);
        const targetB = await createComputeTarget(orgB, userB.id);

        const session = buildSyncedSession({
          externalSessionId: "fr11-cross-write-session",
        });

        // Authenticated as org A but pointing at org B's compute target. Org is
        // derived from the API key (orgA), never the payload/query, so the
        // service resolves the target via findOwnedById(targetB, orgA) → not
        // owned → Forbidden. A forged foreign target cannot cross-write.
        const forgedResponse = await POST(
          batchRequest(buildBatchPayload(session), targetB.id),
          routeContext()
        );
        expect(forgedResponse.status).toBe(403);

        // Nothing was written under org B's target, and org B has zero sessions.
        await expect(
          findSessionArtifact(targetB.id, session.externalSessionId)
        ).resolves.toBeNull();
        await expect(countOrgSessions(orgB)).resolves.toBe(0);

        // Positive control: the identical payload against org A's OWN target
        // succeeds and the resulting session is owned by org A (the auth org).
        const okResponse = await POST(
          batchRequest(buildBatchPayload(session), targetA.id),
          routeContext()
        );
        expect(okResponse.status).toBe(200);
        const owner = await findSessionArtifactOrg(
          targetA.id,
          session.externalSessionId
        );
        expect(owner).toBe(orgA);
        await expect(countOrgSessions(orgB)).resolves.toBe(0);
      });
    });
  }
);

describeIfDb(
  "POST /desktop/agent-sessions/sync PR-detail cross-branch collision (FEA-3917)",
  () => {
    it("returns 200 (not 500) when the same PR is synced under a second branch artifact", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: user.id, organizationId };
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );
        const repo = "acme/route-widgets";
        await seedPublicRepo(organizationId, repo);

        const first = await POST(
          batchRequest(
            buildBatchPayload(
              buildSyncedSession({
                externalSessionId: "fea3917-route-a",
                artifactRefs: [
                  branchRef(repo, "feature/a"),
                  pullRequestRef({
                    repositoryFullName: repo,
                    prNumber: 321,
                    branchName: "feature/a",
                    state: GitHubPRState.Open,
                  }),
                ],
              })
            ),
            computeTarget.id
          ),
          routeContext()
        );
        expect(first.status).toBe(200);

        // Same (repo, number) under a DIFFERENT head branch → a different branch
        // artifact. Before FEA-3917 the desktop PR upsert's branchArtifactId-keyed
        // lookup missed the existing row and the create collided (P2002), 500ing
        // the whole batch. A fresh batchId avoids any batch-level idempotency skip.
        const second = await POST(
          new NextRequest(
            `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${computeTarget.id}`,
            {
              method: "POST",
              body: JSON.stringify({
                ...buildBatchPayload(
                  buildSyncedSession({
                    externalSessionId: "fea3917-route-b",
                    artifactRefs: [
                      branchRef(repo, "feature/b"),
                      pullRequestRef({
                        repositoryFullName: repo,
                        prNumber: 321,
                        branchName: "feature/b",
                        state: GitHubPRState.Open,
                      }),
                    ],
                  })
                ),
                batchId: randomUUID(),
              }),
            }
          ),
          routeContext()
        );
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual({
          success: true,
          data: { synced: true },
        });

        // Exactly one PR-detail row survives (no duplicate, no collision).
        const rowCount = await withDb((db) =>
          db.pullRequestDetail.count({
            where: {
              organizationId,
              repositoryFullName: normalizeRepoFullName(repo),
              number: 321,
            },
          })
        );
        expect(rowCount).toBe(1);
      });
    });
  }
);

describeIfDb(
  "POST /desktop/agent-sessions/sync authoritative cost (ISS-7229)",
  () => {
    // davetho on #6406: every other suite for this field stops short of the
    // handoff. The desktop side ends at `loadSyncedSessions`, the API side at a
    // mocked `sessionDetail.upsert` — so a route, schema, or Prisma-mapping
    // regression could leave the whole desktop -> cloud path green while nothing
    // reached the column. These drive the REAL route and read the REAL row.
    it("persists a desktop-reported cost onto SessionDetail", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: user.id, organizationId };
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );

        const session = buildSyncedSession({
          externalSessionId: "route-authoritative-cost-session",
          authoritativeCostUsd: 12.345_678,
        });

        const response = await POST(
          batchRequest(buildBatchPayload(session), computeTarget.id),
          routeContext()
        );
        expect(response.status).toBe(200);

        const detail = await readAuthoritativeCost(
          computeTarget.id,
          session.externalSessionId
        );
        // Decimal(14,6) to the last stored digit, not a rounded approximation.
        expect(Number(detail?.authoritativeCostUsd)).toBe(12.345_678);
      });
    });

    it("persists a reported ZERO, which is a measurement and not an absence", async () => {
      // `0` is falsy and the column is nullable, so any truthiness check on this
      // path turns "Claude charged nothing" into "nothing was reported".
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: user.id, organizationId };
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );

        const session = buildSyncedSession({
          externalSessionId: "route-authoritative-zero-session",
          authoritativeCostUsd: 0,
        });

        await POST(
          batchRequest(buildBatchPayload(session), computeTarget.id),
          routeContext()
        );

        const detail = await readAuthoritativeCost(
          computeTarget.id,
          session.externalSessionId
        );
        // The row FIRST: `detail?.authoritativeCostUsd` is `undefined` when the
        // row itself is missing, and `undefined` is `not.toBeNull()` — so
        // without this the "a zero is stored, not absent" claim passes for a
        // session that was never written at all.
        expect(detail).not.toBeNull();
        expect(detail?.authoritativeCostUsd).not.toBeNull();
        expect(Number(detail?.authoritativeCostUsd)).toBe(0);
      });
    });

    it("leaves a stored figure standing when a later sync omits the field", async () => {
      // The data-loss case the wire contract exists for, proven end to end: an
      // OTel-less build re-syncing the same session must not clear a cost an
      // earlier sync recorded.
      //
      // WHAT THIS CASE CAN AND CANNOT CATCH, because the obvious reading is
      // wrong. It does NOT distinguish the conditional patch from one that
      // always spreads the key: Prisma reads an `undefined` value as "do not
      // update this column", so at the database both shapes leave the row
      // alone, and the mutation is green here. `service.authoritative-cost-
      // absence.test.ts` is what pins that, by asserting on the upsert ARGS
      // where the difference is still visible.
      //
      // What this case does catch is the shape that actually loses the data: a
      // patch turning an absent figure into an explicit `null`. Verified by
      // mutation — it is the one case that goes red for it.
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: user.id, organizationId };
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );

        const externalSessionId = "route-authoritative-omitted-session";
        await POST(
          batchRequest(
            buildBatchPayload(
              buildSyncedSession({
                externalSessionId,
                authoritativeCostUsd: 7.5,
              })
            ),
            computeTarget.id
          ),
          routeContext()
        );

        // Same session, a build that captured nothing: the key is absent, not null.
        const SECOND_SYNC_UPDATED_AT = "2026-06-10T12:00:00.000Z";
        const second = await POST(
          batchRequest(
            buildBatchPayload(
              buildSyncedSession({
                externalSessionId,
                updatedAt: SECOND_SYNC_UPDATED_AT,
              })
            ),
            computeTarget.id
          ),
          routeContext()
        );

        const detail = await readAuthoritativeCost(
          computeTarget.id,
          externalSessionId
        );
        // THE POSITIVE CONTROL. Without these two, "the omission was honoured"
        // and "the second slice never wrote this session" are the same
        // observation — a 4xx, or a gate that skipped the session entirely,
        // leaves the stored figure standing just as surely as the contract does,
        // and this is the file's only end-to-end proof of that data-loss guard.
        expect(second.status).toBe(200);
        expect(detail?.sessionUpdatedAt?.toISOString()).toBe(
          SECOND_SYNC_UPDATED_AT
        );
        expect(Number(detail?.authoritativeCostUsd)).toBe(7.5);
      });
    });

    it("lands the other sessions in a batch beside one whose cost cannot be stored", async () => {
      // The batch-blast-radius case at the layer that actually returns the 400.
      // The wire suite proves the payload parses; this proves the request
      // succeeds AND both rows persist, with only the unstorable figure dropped.
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: user.id, organizationId };
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );

        const oversized = buildSyncedSession({
          externalSessionId: "route-authoritative-oversized-session",
          // Past what Decimal(14,6) can hold.
          authoritativeCostUsd: 1e9,
        });
        const healthy = buildSyncedSession({
          externalSessionId: "route-authoritative-healthy-session",
          authoritativeCostUsd: 3.25,
        });

        const response = await POST(
          batchRequest(
            {
              schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
              batchId: "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7e",
              syncMode: AgentSessionSyncMode.Incremental,
              sessionCount: 2,
              sessions: [oversized, healthy],
            },
            computeTarget.id
          ),
          routeContext()
        );

        expect(response.status).toBe(200);

        const healthyRow = await readAuthoritativeCost(
          computeTarget.id,
          healthy.externalSessionId
        );
        expect(Number(healthyRow?.authoritativeCostUsd)).toBe(3.25);

        // The offender still SYNCS — it simply carries no cost. Dropping the
        // session, rather than the field, would be the other way to fail here.
        const oversizedRow = await readAuthoritativeCost(
          computeTarget.id,
          oversized.externalSessionId
        );
        expect(oversizedRow).not.toBeNull();
        expect(oversizedRow?.authoritativeCostUsd).toBeNull();
      });
    });

    it("stores a figure at the column's rounding edge, exactly as the guard admitted it", async () => {
      // THE GAP BETWEEN THE GUARD AND THE COLUMN, against a real
      // `numeric(14, 6)`.
      //
      // `canStoreAuthoritativeCostUsd` decides by rounding in JS (`toFixed(6)` →
      // `99999999.999999`, admitted), while the raw double rounds half-up to
      // `100000000.000000` — nine integer digits, which the column refuses with
      // 22003. Measured separately: that raise fires when the value reaches
      // Postgres as text or as `float8`, and does not fire through Prisma's
      // typed Decimal path, which rounds to the declared scale first.
      //
      // So what this asserts end to end is the OUTCOME the slice now guarantees
      // on its own — the request succeeds and the column holds the figure the
      // guard checked — rather than a 500 the client currently prevents by
      // accident. Distinct from the case above, which covers a figure the GUARD
      // rejects; this one the guard ACCEPTS, and a round number here would pass
      // whatever the write does with it.
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          clerkId: mocks.auth.clerkUserId,
        });
        mocks.auth.user = { id: user.id, organizationId };
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );

        const session = buildSyncedSession({
          externalSessionId: "route-authoritative-edge-session",
          authoritativeCostUsd: 99_999_999.999_999_5,
        });

        const response = await POST(
          batchRequest(buildBatchPayload(session), computeTarget.id),
          routeContext()
        );

        expect(response.status).toBe(200);
        const detail = await readAuthoritativeCost(
          computeTarget.id,
          session.externalSessionId
        );
        // Stored, and stored as the figure the guard actually admitted.
        expect(detail?.authoritativeCostUsd?.toString()).toBe(
          "99999999.999999"
        );
      });
    });
  }
);

function countOrgSessions(organizationId: string) {
  return withDb((db) =>
    db.sessionDetail.count({
      where: { artifact: { is: { organizationId } } },
    })
  );
}

function findSessionArtifact(
  computeTargetId: string,
  externalSessionId: string
) {
  return withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { artifactId: true },
    })
  );
}

function findSessionArtifactOrg(
  computeTargetId: string,
  externalSessionId: string
) {
  return withDb(async (db) => {
    const row = await db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { artifact: { select: { organizationId: true } } },
    });
    return row?.artifact.organizationId ?? null;
  });
}

function batchRequest(
  body: DesktopAgentSessionsPayload,
  computeTargetId: string
): NextRequest {
  return new NextRequest(
    `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${computeTargetId}`,
    {
      body: JSON.stringify(body),
      method: "POST",
    }
  );
}

function buildBatchPayload(
  session: SyncedAgentSession
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7c",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [session],
  };
}

function readSessionRepository(
  computeTargetId: string,
  externalSessionId: string
) {
  return withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { repositoryFullName: true },
    })
  );
}

function readSessionTotals(computeTargetId: string, externalSessionId: string) {
  return withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: {
        artifactId: true,
        inputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        estimatedCost: true,
      },
    })
  );
}

function readTokenUsageRow(agentSessionId: string, model: string) {
  return withDb((db) =>
    db.agentSessionTokenUsage.findUnique({
      where: { agentSessionId_model: { agentSessionId, model } },
      select: {
        inputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        estimatedCost: true,
      },
    })
  );
}

function routeContext(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}

function createComputeTarget(organizationId: string, userId: string) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "route-fragment-machine",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "route-session",
    status: "active",
    harness: "codex",
    cwd: "/tmp/route-fragment",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function readAuthoritativeCost(
  computeTargetId: string,
  externalSessionId: string
) {
  return withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      // `sessionUpdatedAt` rides along as the POSITIVE CONTROL for the omission
      // case: it is a column the desktop sends on every sync and the slice
      // always writes, so it distinguishes "the second slice ran and honoured
      // the omission" from "the second slice never wrote this session at all".
      select: { authoritativeCostUsd: true, sessionUpdatedAt: true },
    })
  );
}
