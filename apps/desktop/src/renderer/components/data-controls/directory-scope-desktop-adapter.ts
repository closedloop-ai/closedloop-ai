import type { PickedDirectory } from "@repo/app/shared/components/directory-scope-list-with-add";
import type { DirectoryScopePickPayload } from "../../../shared/directory-scope-ipc-channel";
import type { DesktopApi } from "../../types/desktop-api";

/**
 * Builds the `pickDirectory` callback `AddDirectoryAdapter` (ISS-12521) needs,
 * over the real `desktop:pick-directory-scope-entry` IPC channel.
 *
 * No production host wires this in yet. ISS-12521's own host-mount (AC-001)
 * is deliberately deferred: the per-directory scope's persistence model is
 * PRD-805's own "not yet ticketed" dependency, and inventing where
 * `entries`/`includedIds` are stored is a product decision this file does
 * not make. This adapter exists so the real IPC/preload contract has a
 * renderer-side consumer a wiring test can prove end to end (AC-004).
 */
export function createDesktopPickDirectory(
  desktopApi: Pick<DesktopApi, "pickDirectoryScopeEntry">
): () => Promise<PickedDirectory | null> {
  return async () => {
    const payload = await desktopApi.pickDirectoryScopeEntry();
    return payload === null ? null : toPickedDirectory(payload);
  };
}

function toPickedDirectory(
  payload: DirectoryScopePickPayload
): PickedDirectory {
  return {
    id: payload.path,
    label: payload.label,
    tccProtected: payload.tccProtected,
    unreadable: payload.unreadable,
  };
}
