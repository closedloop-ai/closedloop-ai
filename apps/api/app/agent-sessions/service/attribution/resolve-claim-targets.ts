/**
 * ISS-12552: resolve the artifact each claim names, by UUID or slug, within
 * the session's organization, in one query. A name that resolves to nothing in
 * the organization stays observed text with no artifact.
 */
import {
  type OperationClaim,
  OperationClaimSource,
} from "@repo/api/src/types/operation-claims";
import type { AgentSessionUpsertTx } from "../records";

type ObservedTarget = { text: string | null; artifactId: string | null };

export type TargetResolver = {
  observed(claim: OperationClaim): ObservedTarget;
};

type ClaimName = { uuid?: string; slug?: string };

/** Only a UUID-shaped value reaches the UUID column; anything else is text. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function resolveClaimTargets(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  claims: readonly OperationClaim[]
): Promise<TargetResolver> {
  const names = claims.map(claimName);
  const uuids = [...new Set(names.flatMap((name) => name.uuid ?? []))];
  const slugs = [...new Set(names.flatMap((name) => name.slug ?? []))];
  const rows =
    uuids.length + slugs.length === 0
      ? []
      : await tx.artifact.findMany({
          where: {
            organizationId,
            OR: [
              ...(uuids.length > 0 ? [{ id: { in: uuids } }] : []),
              ...(slugs.length > 0 ? [{ slug: { in: slugs } }] : []),
            ],
          },
          select: { id: true, slug: true },
        });
  const byId = new Set(rows.map((row) => row.id));
  const bySlug = new Map(
    rows.flatMap((row) => (row.slug ? [[row.slug, row.id] as const] : []))
  );
  return {
    observed(claim) {
      const name = claimName(claim);
      if (name.uuid) {
        return {
          text: name.uuid,
          artifactId: byId.has(name.uuid) ? name.uuid : null,
        };
      }
      if (name.slug) {
        return { text: name.slug, artifactId: bySlug.get(name.slug) ?? null };
      }
      return { text: null, artifactId: null };
    },
  };
}

/**
 * The artifact a claim names: a reference's slug; otherwise the first
 * designated target parameter, then the record the response root names.
 */
function claimName(claim: OperationClaim): ClaimName {
  if (claim.source === OperationClaimSource.Reference) {
    return claim.referenceSlug ? { slug: claim.referenceSlug } : {};
  }
  const [target] = claim.inputTargets ?? [];
  const entity = claim.primaryResultEntity;
  const uuid =
    asUuid(target?.uuid) ?? (target ? undefined : asUuid(entity?.id));
  if (uuid) {
    return { uuid };
  }
  const slug = target ? target.slug : entity?.slug;
  return slug ? { slug } : {};
}

function asUuid(value: string | undefined): string | undefined {
  const lower = value?.toLowerCase();
  return lower && UUID_RE.test(lower) ? lower : undefined;
}
