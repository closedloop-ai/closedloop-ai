export function transformTrustedLabels(
  code: string,
  filename: string,
  options?: { root?: string; includeTests?: boolean }
): { code: string; dependencies: string[] };
export function trustedLabelPlugin(): import("vite").Plugin;
