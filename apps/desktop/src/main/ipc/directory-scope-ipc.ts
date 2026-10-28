import { dialog } from "electron";
import {
  DirectoryScopeIpcChannel,
  type DirectoryScopePickPayload,
} from "../../shared/directory-scope-ipc-channel.js";
import { isTccProtectedPath } from "../../shared/sandbox-policy.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

type IpcMainLike = {
  handle: (
    channel: DirectoryScopeIpcChannel,
    listener: (event: unknown) => unknown
  ) => void;
};

type DirectoryScopeIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
};

export function registerDirectoryScopeIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: DirectoryScopeIpcDeps
): void {
  ipcMainLike.handle(DirectoryScopeIpcChannel.PickDirectory, async (event) => {
    // Gate on sender trust like the other desktop:* handlers so an untrusted
    // frame cannot pop the native directory picker.
    assertTrustedIpcSender(deps.isTrustedSender, event);
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return await describePick(result.filePaths[0]);
  });
}

/**
 * The verdicts ISS-12521's add control resolves its outcome from.
 *
 * `isTccProtectedPath` (ISS-11914) is the only predicate that holds for a
 * user-picked path: its sibling `isTccProtectedDirectory` matches a direct
 * child of home or a `.photoslibrary` bundle and nothing else, so
 * `~/Documents/acme`, `~/Library/CloudStorage/…` and `/Volumes/…` read as
 * unprotected and reached `entries`/`includedIds`, which `PickedDirectory`
 * forbids for a protected folder (tamsinb, whitlockk, PR #8917).
 *
 * TCC is checked before the probe because opening a protected folder raises
 * the macOS prompt the predicate exists to avoid, and
 * `resolveAddDirectoryOutcome` returns `Protected` without reading
 * `unreadable` — so that field is `false` there: not probed, never consulted.
 *
 * `Unknown` counts as unreadable. It is what `classifyAccessError` could not
 * name (`EIO` on a flaky mount, `ELOOP`, `ENOTDIR` on a bundle); folding it
 * to `Added` puts a path in `includedIds` that `collectJsonlFiles` then skips
 * on its swallowed readdir error — the silent under-population this probe
 * exists to surface (marisolashgrove, PR #8917). `Absent` still folds to
 * readable: the native dialog only returns directories that exist.
 *
 * The import is dynamic because `boot-no-design-system-runtime`
 * (`assert-design-system-boundary.mjs`) holds the whole `collectors/` subtree
 * out of the eager boot graph this handler is registered from.
 */
async function describePick(path: string): Promise<DirectoryScopePickPayload> {
  const { abbreviateHomePath, checkPathReadableAsync, PathReadability } =
    await import("../collectors/engine/file-access-probe.js");
  // Exhaustive, so a fifth `PathReadability` member fails typecheck here
  // instead of silently inheriting one of the two answers.
  const unreadableByVerdict: Record<
    (typeof PathReadability)[keyof typeof PathReadability],
    boolean
  > = {
    [PathReadability.Readable]: false,
    [PathReadability.Absent]: false,
    [PathReadability.Blocked]: true,
    [PathReadability.Unknown]: true,
  };
  const tccProtected = isTccProtectedPath(path);
  return {
    label: abbreviateHomePath(path),
    path,
    tccProtected,
    unreadable: tccProtected
      ? false
      : unreadableByVerdict[await checkPathReadableAsync(path)],
  };
}
