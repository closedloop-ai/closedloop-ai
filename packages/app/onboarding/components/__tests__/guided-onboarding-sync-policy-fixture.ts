import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { SettingsLocalSyncPolicyProjection } from "@repo/api/src/types/settings-host-capabilities";
import { vi } from "vitest";

export function localSyncPolicy({
  isWriting = false,
  projection,
  supported = true,
  write = vi.fn(),
  writeOutcome = null,
}: {
  isWriting?: boolean;
  projection: SettingsLocalSyncPolicyProjection;
  supported?: boolean;
  write?: (level: DataSyncLevel) => void;
  writeOutcome?: SettingsLocalSyncPolicyProjection | null;
}) {
  return {
    isWriting,
    state: { projection, status: "settled" },
    supported,
    write,
    writeOutcome,
  };
}
