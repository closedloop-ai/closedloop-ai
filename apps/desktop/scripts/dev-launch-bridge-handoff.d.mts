export const RENDERER_URL_ARG_PREFIX: "--closedloop-renderer-url=";

export function buildDevLaunchUrls(input: {
  baseUrl: string;
  clientToken: string;
}): {
  browserUrl: string;
  rendererUrl: string;
};

export function buildElectronLaunchOptions(input: {
  argv: readonly string[];
  baseEnv: NodeJS.ProcessEnv;
  hostToken: string;
  rendererUrl: string;
  useStaticRenderer: boolean;
}): {
  args: string[];
  env: NodeJS.ProcessEnv;
};

export function extraElectronArgs(argv: readonly string[]): string[];
