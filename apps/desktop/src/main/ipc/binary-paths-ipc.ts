import { resolveBinaryFromLoginShell } from "../../server/shell-path.js";
import { CLI_BINARY_TOOLS } from "../../shared/cli-binary-tools.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

export const BinaryPathsIpcChannel = {
  GetBinaryPaths: "desktop:get-binary-paths",
  PatchBinaryPaths: "desktop:patch-binary-paths",
  DetectCliTools: "desktop:detect-cli-tools",
} as const;

export type BinaryPathsIpcChannel =
  (typeof BinaryPathsIpcChannel)[keyof typeof BinaryPathsIpcChannel];

/** Persistable CLI binary-override keys (single source of truth in the shared list). */
export type CliBinaryTool = (typeof CLI_BINARY_TOOLS)[number];
/** The stored binary-path override map — mirrors settings-store's `BinaryPaths`. */
type BinaryPathMap = Partial<Record<CliBinaryTool, string>>;
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
    deps.getBinaryPaths()
  );
  ipcMainLike.handle(BinaryPathsIpcChannel.PatchBinaryPaths, (event, patch) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    // `patch` is renderer-supplied; applyBinaryPathPatch canonicalizes and
    // validates each path (realpath + executable check) before persisting.
    return deps.applyBinaryPathPatch(patch as BinaryPathPatch);
  });
  ipcMainLike.handle(BinaryPathsIpcChannel.DetectCliTools, async () => {
    const overrides = deps.getBinaryPaths();
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
