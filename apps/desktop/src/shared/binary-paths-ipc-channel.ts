/** IPC channel names the binary-paths handler registers and the preload bridge invokes. */
export const BinaryPathsIpcChannel = {
  GetBinaryPaths: "desktop:get-binary-paths",
  PatchBinaryPaths: "desktop:patch-binary-paths",
  DetectCliTools: "desktop:detect-cli-tools",
} as const;

export type BinaryPathsIpcChannel =
  (typeof BinaryPathsIpcChannel)[keyof typeof BinaryPathsIpcChannel];
