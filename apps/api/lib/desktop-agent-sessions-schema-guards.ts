/**
 * @file desktop-agent-sessions-schema-guards.ts
 * @description The compile-time keys-covered guards for the desktop
 * agent-sessions sync boundary, extracted from
 * `desktop-agent-sessions-schema.ts` (which sits at the noExcessiveLinesPerFile
 * ceiling) as a cohesive sibling. Every guard here exists for the same reason:
 * the ingest schemas are deliberately NON-strict (an unknown field from a newer
 * desktop is stripped, never rejected), which means a field the producer sends
 * but the boundary forgot to declare is silently dropped before persistence —
 * no rejection, no log, nothing. Assigning schema shape fragments to a `Record`
 * keyed by the shared producer type makes `tsc` — not production — fail the
 * moment the contract and the boundary drift (the FEA-3701 / ISS-4586 /
 * ISS-4882 / ISS-5164 lesson, each recorded on its guard below).
 *
 * The guards are EXPORTED (not inert declarations) so each is a genuine
 * consumer of the schema shape; nothing imports them at runtime on purpose.
 */

import type { AcceptedAgentComponentSyncSchemaVersion } from "@repo/api/src/types/agent-component-sync-schema-version";
import type {
  DesktopAgentSessionsPayload as ParsedDesktopAgentSessionsPayload,
  SyncedAgentSession as ParsedSyncedAgentSession,
  SyncedComponent as ParsedSyncedComponent,
  SyncedComponentUsage as ParsedSyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import type { AcceptedAgentSessionSyncSchemaVersion } from "@repo/api/src/types/agent-session-sync-schema-version";
import type { SyncedComponentVariant } from "@repo/api/src/types/synced-component-content";
import type { z } from "zod";
import {
  type desktopAgentComponentsPayloadSchema,
  desktopAgentSessionsPayloadObjectSchema,
  syncedAgentSessionSchema,
  syncedComponentFieldsSchema,
  syncedComponentUsageSchema,
  syncedComponentVariantSchema,
} from "./desktop-agent-sessions-schema";
import { syncedAgentSessionTokenEventObjectSchema } from "./desktop-agent-sessions-token-schema";

// ISS-5164 keys-covered guard. This component boundary is a plain (non-strict)
// `z.object`, so a field the desktop packer sends but this shape does not
// declare is silently STRIPPED before persistence. Assigning the WHOLE shape to
// a `Record` keyed by the shared producer type makes `tsc` fail the moment
// `SyncedComponent` gains a field the schema has not learned. That is
// deliberately stronger than the enumerated `Pick`-based session-lane guards
// below (FEA-4022 / ISS-4586 / ISS-4882), which can only catch a rename or
// removal of the keys they name.
//
// ISS-5029 is the case that motivated it: the detail read's device-side "this
// history is partial" ground is derived ONLY from `variantsTruncated` /
// `variantsTruncatedReason`, so dropping either would leave that ground
// permanently dark while every isolated layer test stayed green.
//
// SPREAD, not the shape object itself: zod's `.shape` is a lazy getter over the
// validator's own live field map, so exporting it directly would hand callers a
// mutable handle on what this ingest boundary validates against. The copy is
// inert and the compile-time guarantee is identical.
export const syncedComponentSyncKeysCovered: Record<
  keyof ParsedSyncedComponent,
  z.ZodTypeAny
> = { ...syncedComponentFieldsSchema.shape };

// ISS-7259 keys-covered guard, at the same WHOLE-shape strength as the component
// guard above rather than an enumerated `Pick`. The per-session component usage
// rows are where `isFirstAttributedSkill` lands, and it is the newest field on
// the least-strict path: a plain `z.object` whose parse output flows straight
// into a raw `INSERT ... ON CONFLICT`. Had this guard existed first the field
// would have failed `tsc` here rather than being accepted by the route and then
// dropped before the column — the exact false-completeness this file exists for.
//
// `Required` because everything but the four identity fields is optional on the
// producer type; without it `keyof` yields only the required keys and the guard
// would pass while the schema had forgotten every additive field.
export const syncedComponentUsageSyncKeysCovered: Record<
  keyof Required<ParsedSyncedComponentUsage>,
  z.ZodTypeAny
> = { ...syncedComponentUsageSchema.shape };

// ISS-4882: these transport/provenance fields are intentionally additive, but
// this non-strict session boundary would silently strip any field omitted from
// its shape. Keep a compile-time guard over the owning shared type so the next
// contract change fails typecheck instead of disappearing during cloud ingest.
type TokenEventProvenanceSyncKeys = Pick<
  NonNullable<ParsedSyncedAgentSession["tokenEvents"]>[number],
  "externalEventId" | "sourceIdentity" | "costSummary"
>;
export const tokenEventProvenanceSyncKeysCovered: Record<
  keyof TokenEventProvenanceSyncKeys,
  z.ZodTypeAny
> = {
  externalEventId:
    syncedAgentSessionTokenEventObjectSchema.shape.externalEventId,
  sourceIdentity: syncedAgentSessionTokenEventObjectSchema.shape.sourceIdentity,
  costSummary: syncedAgentSessionTokenEventObjectSchema.shape.costSummary,
};

// FEA-4022 / FEA-3701 keys-covered guard: the raw frustration signal is
// conditionally emitted by the desktop and persisted at this boundary, so the
// boundary schema MUST validate every frustration key the producer can send —
// a stripped value would silently drop on ingest. Scoped to the FEA-4022 keys
// (rather than the whole session type) because the wider schema intentionally
// diverges from the type on some fields (e.g. the forward-compat `artifactRefs`
// preprocessor).
type FrustrationSyncKeys = Pick<
  ParsedSyncedAgentSession,
  "frustrationRaw" | "frustrationScoreVersion"
>;
export const frustrationSyncKeysCovered: Record<
  keyof FrustrationSyncKeys,
  z.ZodTypeAny
> = {
  frustrationRaw: syncedAgentSessionSchema.shape.frustrationRaw,
  frustrationScoreVersion:
    syncedAgentSessionSchema.shape.frustrationScoreVersion,
};

// ISS-4586: same keys-covered contract for the ends_with_error sync field — a
// stripped field here would hide reaped runs from the reaper forever.
type EndsWithErrorSyncKeys = Pick<ParsedSyncedAgentSession, "endsWithError">;
export const endsWithErrorSyncKeyCovered: Record<
  keyof EndsWithErrorSyncKeys,
  z.ZodTypeAny
> = {
  endsWithError: syncedAgentSessionSchema.shape.endsWithError,
};

// ISS-8717: same keys-covered contract for the session-name override. The
// session schema is not `.strict()`, so a field it forgets is STRIPPED rather
// than rejected — a desktop-authored rename would vanish on ingest with no
// error anywhere. `tsc` fails here instead.
type NameOverrideSyncKeys = Pick<ParsedSyncedAgentSession, "nameOverride">;
export const nameOverrideSyncKeyCovered: Record<
  keyof NameOverrideSyncKeys,
  z.ZodTypeAny
> = {
  nameOverride: syncedAgentSessionSchema.shape.nameOverride,
};

// ISS-10332: same keys-covered contract for the desktop-set priority — a
// stripped field would silently lose every local-mode priority on ingest.
type PrioritySyncKeys = Pick<ParsedSyncedAgentSession, "priority">;
export const prioritySyncKeyCovered: Record<
  keyof PrioritySyncKeys,
  z.ZodTypeAny
> = {
  priority: syncedAgentSessionSchema.shape.priority,
};

// ISS-12251: same keys-covered contract for the session's creation time — a
// stripped field would leave every session at its first-sync time.
type CreatedAtSyncKeys = Pick<ParsedSyncedAgentSession, "createdAt">;
export const createdAtSyncKeyCovered: Record<
  keyof CreatedAtSyncKeys,
  z.ZodTypeAny
> = {
  createdAt: syncedAgentSessionSchema.shape.createdAt,
};

// ISS-8641 / ISS-8714 (review: davetho): same keys-covered contract for the
// degraded-metadata declaration. This one is the sharpest instance of the whole
// file's premise, because the field's ONLY job is to be present: silently
// stripping it here does not degrade the merge, it DISABLES it — the receiver
// reads absence as "an older build that states no opinion" and falls straight
// back to the destructive wholesale replace these tickets exist to stop. That
// failure is invisible on both sides (the producer's tests never cross this
// boundary and the receiver's fallback is a legitimate code path), so a type
// rename or a shape edit that drops the key must fail `tsc` here.
type MetadataWithheldKeysSyncKeys = Pick<
  ParsedSyncedAgentSession,
  "metadataWithheldKeys"
>;
export const metadataWithheldKeysSyncKeyCovered: Record<
  keyof MetadataWithheldKeysSyncKeys,
  z.ZodTypeAny
> = {
  metadataWithheldKeys: syncedAgentSessionSchema.shape.metadataWithheldKeys,
};

// Goal stage 2: same keys-covered contract for the batch-level
// `wantsAcceptedSessionIds` opt-in. A stripped flag would mean the handler
// never sees the opt-in and every new client silently loses row-level acks.
type WantsAcceptedSessionIdsKeys = Pick<
  ParsedDesktopAgentSessionsPayload,
  "wantsAcceptedSessionIds"
>;
export const wantsAcceptedSessionIdsKeyCovered: Record<
  keyof WantsAcceptedSessionIdsKeys,
  z.ZodTypeAny
> = {
  wantsAcceptedSessionIds:
    desktopAgentSessionsPayloadObjectSchema.shape.wantsAcceptedSessionIds,
};

// ISS-7516: same keys-covered contract for the batch-level `dataSyncLevel`. A
// stripped level would leave the column NULL for a desktop that DID report one,
// and the read side cannot tell that apart from "no level reported" — so the
// session-detail transcript panel would keep telling a metadata-level machine's
// reader that an upload is still coming. Silent, permanent, and invisible to the
// producer's own tests, which never cross this boundary.
type DataSyncLevelKeys = Pick<
  ParsedDesktopAgentSessionsPayload,
  "dataSyncLevel"
>;
export const dataSyncLevelKeyCovered: Record<
  keyof DataSyncLevelKeys,
  z.ZodTypeAny
> = {
  dataSyncLevel: desktopAgentSessionsPayloadObjectSchema.shape.dataSyncLevel,
};

/** What the Zod boundary actually admits as a batch `schemaVersion`. */
type BoundarySchemaVersion = z.infer<
  typeof desktopAgentSessionsPayloadObjectSchema
>["schemaVersion"];

/**
 * ISS-6886 accepted-versions agreement guard, and the only BIDIRECTIONAL one
 * here — the keys-covered guards above catch a dropped field, this catches a
 * silently narrowed or widened value set.
 *
 * The next version bump is exactly the moment the FEA-2718 mistake repeats: the
 * boundary literal moves and the previously-accepted version is quietly dropped,
 * stranding every installed client on the old one with no test necessarily red.
 * Passing the boundary's union where the contract's is required (and vice
 * versa) makes `tsc` fail if either side gains or loses a version the other
 * still names, so `ACCEPTED_AGENT_SESSION_SYNC_SCHEMA_VERSIONS` and this
 * boundary cannot drift apart. Never called; it exists to be typechecked.
 */
export function assertAcceptedSchemaVersionsAgree(
  fromBoundary: BoundarySchemaVersion,
  fromContract: AcceptedAgentSessionSyncSchemaVersion
): [AcceptedAgentSessionSyncSchemaVersion, BoundarySchemaVersion] {
  return [fromBoundary, fromContract];
}

/** What the Zod boundary actually admits as a COMPONENT batch `schemaVersion`. */
type ComponentBoundarySchemaVersion = z.infer<
  typeof desktopAgentComponentsPayloadSchema
>["schemaVersion"];

/**
 * ISS-8609's agreement guard, the component-lane twin of
 * {@link assertAcceptedSchemaVersionsAgree} and bidirectional for the same
 * reason.
 *
 * The component route validated `schemaVersion` against a single literal until
 * ISS-8609, so a bump was breaking by construction: moving the literal 400s every
 * installed desktop at once. Now that the boundary reads a TUPLE, the failure mode
 * inverts — the tuple and the boundary can silently disagree, and the bump that
 * drops a still-stamped version is exactly the edit nothing else reds on. Passing
 * each side's union where the other is required makes `tsc` fail if either gains
 * or loses a version. Never called; it exists to be typechecked.
 */
export function assertAcceptedComponentSchemaVersionsAgree(
  fromBoundary: ComponentBoundarySchemaVersion,
  fromContract: AcceptedAgentComponentSyncSchemaVersion
): [AcceptedAgentComponentSyncSchemaVersion, ComponentBoundarySchemaVersion] {
  return [fromBoundary, fromContract];
}

// ISS-4965: the same whole-shape guard over one retained variant, whose plain
// `z.object` would otherwise strip a new field (`usageScopeHash`) the packer sends.
export const syncedComponentVariantSyncKeysCovered: Record<
  keyof Required<SyncedComponentVariant>,
  z.ZodTypeAny
> = { ...syncedComponentVariantSchema.shape };
