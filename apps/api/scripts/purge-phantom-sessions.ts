/**
 * FEA-1787 §4: Purge phantom agent sessions created by Codex re-serialization
 * bursts. These are cloud-side artifacts of a desktop bug where ~26-39 sessions
 * were created in rapid succession from re-stamped raw files.
 *
 * Signature: event span < 5 seconds, ≥ 20 events, zero token usage rows.
 *
 * Usage:
 *   cd apps/api
 *   DATABASE_URL=<url> npx tsx scripts/purge-phantom-sessions.ts
 *
 * Dry-run mode (default — logs what would be deleted):
 *   DRY_RUN=1 DATABASE_URL=<url> npx tsx scripts/purge-phantom-sessions.ts
 *
 * Execute mode (requires ORG_ID):
 *   DRY_RUN=0 ORG_ID=<uuid> DATABASE_URL=<url> npx tsx scripts/purge-phantom-sessions.ts
 */
import { fileURLToPath } from "node:url";
import { Prisma, type PrismaClient, withDb } from "@repo/database";

export type PhantomCandidate = {
  artifactId: string;
  externalSessionId: string;
  organizationId: string;
  eventCount: bigint;
  eventSpanMs: number;
};

type TxClient = Parameters<Parameters<typeof withDb.tx>[0]>[0];

export function findPhantoms(
  tx: TxClient | PrismaClient,
  orgId: string | null
): Promise<PhantomCandidate[]> {
  const orgFilter = orgId
    ? Prisma.sql`AND a."organization_id" = ${orgId}::uuid`
    : Prisma.empty;

  return tx.$queryRaw<PhantomCandidate[]>`
    SELECT
      sd."artifact_id" AS "artifactId",
      sd."external_session_id" AS "externalSessionId",
      a."organization_id" AS "organizationId",
      COUNT(e."id") AS "eventCount",
      EXTRACT(EPOCH FROM (MAX(e."event_created_at") - MIN(e."event_created_at"))) * 1000 AS "eventSpanMs"
    FROM "session_detail" sd
    JOIN "artifacts" a ON a."id" = sd."artifact_id"
    JOIN "agent_session_events" e ON e."agent_session_id" = sd."artifact_id"
    LEFT JOIN "agent_session_token_usage" tu ON tu."agent_session_id" = sd."artifact_id"
    WHERE tu."id" IS NULL
      ${orgFilter}
    GROUP BY sd."artifact_id", sd."external_session_id", a."organization_id"
    HAVING COUNT(e."id") >= 20
      AND EXTRACT(EPOCH FROM (MAX(e."event_created_at") - MIN(e."event_created_at"))) < 5
    ORDER BY a."organization_id", COUNT(e."id") DESC
  `;
}

export async function purgePhantoms(
  tx: TxClient | PrismaClient,
  candidates: PhantomCandidate[]
): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }
  const ids = candidates.map((c) => c.artifactId);
  const result = await tx.artifact.deleteMany({
    where: { id: { in: ids } },
  });
  return result.count;
}

export async function main() {
  const DRY_RUN = process.env.DRY_RUN !== "0";
  const ORG_ID = process.env.ORG_ID ?? null;

  if (!(DRY_RUN || ORG_ID)) {
    console.error(
      "ERROR: ORG_ID is required in execute mode (DRY_RUN=0). " +
        "Refusing to run cross-org purge. Set ORG_ID=<uuid> to scope the operation."
    );
    process.exit(1);
  }

  console.log(
    `Phantom purge — mode: ${DRY_RUN ? "DRY RUN" : "EXECUTE"}${ORG_ID ? `, org: ${ORG_ID}` : ""}`
  );

  const candidates = await withDb((db) => findPhantoms(db, ORG_ID));
  console.log(`Found ${candidates.length} phantom session(s)`);

  const byOrg = new Map<string, PhantomCandidate[]>();
  for (const c of candidates) {
    const list = byOrg.get(c.organizationId) ?? [];
    list.push(c);
    byOrg.set(c.organizationId, list);
  }

  for (const [orgId, orgCandidates] of byOrg) {
    console.log(`\n  Org ${orgId}: ${orgCandidates.length} phantom(s)`);
    for (const c of orgCandidates) {
      console.log(
        `    ${c.externalSessionId} — ${Number(c.eventCount)} events, ${Math.round(c.eventSpanMs)}ms span`
      );
    }
  }

  if (DRY_RUN) {
    console.log("\nDry run complete. Set DRY_RUN=0 to execute.");
    return;
  }

  // Find + delete in a single transaction for atomicity: prevents a session
  // from receiving a token-usage sync between the find and purge steps.
  const deleted = await withDb.tx(async (tx) => {
    const freshCandidates = await findPhantoms(tx, ORG_ID);
    return purgePhantoms(tx, freshCandidates);
  });
  console.log(
    `\nDeleted ${deleted} phantom session(s) (cascade removed children).`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("Phantom purge failed:", err);
    process.exit(1);
  });
}
