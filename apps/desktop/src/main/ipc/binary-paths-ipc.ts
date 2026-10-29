import { resolveBinaryFromLoginShell } from "../../server/shell-path.js";
import { BinaryPathsIpcChannel } from "../../shared/binary-paths-ipc-channel.js";
import {
  type BinaryPaths,
  CLI_BINARY_TOOLS,
  type CliBinaryTool,
  stripLegacyCliBinaryPaths,
} from "../../shared/cli-binary-tools.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

export type { CliBinaryTool } from "../../shared/cli-binary-tools.js";

/** The stored binary-path override map — mirrors settings-store's `BinaryPaths`. */
type BinaryPathMap = BinaryPaths;
/** A binary-path override patch (null clears an override). */
export type BinaryPathPatch = Partial<Record<CliBinaryTool, string | null>>;

type IpcMainLike = {
  handle: (
    channel: BinaryPathsIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type BinaryPathsIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  getBinaryPaths: () => BinaryPathMap;
  applyBinaryPathPatch: (patch: BinaryPathPatch) => BinaryPathMap;
};

export function registerBinaryPathsIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: BinaryPathsIpcDeps
): void {
  ipcMainLike.handle(BinaryPathsIpcChannel.GetBinaryPaths, () =>
    stripLegacyCliBinaryPaths(deps.getBinaryPaths())
  );
  ipcMainLike.handle(BinaryPathsIpcChannel.PatchBinaryPaths, (event, patch) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    // `patch` is renderer-supplied; applyBinaryPathPatch canonicalizes and
    // validates each path (realpath + executable check) before persisting.
    return stripLegacyCliBinaryPaths(
      deps.applyBinaryPathPatch(patch as BinaryPathPatch)
    );
  });
  ipcMainLike.handle(BinaryPathsIpcChannel.DetectCliTools, async () => {
    const overrides = stripLegacyCliBinaryPaths(deps.getBinaryPaths());
    const names = CLI_BINARY_TOOLS;
    const results = await Promise.all(
      names.map(async (name) => {
        const override = overrides[name];
        const resolved = await resolveBinaryFromLoginShell(name, override);
        return {
          name,
          override: override ?? null,
          source: resolved.source,
          resolvedPath: resolved.source === "fallback" ? null : resolved.path,
        };
      })
    );
    return Object.fromEntries(results.map((r) => [r.name, r]));
  });
}
