/**
 * @file component-identity-lookup.ts
 * @description ISS-8285: the component-inventory IDENTITY — the projected index
 * keys a synced component writes under, and the key an EXISTING row is already
 * stored under — split out of `service.ts`.
 *
 * A real seam rather than a line-count slice: choosing WHICH row a sync is about
 * is a separate responsibility from building the payload written to it, and
 * `service.ts` sits at the 1,000-line ceiling.
 *
 * WHY THE LOOKUP EXISTS. ISS-8069 re-keyed `componentKind` and
 * `externalComponentId` by projecting them at the write. A row written before
 * that, whose identity exceeded {@link INDEX_KEY_MAX_BYTES} but fit the former
 * 2704-byte unique tuple, is sitting under its RAW value right now. An upsert
 * whose `where` names only the projected identity does not find it — and an
 * upsert that finds nothing CREATES, so the next sync mints a SECOND
 * `AgentComponent` for a component that already has one. Inventory and search
 * then point at the new row while every existing usage attribution stays on the
 * old one, and nothing throws.
 *
 * So the stored identity is resolved first and the upsert is keyed on what it
 * found. This is the same lookup-then-upsert the session ingest already runs
 * (`agent-sessions/service/session-slice-identity.ts` feeding
 * `session-slice-detail-write.ts`), and it is NOT the findFirst-then-write the
 * root `AGENTS.md` forbids: the write is still ONE atomic upsert, and the read
 * only decides which unique key that upsert targets.
 */
import type { TransactionClient } from "@repo/database";
import type { DesktopAgentComponentsPayload } from "@/lib/desktop-agent-sessions-schema";
import { resolveByAnyIndexKey } from "@/lib/index-key-lookup";
import {
  countProjected,
  projectIndexKey,
  projectNullableIndexKey,
} from "@/lib/index-key-projection";

export type SyncedComponent =
  DesktopAgentComponentsPayload["components"][number];

/**
 * ISS-8069: the index-key columns of ONE synced component, each projected down
 * to a size a btree tuple can physically hold, plus how many of them bound.
 *
 * All four are resolved together because they do not each ride their own index —
 * they SHARE tuples. `componentKind` + `contentHash` sit in
 * `agent_components_org_kind_content_hash_idx`; `componentKind` +
 * `componentKey` + `contentHash` sit in the `AgentComponentVersion`
 * `(organizationId, componentKind, componentKey, source, contentHash)` UNIQUE.
 * The 2704-byte limit applies to the whole tuple, so bounding `contentHash`
 * alone — the field ISS-8069 names — does not make either index safe while its
 * neighbours can still be 2 KB each. The wire carries no length cap on them at
 * all since ISS-8201; the 512-CHARACTER one it used to carry bounded nothing
 * here anyway, being up to 2048 bytes of multibyte UTF-8 — three of those in
 * one tuple is 6 KB. This projection is the only bound on the tuple.
 *
 * Deterministic, so the upsert `where` built from these keys resolves the same
 * component on every re-sync.
 */
export function toComponentIndexKeys(component: SyncedComponent) {
  const componentKind = projectIndexKey(component.componentKind);
  const externalComponentId = projectIndexKey(component.externalId);
  const componentKey = projectNullableIndexKey(component.componentKey);
  const contentHash = projectNullableIndexKey(component.contentHash);
  return {
    componentKind,
    externalComponentId,
    componentKey,
    contentHash,
    projectedCount: countProjected(
      componentKind,
      externalComponentId,
      componentKey,
      contentHash
    ),
  };
}

/**
 * The identity an EXISTING inventory row is stored under, or the projected
 * identity a new row will be created under.
 *
 * `componentKey` rides along because it is part of the sibling
 * `AgentComponentVersion` UNIQUE tuple: a legacy row's version history is keyed
 * on the key that row actually holds, so taking the kind and external id from
 * the stored row while taking the key from the projection would build a version
 * identity matching neither.
 */
export type StoredComponentIdentity = {
  componentKind: string;
  externalComponentId: string;
  componentKey: string | null;
};

/**
 * Resolve the `(componentKind, externalComponentId)` this component is ALREADY
 * stored under, falling back to the projected identity when no row exists yet.
 *
 * BOTH halves of the pair can have been re-keyed, so both are probed, projected
 * form first — that is what every write since ISS-8069 lands on. One candidate
 * per half for every value inside the byte budget, which is all of them in
 * practice, so ordinary traffic pays exactly one extra indexed point read and
 * the probe short-circuits on it.
 *
 * An existing row KEEPS the key it is stored under. Re-keying it would orphan
 * the usage rows and version history referencing the old value, and the row's
 * own existence proves that key fits the index — the same rule
 * `resolveStoredIndexKey` states for the session identity.
 */
export async function resolveStoredComponentIdentity(
  db: TransactionClient,
  computeTargetId: string,
  component: SyncedComponent
): Promise<StoredComponentIdentity> {
  const indexKeys = toComponentIndexKeys(component);
  const projected: StoredComponentIdentity = {
    componentKind: indexKeys.componentKind.value,
    externalComponentId: indexKeys.externalComponentId.value,
    componentKey: indexKeys.componentKey.value,
  };
  // NO READ WHEN NOTHING BOUND, which is every component in practice. A value
  // the budget did not bind has exactly ONE candidate — itself — so the probe
  // below could only ever re-find the row the upsert's own `where` already
  // names, and a legacy row under a DIFFERENT key cannot exist for it. Without
  // this gate the lane pays one extra point read per component on a fan-out
  // sized for 200 of them, to answer a question whose answer is already known
  // (`apps/api/AGENTS.md`, "an aggregate must not pay the row projection" — the
  // same rule against buying work a cheaper statement already settles).
  if (
    !(
      indexKeys.componentKind.projected ||
      indexKeys.externalComponentId.projected ||
      // ISS-8200 (review): `componentKey` is an INDEPENDENT wire field — and
      // since ISS-8201 an uncapped one, the 512-CHARACTER cap it used to carry
      // having bounded up to 2048 BYTES of multibyte UTF-8 and so never this
      // budget — so it can bind while both identity halves fit. Without it such
      // a component
      // short-circuits and this returns a PROJECTED key no stored row was ever
      // checked against, which callers write as "already stored under".
      indexKeys.componentKey.projected
    )
  ) {
    return projected;
  }
  const found = await resolveByAnyIndexKey(component.componentKind, (kind) =>
    resolveByAnyIndexKey(component.externalId, (externalComponentId) =>
      db.agentComponent.findUnique({
        where: {
          computeTargetId_componentKind_externalComponentId: {
            computeTargetId,
            componentKind: kind,
            externalComponentId,
          },
        },
        select: {
          componentKind: true,
          externalComponentId: true,
          componentKey: true,
        },
      })
    )
  );
  return found?.record.record ?? projected;
}
