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
import type {
  DesktopAgentSessionsPayload as ParsedDesktopAgentSessionsPayload,
  SyncedAgentSession as ParsedSyncedAgentSession,
  SyncedComponent as ParsedSyncedComponent,
} from "@repo/api/src/types/agent-session";
import type { z } from "zod";
import {
  desktopAgentSessionsPayloadObjectSchema,
  syncedAgentSessionSchema,
  syncedAgentSessionTokenEventObjectSchema,
  syncedComponentFieldsSchema,
} from "./desktop-agent-sessions-schema";

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
