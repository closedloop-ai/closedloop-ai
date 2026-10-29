// @ts-check
/**
 * How the dev launcher hands each browser-bridge launch token to the process
 * that needs it (ISS-8412).
 *
 * The CLIENT token rides the URL the launcher prints, because the operator is
 * the one who has to open it. The HOST token has no reader, so it takes the
 * narrowest channel the launcher can reach Electron over: the child's own
 * environment. It used to ride `--closedloop-renderer-url=`, and process
 * arguments are world-readable on macOS and Linux — `ps -ef | grep -i electron`
 * published a credential that mints an authorized bridge host to every local
 * process, including one running as a different user.
 *
 * The residual risk the environment leaves, stated rather than waved away: a
 * same-user process with debugger rights can still read another process's
 * environment (`/proc/<pid>/environ` on Linux), and a crash dump that captures
 * the environment captures this with it. What it buys is the cross-user and
 * `ps`-readability half, plus a variable the main process deletes on boot so
 * nothing it later spawns inherits it.
 */

import {
  desktopBrowserBridgeHostTokenEnvVar,
  desktopBrowserBridgeTokenParam,
} from "../src/shared/desktop-browser-bridge-contract.mjs";

export const RENDERER_URL_ARG_PREFIX = "--closedloop-renderer-url=";

/**
 * The two entry documents a launch serves: the one Electron loads, and the one
 * the operator opens.
 *
 * Only the browser entry carries a token. The Electron entry deliberately
 * carries NONE, because its URL is about to become a process argument; the main
 * process appends the host token to the URL it loads, in-process, from the
 * environment variable this module's sibling puts it in.
 *
 * @param {{ baseUrl: string; clientToken: string }} input
 * @returns {{ browserUrl: string; rendererUrl: string }}
 */
export function buildDevLaunchUrls(input) {
  const rendererUrl = new URL("design-system/index.html", input.baseUrl).href;
  if (input.clientToken.length === 0) {
    return { browserUrl: "", rendererUrl };
  }
  const browserUrl = new URL("design-system/browser.html", input.baseUrl);
  browserUrl.searchParams.set(
    desktopBrowserBridgeTokenParam,
    input.clientToken
  );
  return { browserUrl: browserUrl.href, rendererUrl };
}

/**
 * The arguments and environment Electron is spawned with.
 *
 * Refuses a renderer URL that carries a bridge token rather than passing it on.
 * That is the whole defect this module exists to prevent, and the check sits
 * here because this is the last point before the string becomes argv — a
 * caller that reintroduces the parameter upstream fails loudly at launch
 * instead of silently republishing the credential.
 *
 * @param {{
 *   argv: readonly string[];
 *   baseEnv: NodeJS.ProcessEnv;
 *   hostToken: string;
 *   rendererUrl: string;
 *   useStaticRenderer: boolean;
 * }} input
 * @returns {{ args: string[]; env: NodeJS.ProcessEnv }}
 */
export function buildElectronLaunchOptions(input) {
  assertNoBridgeTokenInRendererUrl(input.rendererUrl);
  const forwarded = partitionElectronPreloads(extraElectronArgs(input.argv));
  const args = [
    ...forwarded.preloadArgs,
    ".",
    ...(input.useStaticRenderer
      ? []
      : [`${RENDERER_URL_ARG_PREFIX}${input.rendererUrl}`]),
    ...forwarded.applicationArgs,
  ];
  if (input.hostToken.length === 0) {
    return { args, env: input.baseEnv };
  }
  return {
    args,
    env: {
      ...input.baseEnv,
      [desktopBrowserBridgeHostTokenEnvVar]: input.hostToken,
    },
  };
}

/**
 * Arguments after a bare `--` go to Electron rather than the launcher, so a
 * caller can hand it switches Electron owns (`--user-data-dir=…` for a profile
 * that is not the operator's) without the launcher having to know each one.
 *
 * @param {readonly string[]} argv
 * @returns {string[]}
 */
export function extraElectronArgs(argv) {
  const separator = argv.indexOf("--");
  return separator === -1 ? [] : argv.slice(separator + 1);
}

/** @param {string} rendererUrl */
function assertNoBridgeTokenInRendererUrl(rendererUrl) {
  if (rendererUrl.length === 0) {
    return;
  }
  let parsed;
  try {
    parsed = new URL(rendererUrl);
  } catch {
    return;
  }
  if (parsed.searchParams.has(desktopBrowserBridgeTokenParam)) {
    throw new Error(
      "Refusing to launch Electron with a bridge token in its renderer URL: " +
        "process arguments are world-readable (ISS-8412)"
    );
  }
}

/**
 * Electron stops parsing preload options at the app entry. Move only complete
 * pairs before it; malformed pairs and every other argument keep their order.
 * @param {readonly string[]} args
 */
function partitionElectronPreloads(args) {
  const preloadArgs = [];
  const applicationArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const modulePath = args[index + 1];
    if (
      (argument === "-r" || argument === "--require") &&
      modulePath &&
      !modulePath.startsWith("-")
    ) {
      preloadArgs.push(argument, modulePath);
      index += 1;
    } else {
      applicationArgs.push(argument);
    }
  }
  return { preloadArgs, applicationArgs };
}
