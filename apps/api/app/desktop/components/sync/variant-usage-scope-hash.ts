import { Prisma, type TransactionClient } from "@repo/database";

/** The identity of one variant version row plus the usage digest it carries. */
export type VariantUsageScopeHashRow = {
  organizationId: string;
  componentKind: string;
  componentKey: string;
  source: string;
  contentHash: string;
  usageScopeHash: string | null;
};

/**
 * ISS-4965 (whitlockk review, #8391): write each sent usage digest onto a variant
 * row that already exists, in one statement for the whole batch.
 *
 * `createMany({ skipDuplicates })` leaves an existing row untouched, so a row
 * stored while the digest was dropped (a newer Desktop syncing to an API that
 * predates the column) would keep NULL on every resync. The primary row gets
 * the same write from its upsert's `update` arm. Rows already holding the digest
 * are not rewritten.
 */
export async function persistVariantUsageScopeHashes(
  db: TransactionClient,
  rows: readonly VariantUsageScopeHashRow[]
): Promise<void> {
  const values = rows.flatMap((row) =>
    row.usageScopeHash
      ? [
          Prisma.sql`(${row.organizationId}::uuid, ${row.componentKind}::text,
          ${row.componentKey}::text, ${row.source}::text,
          ${row.contentHash}::text, ${row.usageScopeHash}::text)`,
        ]
      : []
  );
  if (values.length === 0) {
    return;
  }
  await db.$executeRaw(Prisma.sql`
    UPDATE agent_component_versions AS versions
    SET usage_scope_hash = v.usage_scope_hash, updated_at = NOW()
    FROM (VALUES ${Prisma.join(values)}) AS v(organization_id, component_kind,
      component_key, source, content_hash, usage_scope_hash)
    WHERE versions.organization_id = v.organization_id
      AND versions.component_kind = v.component_kind
      AND versions.component_key = v.component_key
      AND versions.source = v.source
      AND versions.content_hash = v.content_hash
      AND versions.usage_scope_hash IS DISTINCT FROM v.usage_scope_hash
  `);
}
