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
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const RENDERER_URL_ARG_PREFIX = "--closedloop-renderer-url=";

const nodeRequire = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(scriptDir, "..");
const prepareOnly = process.argv.includes("--prepare-only");
const useStaticRenderer = process.argv.includes("--static-renderer");

await runStep("pnpm", ["run", "build:deps"]);

let viteServer = null;
let rendererUrl = "";
if (!(prepareOnly || useStaticRenderer)) {
  viteServer = await createRendererServer();
  rendererUrl = new URL(
    "design-system/index.html",
    rendererServerBase(viteServer)
  ).href;
  warmRenderer(viteServer).catch((error) => {
    process.stderr.write(
      `renderer-warmup: ${error instanceof Error ? error.message : String(error)}\n`
    );
  });
}

for (const step of [
  ["pnpm", ["run", "prebuild"]],
  ["pnpm", ["run", "db:generate"]],
  ["pnpm", ["run", "build:main:dev"]],
]) {
  await runStep(step[0], step[1]);
}

if (useStaticRenderer) {
  await runStep("pnpm", ["run", "build:renderer"]);
}

if (prepareOnly) {
  process.exit(0);
}

const electronBin = resolveElectronBinary();
const electronProcess = spawn(
  electronBin,
  useStaticRenderer ? ["."] : [".", `${RENDERER_URL_ARG_PREFIX}${rendererUrl}`],
  {
    cwd: appDir,
    env: process.env,
    stdio: "inherit",
  }
);

electronProcess.on("error", async (error) => {
  await viteServer?.close();
  throw error;
});

electronProcess.on("exit", async (code, signal) => {
  await viteServer?.close();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    electronProcess.kill(signal);
    await viteServer?.close();
    process.exit(0);
  });
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
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      process.exit(code ?? 1);
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
