import "server-only";

import { usageScopeHashForContent } from "@repo/api/src/agent-component-usage-scope";
import type { Prisma, withDb } from "@repo/database";
import { componentVersionKeyWhere } from "../../definition-registry/service";
import type { DetailIdentityScope } from "../content-hash-identity";
import type { DetailUsageIdentity } from "./detail-usage-identity";
import { resolveVersionScopeKeys } from "./detail-version-history";

/**
 * @file version-usage-identity.ts
 * @description ISS-10467 — the identity half of the per-version drill-down,
 * split out of `detail-version-usage.ts` so that module stays the read and this
 * one stays "which family is this, and which revisions does it have".
 *
 * Both halves are deliberately the SAME resolutions `getDetailForOrg` performs
 * (the live-inventory predicate, the rendered inventory rows, the identity's
 * complete name set), so a drill-down cannot answer for a different family than
 * the page it was opened from.
 */

/** Everything a version-usage read needs about the family behind a slug. */
export type VersionUsageIdentity = {
  /** The live-inventory predicate the usage lanes re-derive their bound from. */
  liveInventoryWhere: Prisma.AgentComponentWhereInput;
  /** The identity `loadDetailUsageGroups` filters its FK union against. */
  usageIdentity: DetailUsageIdentity;
  /**
   * Every coarse `contentHash` this family has a revision row for. A requested
   * hash outside this set is answered "not computed" rather than as a measured
   * zero — an unknown revision has no population to have measured.
   */
  knownContentHashes: ReadonlySet<string>;
  /**
   * The exact provenance-free fingerprint per coarse hash, where the revision is
   * linked. Absent for a still-unlinked revision — and
   * `AgentComponentSessionUsage.definitionVersionId` has no writer yet, so on
   * real data this map is empty and {@link usageScopeHashByContentHash} is what
   * actually resolves a revision's usage.
   */
  definitionHashByContentHash: ReadonlyMap<string, string>;
  /**
   * The USAGE-SPACE digest per coarse hash — `computeDefinitionHash` over the
   * revision's captured content, which is the value
   * `AgentComponentSessionUsage.componentVersionHash` is actually stamped with.
   *
   * WITHOUT THIS THE DRILL-DOWN MEASURES NOTHING. A version row's `contentHash`
   * is a raw `sha256Hex(content)`; the usage row's `componentVersionHash` is the
   * domain-tagged, kind-scoped digest the desktop stamps at invocation from
   * `agent_component_invocations.definition_hash`. The two never agree for the
   * same file, so scoping by the coarse hash alone matched no row and every
   * revision came back as a measured-looking `0` under a partition sentence
   * saying some invocations DID name a version (tamsinb, ISS-10467). Absent
   * only for a revision whose content column is null.
   */
  usageScopeHashByContentHash: ReadonlyMap<string, string>;
};

/**
 * Resolve the family behind a detail slug for the version-usage read, or `null`
 * when this org has no live inventory row for it.
 *
 * The orphan-only ("used-only") states of the detail page resolve no live
 * inventory at all, and their own usage is family-scoped by ISS-10469 with no
 * revision rows to drill into — so they get `null` here and the route 404s
 * rather than inventing an empty drill-down beside a page that has no version
 * selector to open it from.
 */
export async function resolveComponentIdentity(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  scope: DetailIdentityScope
): Promise<VersionUsageIdentity | null> {
  if (scope.orphanOnly) {
    return null;
  }
  const liveInventoryWhere: Prisma.AgentComponentWhereInput = {
    organizationId,
    componentKind: kind,
    uninstalledAt: null,
    ...scope.inventoryWhere,
  };
  const inventoryRows = await db.agentComponent.findMany({
    where: liveInventoryWhere,
    select: { componentKind: true, componentKey: true, name: true },
  });
  if (inventoryRows.length === 0) {
    return null;
  }
  const versionKeys = resolveVersionScopeKeys(scope.keys, scope.key);
  const versionRows = await db.agentComponentVersion.findMany({
    // The version-history read's OWN predicate object, called rather than
    // re-spelled, so the hashes this read admits are exactly the hashes the
    // detail's version selector offered and the two cannot drift apart.
    where: componentVersionKeyWhere(organizationId, kind, versionKeys),
    select: {
      contentHash: true,
      // ISS-10467: the body itself, so the read can derive the usage-space
      // digest the usage rows carry — see `usageScopeHashByContentHash`.
      content: true,
      usageScopeHash: true,
      definitionVersion: { select: { definitionHash: true } },
    },
  });
  const knownContentHashes = new Set<string>();
  const definitionHashByContentHash = new Map<string, string>();
  const usageScopeHashByContentHash = new Map<string, string>();
  for (const row of versionRows) {
    knownContentHashes.add(row.contentHash);
    const exact = row.definitionVersion?.definitionHash;
    if (exact) {
      definitionHashByContentHash.set(row.contentHash, exact);
    }
    // ISS-4965 (Perrin, 2026-10-05): a redacted body carries the digest of the
    // text as written; re-deriving it from the redacted body would miss.
    const usageScopeHash =
      row.usageScopeHash ?? usageScopeHashForContent(row.content, kind);
    if (usageScopeHash) {
      usageScopeHashByContentHash.set(row.contentHash, usageScopeHash);
    }
  }
  return {
    liveInventoryWhere,
    usageIdentity: {
      kind,
      key: scope.key,
      keys: scope.keys,
      inventoryRows,
    },
    knownContentHashes,
    definitionHashByContentHash,
    usageScopeHashByContentHash,
  };
}
