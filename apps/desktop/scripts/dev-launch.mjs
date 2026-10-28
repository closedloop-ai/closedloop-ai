// @ts-check
/**
 * Fast local Desktop launcher.
 *
 * It prepares dependency output with Turbo, emits the main process
 * incrementally, serves the renderer from Vite, and then starts Electron with
 * a localhost-only renderer URL argument. Production/package builds keep using
 * the clean `pnpm build` path.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { startDesktopBrowserBridgeServer } from "./desktop-browser-bridge-server.mjs";
import {
  buildDevLaunchUrls,
  buildElectronLaunchOptions,
} from "./dev-launch-bridge-handoff.mjs";
import {
  createSignalShutdown,
  handleBuildStepExit,
  handleElectronExit,
} from "./dev-launch-exit.mjs";
import { devLaunchBuildSteps } from "./dev-launch-steps.mjs";

const nodeRequire = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(scriptDir, "..");
const prepareOnly = process.argv.includes("--prepare-only");
const useStaticRenderer = process.argv.includes("--static-renderer");
const useBrowserBridge = process.argv.includes("--browser-bridge");

// Only the ENABLED flag becomes a Vite env value. The tokens deliberately do
// NOT: `import.meta.env` is inlined into the module the dev server serves to
// anyone who asks, so a token there is readable by any local process. Each role
// receives its own token over its own channel instead — the client's on the URL
// printed below, the host's in the Electron child's environment (ISS-8412).
const browserBridgeHostToken = useBrowserBridge ? mintLaunchToken() : "";
const browserBridgeClientToken = useBrowserBridge ? mintLaunchToken() : "";
if (useBrowserBridge) {
  process.env.VITE_DESKTOP_BROWSER_BRIDGE_ENABLED = "1";
}

const buildSteps = devLaunchBuildSteps(process.argv);

for (const script of buildSteps.beforeServer) {
  await runStep("pnpm", ["run", script]);
}

let viteServer = null;
let browserBridgeServer = null;
let rendererUrl = "";
let browserBridgeUrl = "";
if (!(prepareOnly || useStaticRenderer)) {
  viteServer = await createRendererServer();
  const baseUrl = rendererServerBase(viteServer);
  if (useBrowserBridge) {
    browserBridgeServer = startDesktopBrowserBridgeServer({
      allowedOrigin: new URL(baseUrl).origin,
      clientToken: browserBridgeClientToken,
      hostToken: browserBridgeHostToken,
      httpServer: viteServer.httpServer,
    });
  }
  const launchUrls = buildDevLaunchUrls({
    baseUrl,
    clientToken: browserBridgeClientToken,
  });
  browserBridgeUrl = launchUrls.browserUrl;
  rendererUrl = launchUrls.rendererUrl;
  warmRenderer(viteServer).catch((error) => {
    process.stderr.write(
      `renderer-warmup: ${error instanceof Error ? error.message : String(error)}\n`
    );
  });
}

for (const script of buildSteps.afterServer) {
  await runStep("pnpm", ["run", script]);
}

if (prepareOnly) {
  process.exit(0);
}

const electronBin = resolveElectronBinary();
const electronLaunch = buildElectronLaunchOptions({
  argv: process.argv,
  baseEnv: process.env,
  hostToken: browserBridgeHostToken,
  rendererUrl,
  useStaticRenderer,
});
const electronProcess = spawn(electronBin, electronLaunch.args, {
  cwd: appDir,
  env: electronLaunch.env,
  stdio: "inherit",
});

// ISS-8248: printed only once Electron has been spawned, so the reader never
// receives the URL during `build:deps` / `prebuild` / `build:main:dev` — on a
// cold tree those exceed the client's host-ready window on their own.
if (browserBridgeUrl.length > 0) {
  process.stdout.write(`Desktop browser URL: ${browserBridgeUrl}\n`);
}

electronProcess.on("error", async (error) => {
  await browserBridgeServer?.close();
  await viteServer?.close();
  throw error;
});

electronProcess.on("exit", (code, signal) => {
  // ISS-4474: exit cleanly with a conventional status rather than re-raising a
  // fatal signal on ourselves. A signal death here (e.g. a SIGHUP when the TTY
  // goes away while the db-host is bouncing mid-backfill) must not cascade into
  // a fatal `just desktop-dev` termination — the db-host bounce is already
  // contained by the DbHostClient supervisor.
  handleElectronExit(code, signal, {
    cleanup: closeServers,
    exit: (status) => process.exit(status),
  });
});

// ISS-4474: SIGHUP is included so a TTY disconnect delivered DIRECTLY to the
// non-detached launcher (not only via the Electron child's exit) is contained
// too — we forward it to the child and exit CLEANLY here rather than letting
// Node's default disposition terminate the launcher BY SIGHUP, which would
// re-raise the fatal-signal cascade to the `just` recipe. ISS-12135: the
// close is bounded, so a server that never finishes closing cannot keep the
// launcher alive.
const shutDownOnSignal = createSignalShutdown({
  forward: (signal) => electronProcess.kill(signal),
  cleanup: closeServers,
  exit: (status) => process.exit(status),
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, shutDownOnSignal);
}

async function closeServers() {
  await browserBridgeServer?.close();
  await viteServer?.close();
}

function mintLaunchToken() {
  return randomBytes(32).toString("base64url");
}

function runStep(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appDir,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      // ISS-4474: a build-step child dying to a signal exits the launcher
      // cleanly with a conventional status instead of re-raising the fatal
      // signal (which would cascade to the `just` recipe as a fatal crash).
      handleBuildStepExit(code, signal, {
        exit: (status) => process.exit(status),
        resolve,
      });
    });
  });
}

async function createRendererServer() {
  const server = await createServer({
    configFile: path.join(appDir, "vite.renderer.config.ts"),
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });

  await server.listen();
  return server;
}

async function warmRenderer(server) {
  await Promise.all([
    server.warmupRequest("/main.tsx"),
    server.warmupRequest("/App.tsx"),
    server.warmupRequest(
      "/shared-agent-sessions/desktop-app-core-provider.tsx"
    ),
    server.warmupRequest("/components/sessions/SessionsView.tsx"),
    ...(useBrowserBridge ? [server.warmupRequest("/browser-main.ts")] : []),
  ]);
}

function resolveElectronBinary() {
  // The `electron` package resolves to the absolute path of its platform binary
  // when imported from Node. On macOS that's `electron/dist/Electron.app/...`.
  const electronBinary = nodeRequire("electron");
  if (typeof electronBinary !== "string" || electronBinary.length === 0) {
    throw new Error("electron package did not resolve to a binary path");
  }
  if (!existsSync(electronBinary)) {
    throw new Error(
      `Electron binary missing at ${electronBinary}. If you previously ran the ` +
        "old dev launcher it renamed this app in node_modules; restore it with " +
        "`pnpm verify:electron-binary`."
    );
  }
  return electronBinary;
}

function rendererServerBase(server) {
  const localUrl = server.resolvedUrls?.local?.[0];
  if (localUrl) {
    return localUrl;
  }

  const address = server.httpServer?.address();
  if (address && typeof address !== "string") {
    return `http://127.0.0.1:${address.port}/`;
  }

  throw new Error("Vite dev server did not expose a local URL");
}
