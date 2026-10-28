import type { SettingsLocalDeviceSnapshot } from "@repo/api/src/types/settings-host-capabilities";
import { z } from "zod";

/**
 * ISS-8379 (PRD-691) — the main↔renderer contract for the Settings local-device
 * read. Lives in `src/shared/` so the producer (main) and the consumer
 * (renderer) cannot drift on the channel name or the payload shape; the
 * projection TYPE it validates is owned by `@repo/api` because `@repo/app`
 * renders the same projection and cannot import from `apps/desktop` (same split
 * as `data-sync-level.ts`).
 *
 * Why a channel rather than a field on `desktop:get-runtime-status`: that
 * payload is `unknown` on the bridge, has no schema to extend, and is polled on
 * a 1s cadence by the connection indicator. This read happens when Settings
 * opens and must be validated, so it gets its own gated channel rather than
 * widening a hot, unvalidated one. The gateway transports are not an option
 * either: `GATEWAY_DISPATCH_ALLOWED_PATHS` is empty by design and widening it is
 * a separate security decision.
 */
export const SETTINGS_LOCAL_DEVICE_CHANNEL =
  "desktop:get-settings-local-device";

/**
 * `computeTargetId` accepts `null` as well as omission on the READ side while
 * the producer only ever OMITS it (see `settings-local-device-ipc.ts`). A skewed
 * peer that serializes `null` is degraded to "absent" rather than failing the
 * whole payload, which would strand the panel in an error state over a field it
 * does not need.
 */
const settingsLocalDeviceSnapshotShape = {
  machineName: z.string().min(1),
  platform: z.string().min(1),
  appVersion: z.string().min(1),
  gatewayPort: z.number().int().min(1).max(65_535),
  gatewayReachable: z.boolean(),
  computeTargetId: z.string().min(1).nullish(),
  // Keys-covered guard: a field added to `SettingsLocalDeviceSnapshot` fails
  // typecheck HERE rather than being silently stripped in production.
} satisfies Record<keyof SettingsLocalDeviceSnapshot, z.ZodTypeAny>;

/**
 * Deliberately NOT `.strict()`. Main and renderer ship together in one build,
 * but a renderer loaded from a newer main during an in-place update would see
 * fields it has never heard of, and a strict object would reject the entire
 * payload rather than ignore them.
 */
export const settingsLocalDeviceSnapshotSchema = z.object(
  settingsLocalDeviceSnapshotShape
);

/** `null` for any payload this build cannot validate — never a partial record. */
export function parseSettingsLocalDeviceSnapshot(
  value: unknown
): SettingsLocalDeviceSnapshot | null {
  const parsed = settingsLocalDeviceSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const { computeTargetId, ...rest } = parsed.data;
  return {
    ...rest,
    ...(computeTargetId ? { computeTargetId } : {}),
  };
}
