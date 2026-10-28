import { catalogTargetKindToComponentKind } from "@repo/api/src/catalog-component-kind";
import { SourceOccurrenceType, type TransactionClient } from "@repo/database";
import { registerDefinitionVersion } from "@/app/definition-registry/service";

/**
 * FEA-3909 / PRD-527 F4 — map a pack member's exact definition to the F1
 * `DefinitionVersion` registry and record a `pack` `SourceOccurrence`.
 *
 * Called for a content-bearing pack member (a child `CatalogItem` with
 * `parentPackId != null`) right after its first `CatalogItemVersion` is written.
 * Delegates to {@link registerDefinitionVersion} — the SSOT — which
 * provenance-freely fingerprints the body (`computeDefinitionHash`, never a local
 * hash), upserts the exact version on `(org, definitionHash)`, and idempotently
 * upserts a `SourceOccurrence(occurrenceType = pack, packId)`. This closes the
 * previously-never-written `pack` seam (the writer only ever passed `local`).
 *
 * Then it stamps the resulting `definitionVersionId` onto the version row just
 * created, so the catalog is linked to the registry (readers prefer this link
 * over the provenance-tainted `componentUuid`, which is preserved alongside).
 *
 * Many-to-many (PD3): the same body in N packs upserts ONE `DefinitionVersion`
 * and one `pack` occurrence per distinct `packId` — the version is referenced,
 * never copied. The Pack itself is never versioned (PD2).
 *
 * Conservative (PD5-aligned): a member with no stored body never reaches here
 * (the caller only invokes it when `content != null`), so it can never mint an
 * invented version. Runs on the caller's `tx` so the registry rows land atomically
 * with the member create.
 */
export async function linkPackMemberDefinition(
  tx: TransactionClient,
  args: {
    organizationId: string;
    packId: string;
    catalogItemVersionId: string;
    targetKind: string;
    content: string;
  }
): Promise<void> {
  // Conservative (PD5): mint a version ONLY from real stored bytes. An empty body
  // is left unlinked (definitionVersionId stays NULL) on EVERY live writer, so the
  // live create/edit/import paths and the conservative backfill
  // (`backfill-pack-definition-versions.ts`, which skips `content.length === 0`)
  // classify the same empty-content member identically — no live-vs-backfill drift.
  if (!isLinkableDefinitionContent(args.content)) {
    return;
  }
  const definitionVersionId = await registerDefinitionVersion(tx, {
    organizationId: args.organizationId,
    // Canonicalize the catalog's `targetKind` (`"agent"` → `subagent`) before it
    // is folded into the fingerprint, so a pack-imported member and a device-synced
    // `subagent` of identical bytes dedupe to ONE F1 `DefinitionVersion`. The
    // conservative backfill applies the SAME mapping, so a live-linked member and a
    // backfilled one share the `definitionHash`.
    componentKind: catalogTargetKindToComponentKind(args.targetKind),
    content: args.content,
    occurrenceType: SourceOccurrenceType.pack,
    packId: args.packId,
  });

  await tx.catalogItemVersion.update({
    where: { id: args.catalogItemVersionId },
    data: { definitionVersionId },
    select: { id: true },
  });
}

/**
 * Whether a member's stored body is real bytes we can conservatively fingerprint
 * (PD5). The SSOT guard shared by every live pack-member writer so the empty /
 * absent-body classification never forks from the conservative backfill.
 */
function isLinkableDefinitionContent(
  content: string | null
): content is string {
  return content != null && content.length > 0;
}
