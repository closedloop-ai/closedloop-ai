/**
 * @file desktop-component-variant-usage-scope-hash.integration.test.ts
 * @description ISS-4965 (whitlockk review, #8391) — a retained variant row stored
 * without its usage digest gets it from the next sync that carries it.
 *
 * The variant lane inserts with `createMany({ skipDuplicates })`, which never
 * touches an existing row, so the digest is set by a separate raw UPDATE. Run
 * against a real Postgres because a mock cannot catch a type or column error in
 * that SQL.
 *
 * Self-skips when DATABASE_URL is unset, like its neighbours. Run explicitly:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app \
 *     pnpm --filter api exec vitest run \
 *     __tests__/integration/desktop-component-variant-usage-scope-hash.integration.test.ts \
 *     --config vitest.config.integration.mts
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { createSyncFixture } from "@/__tests__/support/index-key-poison.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { desktopComponentsSyncService } from "@/app/desktop/components/sync/service";
import { desktopAgentComponentsPayloadSchema } from "@/lib/desktop-agent-sessions-schema";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

const SECRET_HASH = "a".repeat(64);
const CLEAN_HASH = "c".repeat(64);
const USAGE_DIGEST = "d".repeat(64);

const organizations = createCommittedTestOrganizationTracker();

function payload(secretVariantDigest: string | undefined) {
  const parsed = desktopAgentComponentsPayloadSchema.safeParse({
    schemaVersion: 1,
    batchId: "5b1f0c7e-3d2a-4e8b-9a61-7c4d2e9f0a13",
    syncMode: AgentSessionSyncMode.Incremental,
    componentCount: 1,
    components: [
      {
        externalId: "skill::deploy",
        componentKind: "skill",
        harness: "claude-code",
        name: "Deploy",
        componentKey: "deploy",
        content: "# deploy",
        contentHash: "f".repeat(64),
        variants: [
          {
            contentHash: SECRET_HASH,
            content: "OLD [REDACTED:ghp]",
            usageScopeHash: secretVariantDigest,
          },
          { contentHash: CLEAN_HASH, content: "CLEAN BODY" },
        ],
      },
    ],
  });
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

function readVariantDigests(organizationId: string) {
  return withDb((db) =>
    db.agentComponentVersion.findMany({
      where: { organizationId, contentHash: { in: [SECRET_HASH, CLEAN_HASH] } },
      orderBy: { contentHash: "asc" },
      select: { contentHash: true, usageScopeHash: true },
    })
  );
}

afterEach(async () => {
  await organizations.cleanup();
});

describeIfDb("ISS-4965 — variant usage digest on an existing row", () => {
  it("sets the digest a resync carries and leaves the clean variant NULL", async () => {
    const organizationId = await organizations.create();
    const fixture = await createSyncFixture(organizationId, "iss-4965-machine");
    const sync = (secretVariantDigest: string | undefined) =>
      desktopComponentsSyncService.sync({
        clerkUserId: null,
        computeTargetId: fixture.computeTargetId,
        organizationId,
        userId: fixture.userId,
        payload: payload(secretVariantDigest),
      });

    // First stored with the digest dropped, as by an API without the field.
    expect((await sync(undefined)).ok).toBe(true);
    expect(await readVariantDigests(organizationId)).toEqual([
      { contentHash: SECRET_HASH, usageScopeHash: null },
      { contentHash: CLEAN_HASH, usageScopeHash: null },
    ]);

    expect((await sync(USAGE_DIGEST)).ok).toBe(true);
    expect(await readVariantDigests(organizationId)).toEqual([
      { contentHash: SECRET_HASH, usageScopeHash: USAGE_DIGEST },
      { contentHash: CLEAN_HASH, usageScopeHash: null },
    ]);
  });
});
