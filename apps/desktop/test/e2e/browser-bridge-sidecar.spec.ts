/**
 * ISS-8252: the sidecar's own end-to-end path, which no focused suite reaches.
 *
 * `dev:browser` → Vite + the broker → the real Electron host → `browser.html` →
 * `browser-main.ts` → `main.tsx`. A break anywhere in that chain leaves the tab
 * on its placeholder while every unit suite stays green, so this drives the
 * launcher exactly as `just desktop-browser` does and reads the URL off its
 * printed line — the token rides in that URL and cannot be reconstructed from
 * the port.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "@playwright/test";
import { REUSE_BUILD_ARG } from "../../scripts/dev-launch-steps.mjs";
import { launcherEnv } from "./helpers/bridge-launcher-env";
import {
  closeElectronApp,
  DESKTOP_ROOT,
  e2eAppLaunchArgs,
  RETURNING_INSTALL_LOCAL_STORAGE_SEED,
} from "./helpers/desktop-app";
import {
  firstWindowOrExplainExit,
  launchElectronOrExplain,
} from "./helpers/electron-launch-attribution";
import {
  gatewayListenGateEnv,
  gatewayListenGateLaunchArgs,
} from "./helpers/gateway-listen-gate";
import {
  captureProcessGroupId,
  killProcessGroup,
} from "./helpers/process-group-kill";
import { classifyDesktopPageError } from "./helpers/readiness-failure-diagnostic";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAB_HOST_MAIN = path.join(__dirname, "helpers/bridge-tab-host.cjs");
const BROWSER_URL_PATTERN = /^Desktop browser URL: (\S+)$/m;
/** The launcher rebuilds deps, the main process and the Prisma client first. */
const LAUNCHER_READY_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * The tab's first paint is a COLD Vite transform of the whole renderer graph:
 * `browser-main.ts` is tiny and hands off to `main.tsx`, which is not. Measured
 * over 3 minutes on a loaded machine, so this bound is about the dev server's
 * module graph rather than about the bridge.
 */
const MOUNT_TIMEOUT_MS = 8 * 60 * 1000;

test.describe.configure({ mode: "serial" });
test.setTimeout(LAUNCHER_READY_TIMEOUT_MS + MOUNT_TIMEOUT_MS + 60_000);

test("the sidecar browser tab mounts the real renderer over the bridge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-bridge-e2e-"));
  const userDataDir = path.join(root, "user-data");
  let launcher: ChildProcess | undefined;
  let launcherGroupId: number | undefined;
  let tabApp: ElectronApplication | undefined;
  let tabChild: ChildProcess | undefined;
  let tabGroupId: number | undefined;

  try {
    launcher = spawn(
      process.execPath,
      [
        path.join(DESKTOP_ROOT, "scripts/dev-launch.mjs"),
        "--browser-bridge",
        // The lane already ran `pnpm --filter desktop run build`, whose
        // `build:main` is the same Vite compile this would re-run —
        // and re-running it EMPTIES `dist/main`, the entry every other spec
        // launches, while a second Playwright worker is launching it. See
        // REUSE_BUILD_ARG for the run that proves it.
        REUSE_BUILD_ARG,
        // `dev-launch` forwards everything past `--` to the Electron app, so the
        // real host takes the same app-level switches as every other E2E launch
        // (ISS-5723): displayless unless `--debug`, and ephemeral loopback ports
        // so a second Playwright worker cannot collide on 4820/4318. Hiding the
        // bridge TAB says nothing about the host this spawns.
        "--",
        // Playwright passes this on every other desktop E2E launch, but this
        // host is spawned by the launcher rather than by `_electron.launch`,
        // so nothing else supplies it. Without it Electron aborts on the CI
        // runner's unconfigured `chrome-sandbox` before any window exists
        // ("The SUID sandbox helper binary was found, but is not configured
        // correctly"), and the tab then waits out its whole mount budget for a
        // host that is already dead.
        "--no-sandbox",
        ...gatewayListenGateLaunchArgs(),
        `--user-data-dir=${userDataDir}`,
        ...e2eAppLaunchArgs(false),
      ],
      {
        cwd: DESKTOP_ROOT,
        detached: true,
        env: {
          ...launcherEnv(root),
          ...gatewayListenGateEnv(false, userDataDir),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    launcherGroupId = captureProcessGroupId(launcher);
    const launcherOutput = captureLauncherOutput(launcher);
    const launcherChild = launcher;
    const browserUrl =
      await test.step("await the real bridge launcher URL", () =>
        readBrowserUrl(launcherChild, launcherOutput));

    tabApp = await launchElectronOrExplain(
      {
        args: [TAB_HOST_MAIN],
        env: {
          ...process.env,
          // ISS-10195 arms a guided-onboarding takeover on a first run, and
          // this tab is driven directly rather than through `launchDesktopApp`,
          // so nothing else settles it. Left armed, the modal takes the shell
          // over behind `aria-hidden` and the assertions below are unreachable.
          // ISS-10943: the host applies this before the page's first script, so
          // the shell reads it on its first paint and the tab never reloads.
          CLOSEDLOOP_BRIDGE_TAB_LOCAL_STORAGE_SEED: JSON.stringify(
            RETURNING_INSTALL_LOCAL_STORAGE_SEED
          ),
          CLOSEDLOOP_BRIDGE_TAB_PROFILE: path.join(root, "tab-profile"),
          CLOSEDLOOP_BRIDGE_TAB_URL: browserUrl,
        },
      },
      (prepared) => electron.launch(prepared)
    );
    // ISS-7654: the one moment the dispatcher is known live, and the reason
    // these are saved rather than read as arguments. Argument evaluation starts
    // `firstWindow()` FIRST, so a tab host that dies in that gap makes the
    // `process()` beside it throw off a disposed dispatcher — taking the whole
    // expression down before the race is ever set up, and leaving the started
    // window wait to reject with nobody observing it.
    tabChild = tabApp.process();
    // ISS-7697: and the same moment is the only one that can answer the group
    // question, since teardown may run against an already-reaped leader.
    tabGroupId = captureProcessGroupId(tabChild);

    const sidecarApp = tabApp;
    const sidecarChild = tabChild;
    const page = await test.step("await the sidecar first window", () =>
      firstWindowOrExplainExit(sidecarApp.firstWindow(), sidecarChild));
    const crashes: string[] = [];
    const pageErrorKinds: string[] = [];
    page.on("crash", () => crashes.push("the sidecar page crashed"));
    page.on("pageerror", (error) => {
      crashes.push(error.message);
      if (pageErrorKinds.length < 20) {
        pageErrorKinds.push(classifyDesktopPageError(error));
      }
    });

    // The handshake first, so a host that never connected is reported as that
    // rather than as a missing button three minutes later.
    await page
      .waitForFunction(() => "desktopApi" in globalThis.window, undefined, {
        timeout: MOUNT_TIMEOUT_MS,
      })
      .catch(async (error: unknown) => {
        await test
          .info()
          .attach("sidecar-api-handshake-errors", {
            body: Buffer.from(
              JSON.stringify({
                listenerInstalledAfterFirstWindow: true,
                pageErrorKinds,
              })
            ),
            contentType: "application/json",
          })
          .catch(() => undefined);
        throw new Error(
          `the sidecar never received a desktop API: ${String(error)}\n#root: ${await page
            .locator("#root")
            .innerText()
            .catch(() => "<unreadable>")}\nlauncher:\n${launcherOutput.tail()}`
        );
      });

    // Into the shell. Getting here at all means the handoff held: a broken
    // `browser.html` → `browser-main.ts` → `main.tsx` chain leaves `#root`
    // holding its "Connecting to Closedloop Desktop…" placeholder or the
    // bridge-failure alert, and neither renders the shell. By ROLE, which the
    // guided-onboarding seed above is what makes reachable: an open takeover
    // `aria-hidden`s the landmark while it is mounted and on screen.
    await expect(page.getByRole("main"))
      .toBeVisible({ timeout: MOUNT_TIMEOUT_MS })
      .catch((error: unknown) => {
        throw new Error(
          `the sidecar never reached the app shell: ${String(error)}\npage: ${crashes.join("; ")}\nlauncher:\n${launcherOutput.tail()}`
        );
      });
    // Only the destinations whose reads this mirror actually carries. Approvals
    // is deliberately NOT here: `getPendingApprovals` is absent from the
    // read-only projection, and `ApprovalsPanel` swallows the resulting failure
    // and renders "No pending approvals", so asserting its link would have
    // pinned a route to a screen that reports an empty queue it never read.
    for (const label of ["Dashboard", "Sessions", "Branches"]) {
      await expect(page.getByRole("link", { name: label })).toBeVisible();
    }
    const mirrored = await page
      .evaluate(async () => {
        const desktopApi = (
          globalThis.window as unknown as {
            desktopApi: {
              getRuntimeStatus: () => Promise<Record<string, unknown>>;
              getSettings: () => Promise<Record<string, unknown>>;
            };
          }
        ).desktopApi;
        const [runtimeStatus, settings] = await Promise.all([
          desktopApi.getRuntimeStatus(),
          desktopApi.getSettings(),
        ]);
        return {
          hasBinaryPaths: Object.hasOwn(settings, "binaryPaths"),
          hasSandboxRoot: Object.hasOwn(runtimeStatus, "sandboxBaseDirectory"),
          port: runtimeStatus.port,
          serverAlive: runtimeStatus.serverAlive,
        };
      })
      // A dropped HOST fails here, and only the launcher's output (the host is
      // its child) says why.
      .catch((error: unknown) => {
        throw new Error(
          `the mirrored read failed: ${String(error)}\nlauncher:\n${launcherOutput.tail()}`
        );
      });

    // The gateway port is minted by the Electron main process at runtime and
    // appears in no served asset, so a tab holding it read it over the bridge.
    expect(typeof mirrored.port).toBe("number");
    expect(mirrored.port).toBeGreaterThan(0);
    expect(mirrored.serverAlive).toBe(true);
    // ISS-8250 on the real wire, not just in the projection unit test.
    expect(mirrored.hasSandboxRoot).toBe(false);
    expect(mirrored.hasBinaryPaths).toBe(false);
  } finally {
    try {
      if (tabApp) {
        // The shared teardown every other launch in this suite uses: bounded at
        // 5s close + 5s kill, group-aware, and it REJECTS on a tab host that
        // outlived SIGKILL. A bare `close().catch(() => undefined)` was neither
        // — unbounded, so a wedged close ate the spec's own budget, and silent,
        // so a surviving Electron helper holding the inherited pipes hung the
        // Playwright worker at teardown with every assertion reported green.
        await closeElectronApp(tabApp, tabChild, tabGroupId);
      }
    } finally {
      // In a `finally` so a close/kill verdict cannot strand the launcher tree
      // or the temp root — same shape as `launchGuardedElectronApp`'s cleanup.
      killProcessGroup(launcher, launcherGroupId);
      fs.rmSync(root, { force: true, recursive: true });
    }
  }
});

type LauncherOutput = { stdout: () => string; tail: () => string };

/**
 * Keep the launcher's own narration. Every failure mode this spec has — the
 * host still building, Electron quitting on a lock, a broker refusing the
 * origin — is legible in it and invisible from the page.
 */
function captureLauncherOutput(launcher: ChildProcess): LauncherOutput {
  let combined = "";
  let stdout = "";
  launcher.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    combined += chunk.toString();
  });
  launcher.stderr?.on("data", (chunk: Buffer) => {
    combined += chunk.toString();
  });
  return {
    stdout: () => stdout,
    tail: () => combined.split("\n").slice(-40).join("\n"),
  };
}

function readBrowserUrl(
  launcher: ChildProcess,
  output: LauncherOutput
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`dev-launch never printed a browser URL.\n${output.tail()}`)
      );
    }, LAUNCHER_READY_TIMEOUT_MS);
    const poll = setInterval(() => {
      const match = BROWSER_URL_PATTERN.exec(output.stdout());
      if (match) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve(match[1]);
      }
    }, 250);

    launcher.on("error", (error) => {
      clearTimeout(timeout);
      clearInterval(poll);
      reject(error);
    });
    launcher.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(poll);
      reject(
        new Error(
          `dev-launch exited with ${code} before printing a browser URL.\n${output.tail()}`
        )
      );
    });
  });
}
