export const REUSE_BUILD_ARG: "--reuse-build";

export function devLaunchBuildSteps(argv: readonly string[]): {
  beforeServer: string[];
  afterServer: string[];
};
