import { z } from "zod";
import {
  SyncObservabilityTier,
  type SyncObservabilityTier as SyncObservabilityTierValue,
} from "../../shared/contracts";
import type { SyncConsentRecord } from "../../shared/sync-consent";

const syncObservabilityTierSchema: z.ZodType<SyncObservabilityTierValue> =
  z.enum(
    Object.values(SyncObservabilityTier) as [
      SyncObservabilityTierValue,
      ...SyncObservabilityTierValue[],
    ]
  );

const syncConsentRecordSchema: z.ZodType<SyncConsentRecord> = z.object({
  bound: z.boolean(),
  organizationId: z.string().nullable(),
  tier: syncObservabilityTierSchema.nullable().default(null),
});

/** Parse a consent record that crossed the desktop preload bridge. */
export function parseSyncConsentRecord(raw: unknown): SyncConsentRecord | null {
  const parsed = syncConsentRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
