"use strict";
/**
 * A bare browser host for the Desktop browser bridge's sidecar tab.
 *
 * The sidecar is a plain page: no node integration, no `window.desktopApi`
 * until the bridge handshake supplies one. A Chromium window with those
 * privileges withheld is exactly that, and using Electron's own Chromium keeps
 * the spec runnable wherever `desktop-e2e` already runs — the CI lane installs
 * Chromium's system libraries for Electron but never downloads a Playwright
 * browser binary.
 *
 * The one preload (ISS-10943) grants the page nothing: it seeds `localStorage`
 * from the isolated world, requires nothing, and bridges nothing, so the
 * handshake is still the only thing that can supply `desktopApi`.
 */
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

/**
 * ISS-10943: seeds the guided-onboarding record the shell must already hold on
 * its first paint, from the `CLOSEDLOOP_BRIDGE_TAB_LOCAL_STORAGE_SEED` this
 * process inherits. `bridge-tab-seed-preload.cjs` is where the why lives,
 * including why this is a preload and not a reload.
 */
const SEED_PRELOAD = path.join(__dirname, "bridge-tab-seed-preload.cjs");

// A per-run profile. Without it this bare host lands on the shared default
// Electron profile, and whatever first-run state one run writes into the PAGE's
// localStorage — the guided-onboarding record the spec seeds, the dashboard's
// first-launch latch — carries into every later run.
app.setPath("userData", process.env.CLOSEDLOOP_BRIDGE_TAB_PROFILE);

app.whenReady().then(() => {
  // Electron grants several permissions without prompting; a browser tab does
  // not. Deny them all so this host is not more privileged than what it stands
  // in for.
  session.defaultSession.setPermissionRequestHandler((_contents, _name, done) =>
    done(false)
  );
  const window = new BrowserWindow({
    height: 900,
    show: false,
    webPreferences: {
      // Off by default for a window that is never shown, and it throttles
      // timers hard enough that the renderer's first paint — a cold Vite
      // transform of the whole module graph — stalls or dies outright.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: SEED_PRELOAD,
      sandbox: true,
    },
    width: 1440,
  });
  // `loadURL` rejects with ERR_ABORTED when the page routes itself during load
  // — which this one does, both to strip its launch token and to enter its hash
  // route. An unhandled rejection here takes the whole main process down and
  // the spec sees only "browser has been closed".
  window.loadURL(process.env.CLOSEDLOOP_BRIDGE_TAB_URL).catch(() => undefined);
});

app.on("window-all-closed", () => {
  app.quit();
});
