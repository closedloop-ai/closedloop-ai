import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  protocol,
  shell,
  type WebContents,
} from "electron";
import { gatewayLog } from "./gateway-logger.js";
import { resolveDevRendererUrl } from "./renderer-dev-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RENDERER_DIR = path.resolve(__dirname, "..", "renderer");
const DESIGN_RENDERER_DIR = path.join(RENDERER_DIR, "design-system");
const ASSETS_RENDERER_DIR = path.join(RENDERER_DIR, "assets");
const DESIGN_RENDERER_URL = "app://renderer/design-system/index.html";
const APP_PROTOCOL = "app";
const EXTERNAL_LINK_HOSTS = new Set([
  "app.closedloop.ai",
  "closedloop.ai",
  "docs.closedloop.ai",
  "github.com",
]);

// macOS stoplight position for the hidden title bar. y is tuned to the inset
// shell (renderer globals.css) so the buttons line up with the Topbar; bump it
// together with the inset/Topbar height if either changes.
const TRAFFIC_LIGHT_POSITION = { x: 19, y: 17 };

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
  return new Response(data, {
    status: 200,
    headers: { "Content-Type": mimeType(ext) },
  });
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

export class DesktopWindow {
  private browserWindow: BrowserWindow | null = null;
  private disposing = false;
  private quitting = false;
  private allowedRendererUrl: string | null = null;
  private initiallyShown = false;
  private readonly initialShowResolvers = new Set<() => void>();

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

    void this.loadContent();
  }

  private async loadContent(): Promise<void> {
    const devRendererUrl = resolveDevRendererUrl(process.argv, {
      isPackaged: app.isPackaged,
    });
    if (devRendererUrl) {
      this.allowRendererUrl(devRendererUrl);
      await this.browserWindow!.loadURL(devRendererUrl);
      return;
    }

    registerAppProtocol();
    this.allowRendererUrl(DESIGN_RENDERER_URL);
    await this.browserWindow!.loadURL(DESIGN_RENDERER_URL);
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

  show(): void {
    this.browserWindow?.show();
    this.browserWindow?.focus();
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

function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      EXTERNAL_LINK_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}
