import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron, {
  app,
  BrowserWindow,
  protocol,
  shell,
  type WebContents,
} from "electron";
import { CONTENT_SECURITY_POLICY_HEADER } from "../shared/content-security-policy.js";
import { isAllowedExternalUrl } from "./external-url-allowlist.js";
import { gatewayLog } from "./gateway-logger.js";
import { resolveDevRendererUrl } from "./renderer-dev-url.js";
import {
  evaluateFrameRecovery,
  evaluateRenderProcessGone,
  isFrameDisposed,
  sendToRendererWindow,
} from "./renderer-ipc.js";
import { loadRendererContent } from "./renderer-load.js";

const { powerMonitor } = electron;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RENDERER_DIR = path.resolve(__dirname, "..", "renderer");
const DESIGN_RENDERER_DIR = path.join(RENDERER_DIR, "design-system");
const ASSETS_RENDERER_DIR = path.join(RENDERER_DIR, "assets");
const DESIGN_RENDERER_URL = "app://renderer/design-system/index.html";
const APP_PROTOCOL = "app";

// macOS stoplight position for the hidden title bar. y is tuned to the inset
// shell (renderer globals.css) so the buttons line up with the Topbar; bump it
// together with the inset/Topbar height if either changes.
const TRAFFIC_LIGHT_POSITION = { x: 19, y: 17 };

// FEA-2648: window title in golden launch mode. Re-asserted on did-finish-load
// because the renderer HTML `<title>` would otherwise override the option.
const GOLDEN_WINDOW_TITLE = "Closedloop — GOLDEN";

let appProtocolRegistered = false;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const APP_PROTOCOL_EXTENSIONS = new Set(Object.keys(MIME_TYPES));

function mimeType(ext: string): string {
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function registerAppProtocol(): void {
  if (appProtocolRegistered) {
    return;
  }

  protocol.handle(APP_PROTOCOL, (request) => {
    return serveAppProtocolAsset(request);
  });
  appProtocolRegistered = true;
}

function serveAppProtocolAsset(request: Request): Response {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (url.protocol !== `${APP_PROTOCOL}:` || url.hostname !== "renderer") {
    return new Response("Not found", { status: 404 });
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (decodedPathname.includes("\0") || decodedPathname.includes("\\")) {
    return new Response("Not found", { status: 404 });
  }

  const assetRoot = resolveAppProtocolRoot(decodedPathname);
  if (!assetRoot) {
    return new Response("Not found", { status: 404 });
  }

  const relativePath = decodedPathname.replace(/^\//, "");
  const pathParts = relativePath.split("/");
  if (pathParts.includes("..") || path.isAbsolute(relativePath)) {
    return new Response("Forbidden", { status: 403 });
  }

  const filePath = path.resolve(RENDERER_DIR, relativePath);
  if (!isPathInside(filePath, assetRoot)) {
    return new Response("Forbidden", { status: 403 });
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!APP_PROTOCOL_EXTENSIONS.has(ext)) {
    return new Response("Not found", { status: 404 });
  }

  if (!existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }

  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(assetRoot);
    realFile = realpathSync(filePath);
    if (!(statSync(realFile).isFile() && isPathInside(realFile, realRoot))) {
      return new Response("Forbidden", { status: 403 });
    }
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const data = readFileSync(realFile);
  const headers: Record<string, string> = { "Content-Type": mimeType(ext) };
  // Deliver the strict CSP on the renderer document itself. The session-wide
  // onHeadersReceived hook (content-security-policy.ts) sets the same header,
  // but attaching it to the protocol.handle Response guarantees enforcement
  // even where webRequest does not observe custom-protocol responses; the
  // build-injected <meta> CSP in index.html is the third layer.
  if (ext === ".html") {
    headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY_HEADER;
  }
  return new Response(data, { status: 200, headers });
}

function resolveAppProtocolRoot(pathname: string): string | null {
  if (pathname.startsWith("/design-system/")) {
    return DESIGN_RENDERER_DIR;
  }
  if (pathname.startsWith("/assets/")) {
    return ASSETS_RENDERER_DIR;
  }
  return null;
}

export type DesktopWindowOptions = {
  /** FEA-2648: mark the window as golden launch mode. */
  golden?: boolean;
};

export class DesktopWindow {
  private readonly golden: boolean;
  private browserWindow: BrowserWindow | null = null;
  private disposing = false;
  private quitting = false;
  private allowedRendererUrl: string | null = null;
  private initiallyShown = false;
  private readonly initialShowResolvers = new Set<() => void>();
  private crashReloadTimestamps: number[] = [];
  private recovering = false;
  private resumeHandler: (() => void) | null = null;
  private childProcessGoneHandler:
    | ((event: Electron.Event, details: Electron.Details) => void)
    | null = null;

  constructor(options?: DesktopWindowOptions) {
    this.golden = options?.golden ?? false;
  }

  init(): void {
    if (this.browserWindow) {
      return;
    }

    this.allowedRendererUrl = null;
    this.browserWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      backgroundColor: "#0f1723",
      ...(this.golden ? { title: GOLDEN_WINDOW_TITLE } : {}),
      // macOS: drop the native title bar/title text so the renderer fills to the
      // top of the window, but keep the stoplight buttons — the renderer nests
      // them at the top of the sidebar (Sidebar reserves a draggable region and
      // Topbar pads left when the sidebar is collapsed). Other platforms keep
      // their native frame so window controls are never lost.
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hidden" as const,
            trafficLightPosition: TRAFFIC_LIGHT_POSITION,
          }
        : {}),
      webPreferences: {
        contextIsolation: true,
        sandbox: false,
        preload: this.resolvePreloadPath(),
        additionalArguments: ["--closedloop-agent-dashboard-design-system"],
      },
    });
    this.browserWindow.on("close", (event) => {
      if (this.disposing || this.quitting) {
        return;
      }
      event.preventDefault();
      this.browserWindow?.hide();
    });
    this.installNavigationGuards();
    this.installRenderProcessRecovery();
    this.installFrameDisposalRecovery();
    this.installGoldenTitle();

    // loadContent() handles its own load failures internally and always
    // resolves; the .catch here is belt-and-suspenders so this fire-and-forget
    // call can never surface an unhandled rejection.
    void this.loadContent().catch((error) => {
      gatewayLog.error(
        "renderer-load",
        `Initial renderer load failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  /**
   * Loads the renderer via the pure {@link loadRendererContent} orchestrator,
   * which prefers the loopback Vite dev server when a `--closedloop-renderer-url=`
   * arg is present (unpackaged builds only) but NEVER hard-depends on that
   * external/dev asset: a dev-server load failure (e.g. Vite not running →
   * ERR_CONNECTION_REFUSED) falls through to the self-contained bundled `app://`
   * renderer. Load failures are logged (not thrown), so this method always
   * resolves — callers invoke it fire-and-forget (`void this.loadContent()`) and
   * an unhandled rejection would crash the process.
   */
  private async loadContent(): Promise<void> {
    const devRendererUrl = resolveDevRendererUrl(process.argv, {
      isPackaged: app.isPackaged,
    });

    await loadRendererContent({
      devRendererUrl,
      bundledRendererUrl: DESIGN_RENDERER_URL,
      loadUrl: (url) => this.browserWindow!.loadURL(url),
      allowRendererUrl: (url) => this.allowRendererUrl(url),
      registerAppProtocol,
      log: gatewayLog,
    });
  }

  private installNavigationGuards(): void {
    if (!this.browserWindow) {
      return;
    }

    this.browserWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    this.browserWindow.webContents.on("will-navigate", (event, url) => {
      if (!this.isAllowedNavigation(url)) {
        event.preventDefault();
      }
    });

    // `will-navigate` only fires for the main frame; sub-frame (iframe)
    // navigations fire `will-frame-navigate`. Guard those with the same
    // exact-URL allowlist so sub-frames stay deny-by-default and don't rely
    // solely on the CSP `default-src` fallback (there is no explicit
    // `frame-src`) if the renderer is ever compromised.
    this.browserWindow.webContents.on("will-frame-navigate", (details) => {
      if (!this.isAllowedNavigation(details.url)) {
        details.preventDefault();
      }
    });
  }

  /**
   * Recovers a renderer whose process disappears unexpectedly — most commonly
   * after macOS sleep/wake reaps it, which otherwise leaves a live window
   * painting a blank frame (and makes every subsequent `webContents.send`
   * throw "Render frame was disposed"). Reloads through the validated loader so
   * the allowed-URL navigation invariant still holds, with a reload-loop
   * breaker for a renderer that fails on every load.
   */
  private installRenderProcessRecovery(): void {
    if (!this.browserWindow) {
      return;
    }

    this.browserWindow.webContents.on(
      "render-process-gone",
      (_event, details) => {
        if (this.recovering) {
          gatewayLog.warn(
            "renderer-recovery",
            `Renderer process gone (reason=${details.reason}); skipping — recovery already in flight`
          );
          return;
        }
        const decision = evaluateRenderProcessGone({
          reason: details.reason,
          disposing: this.disposing,
          quitting: this.quitting,
          now: Date.now(),
          reloadTimestamps: this.crashReloadTimestamps,
        });
        this.crashReloadTimestamps = decision.reloadTimestamps;
        if (!decision.reload) {
          gatewayLog.warn(
            "renderer-recovery",
            `Renderer process gone (reason=${details.reason}); not reloading`
          );
          return;
        }
        gatewayLog.warn(
          "renderer-recovery",
          `Renderer process gone (reason=${details.reason}); reloading (attempt ${this.crashReloadTimestamps.length})`
        );
        this.recovering = true;
        void this.loadContent()
          .catch((error) => {
            gatewayLog.error(
              "renderer-recovery",
              `Reload after render-process-gone failed: ${error instanceof Error ? error.message : String(error)}`
            );
          })
          .finally(() => {
            this.recovering = false;
          });
      }
    );
  }

  private installFrameDisposalRecovery(): void {
    if (!this.browserWindow) {
      return;
    }

    const triggerFrameCheck = (): void => {
      void this.checkFrameHealthAndRecover();
    };

    this.browserWindow.on("focus", triggerFrameCheck);
    this.browserWindow.on("show", triggerFrameCheck);

    if (!this.resumeHandler) {
      this.resumeHandler = triggerFrameCheck;
      powerMonitor?.on("resume", this.resumeHandler);
    }

    if (!this.childProcessGoneHandler) {
      this.childProcessGoneHandler = (_event, details) => {
        if (details.type === "GPU") {
          triggerFrameCheck();
        }
      };
      app.on("child-process-gone", this.childProcessGoneHandler);
    }
  }

  /**
   * FEA-2648: keep the golden-mode window title asserted. The `title`
   * BrowserWindow option is clobbered once the renderer document's
   * `<title>` loads, so re-set it on every finished load.
   */
  private installGoldenTitle(): void {
    if (!(this.golden && this.browserWindow)) {
      return;
    }

    this.browserWindow.webContents.on("did-finish-load", () => {
      this.browserWindow?.setTitle(GOLDEN_WINDOW_TITLE);
    });
  }

  private async checkFrameHealthAndRecover(): Promise<void> {
    const result = evaluateFrameRecovery({
      window: this.browserWindow,
      disposing: this.disposing,
      quitting: this.quitting,
      recovering: this.recovering,
      now: Date.now(),
      reloadTimestamps: this.crashReloadTimestamps,
    });
    this.crashReloadTimestamps = result.reloadTimestamps;

    if (!result.shouldReload) {
      if (
        this.browserWindow &&
        !this.browserWindow.isDestroyed() &&
        isFrameDisposed(this.browserWindow)
      ) {
        gatewayLog.warn(
          "renderer-recovery",
          "Render frame disposed; not reloading (breaker tripped or recovery in flight)"
        );
      }
      return;
    }

    gatewayLog.warn(
      "renderer-recovery",
      `Render frame disposed; reloading (attempt ${this.crashReloadTimestamps.length})`
    );
    this.recovering = true;
    try {
      await this.loadContent();
    } catch (error) {
      gatewayLog.error(
        "renderer-recovery",
        `Reload after frame disposal failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.recovering = false;
    }
  }

  private isAllowedNavigation(url: string): boolean {
    if (!this.allowedRendererUrl) {
      return false;
    }
    try {
      return new URL(url).href === this.allowedRendererUrl;
    } catch {
      return false;
    }
  }

  private allowRendererUrl(url: string): void {
    this.allowedRendererUrl = new URL(url).href;
  }

  private resolvePreloadPath(): string {
    // electron-vite emits the preload as a CommonJS `.cjs` (synchronous load →
    // `window.desktopApi` is exposed before the renderer's first render, no
    // async-ESM-preload race). See electron.vite.config.ts / PLN-999.
    return path.join(__dirname, "preload-design-system.cjs");
  }

  getWindow(): BrowserWindow | null {
    return this.browserWindow;
  }

  /**
   * Best-effort IPC send to this window's renderer. See
   * {@link sendToRendererWindow} for the teardown states this guards against —
   * notably the disposed render frame after sleep/wake, which a bare
   * `getWindow()?.webContents.send(...)` does not survive.
   */
  sendToRenderer(channel: string, ...args: unknown[]): boolean {
    return sendToRendererWindow(this.browserWindow, channel, ...args);
  }

  show(): void {
    // A destroyed-but-not-null BrowserWindow makes .show()/.focus() throw
    // "Object has been destroyed". Async callers (e.g. a notification click
    // that fires long after teardown) can hit exactly that state, so guard
    // here rather than relying on every call site to wrap the call.
    if (!this.browserWindow || this.browserWindow.isDestroyed()) {
      return;
    }
    this.browserWindow.show();
    this.browserWindow.focus();
  }

  /**
   * Shows the hidden BrowserWindow only after the trusted renderer has
   * nonblank shell content and has notified main. Electron's ready-to-show can
   * fire before useful content exists, which makes fast launches look white.
   */
  handleRendererReady(sender: WebContents): void {
    if (!this.isTrustedSender(sender)) {
      return;
    }

    this.showInitialWindow("renderer-ready");
  }

  /** True when an IPC event came from this app's current renderer window. */
  isTrustedSender(sender: WebContents): boolean {
    return sender === this.browserWindow?.webContents;
  }

  /** Resolves once the initial renderer window has been shown at least once. */
  whenInitiallyShown(): Promise<void> {
    if (this.initiallyShown) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.initialShowResolvers.add(resolve);
    });
  }

  setQuitting(): void {
    this.quitting = true;
  }

  dispose(): void {
    if (!this.browserWindow) {
      return;
    }

    this.disposing = true;
    if (this.resumeHandler) {
      powerMonitor?.off("resume", this.resumeHandler);
      this.resumeHandler = null;
    }
    if (this.childProcessGoneHandler) {
      app.off("child-process-gone", this.childProcessGoneHandler);
      this.childProcessGoneHandler = null;
    }
    this.recovering = false;
    this.browserWindow.close();
    this.browserWindow = null;
    this.allowedRendererUrl = null;
    this.initiallyShown = false;
    this.disposing = false;
  }

  private showInitialWindow(reason: string): void {
    if (this.initiallyShown) {
      return;
    }

    this.initiallyShown = true;
    gatewayLog.info("startup", `Desktop window visible reason=${reason}`);
    this.browserWindow?.show();
    for (const resolve of this.initialShowResolvers) {
      resolve();
    }
    this.initialShowResolvers.clear();
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}
