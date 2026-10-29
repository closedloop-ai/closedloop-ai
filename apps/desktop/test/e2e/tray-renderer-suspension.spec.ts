import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeNavPanel,
  gotoNavSettled,
  launchDesktopApp,
} from "./helpers/desktop-app.js";

const DB_HOST_PROCESS_NAME = "closedloop-db-host";
const APPROVALS_ROUTE_PATTERN = /#\/approvals$/;
const SESSIONS_ROUTE_PATTERN = /#\/sessions$/;

type NativeWindowSnapshot = {
  bounds: { x: number; y: number; width: number; height: number };
  rendererPid: number;
};

test("closing to the tray releases and recreates renderer generations", async () => {
  test.setTimeout(120_000);
  const launched = await launchDesktopApp({
    userDataPrefix: "desktop-tray-renderer-suspension-",
  });
  const replacementErrors = collectReplacementErrors(launched.app);
  const mainPid = launched.app.process().pid;
  if (mainPid === undefined) {
    throw new Error("Electron main process has no PID");
  }

  try {
    await gotoNavSettled(launched.page, "approvals");
    const before = await setStableWindowBounds(launched.app);
    const dbHostPid = await waitForNamedProcess(
      launched.app,
      DB_HOST_PROCESS_NAME
    );

    await closeRenderer(launched.app, launched.page, before.rendererPid);
    const restoredPage = await reopenViaActivate(launched.app);
    await expect(restoredPage).toHaveURL(APPROVALS_ROUTE_PATTERN);
    expect((await readWindowSnapshot(launched.app)).bounds).toEqual(
      before.bounds
    );

    await restoredPage.evaluate(() => {
      const desktopApi: unknown = Reflect.get(window, "desktopApi");
      if (typeof desktopApi !== "object" || desktopApi === null) {
        throw new Error("Desktop API is unavailable");
      }
      const openAgentMonitor: unknown = Reflect.get(
        desktopApi,
        "openAgentMonitor"
      );
      if (typeof openAgentMonitor !== "function") {
        throw new Error("Agent Dashboard open path is unavailable");
      }
      return Reflect.apply(openAgentMonitor, desktopApi, []);
    });
    await expect(activeNavPanel(restoredPage, "sessions")).toBeVisible({
      timeout: 30_000,
    });
    const restored = await readWindowSnapshot(launched.app);
    await closeRenderer(launched.app, restoredPage, restored.rendererPid);
    const routeReopenedPage = await reopenViaActivate(launched.app);
    await expect(routeReopenedPage).toHaveURL(SESSIONS_ROUTE_PATTERN);
    await expect(activeNavPanel(routeReopenedPage, "sessions")).toBeVisible({
      timeout: 30_000,
    });

    const routeReopened = await readWindowSnapshot(launched.app);
    expect(routeReopened.rendererPid).not.toBe(restored.rendererPid);
    expect(launched.app.process().pid).toBe(mainPid);
    expect(await isProcessAlive(launched.app, mainPid)).toBe(true);
    expect(await getNamedProcessPid(launched.app, DB_HOST_PROCESS_NAME)).toBe(
      dbHostPid
    );
    expect(launched.pageErrors).toEqual([]);
    expect(launched.consoleErrors).toEqual([]);
    expect(replacementErrors.page).toEqual([]);
    expect(replacementErrors.console).toEqual([]);

    const appClosed = launched.app.waitForEvent("close");
    await launched.app.evaluate(({ app }) => app.quit());
    await appClosed;
  } finally {
    await launched.cleanup();
  }
});

function collectReplacementErrors(app: ElectronApplication): {
  console: string[];
  page: Error[];
} {
  const errors = { console: [] as string[], page: [] as Error[] };
  app.on("window", (page) => {
    page.on("pageerror", (error) => errors.page.push(error));
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.console.push(message.text());
      }
    });
  });
  return errors;
}

async function closeRenderer(
  app: ElectronApplication,
  page: Page,
  rendererPid: number
): Promise<void> {
  const pageClosed = page.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await pageClosed;
  await expect.poll(() => countBrowserWindows(app)).toBe(0);
  await expect.poll(() => isProcessAlive(app, rendererPid)).toBe(false);
}

async function reopenViaActivate(app: ElectronApplication): Promise<Page> {
  const reopenedPagePromise = app.waitForEvent("window");
  await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"));
  const page = await reopenedPagePromise;
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function setStableWindowBounds(
  app: ElectronApplication
): Promise<NativeWindowSnapshot> {
  const snapshot = await app.evaluate(({ BrowserWindow, screen }) => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) {
      return null;
    }
    const workArea = screen.getDisplayMatching(window.getBounds()).workArea;
    const bounds = {
      x: workArea.x + 40,
      y: workArea.y + 40,
      width: Math.min(900, workArea.width - 80),
      height: Math.min(600, workArea.height - 80),
    };
    window.setBounds(bounds);
    return {
      bounds: window.getNormalBounds(),
      rendererPid: window.webContents.getOSProcessId(),
    };
  });
  if (!snapshot) {
    throw new Error("No BrowserWindow was open to resize");
  }
  return snapshot;
}

async function readWindowSnapshot(
  app: ElectronApplication
): Promise<NativeWindowSnapshot> {
  const snapshot = await app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    return window
      ? {
          bounds: window.getNormalBounds(),
          rendererPid: window.webContents.getOSProcessId(),
        }
      : null;
  });
  if (!snapshot) {
    throw new Error("No replacement BrowserWindow was open");
  }
  return snapshot;
}

function countBrowserWindows(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
  );
}

function isProcessAlive(
  app: ElectronApplication,
  processId: number
): Promise<boolean> {
  return app.evaluate((_electron, pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }, processId);
}

function getNamedProcessPid(
  app: ElectronApplication,
  processName: string
): Promise<number | null> {
  return app.evaluate(({ app: electronApp }, name) => {
    return (
      electronApp.getAppMetrics().find((metric) => metric.name === name)?.pid ??
      null
    );
  }, processName);
}

async function waitForNamedProcess(
  app: ElectronApplication,
  processName: string
): Promise<number> {
  await expect
    .poll(() => getNamedProcessPid(app, processName), { timeout: 30_000 })
    .not.toBeNull();
  const pid = await getNamedProcessPid(app, processName);
  if (pid === null) {
    throw new Error(`Process did not start: ${processName}`);
  }
  return pid;
}
