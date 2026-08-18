import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import electron, {
  app,
  BrowserWindow,
  nativeImage,
  protocol,
  shell,
  type WebContents,
} from "electron";
import { CONTENT_SECURITY_POLICY_HEADER } from "../shared/content-security-policy.js";
import { RendererReadyPhase } from "../shared/renderer-ready-phase.js";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
} from "../shared/window-defaults.js";
import {
  evaluateFrameRecovery,
  evaluateRenderProcessGone,
  isFrameDisposed,
  isTrustedRendererSender,
  sendToRendererWindow,
} from "./ipc/renderer-ipc.js";
import {
  InitialWindowRevealGate,
  WindowRevealReason,
  WindowShowIntent,
} from "./lifecycle/initial-window-reveal-gate.js";
import {
  isWindowRevealSuppressed,
  windowRevealSuppressedWebPreferences,
} from "./lifecycle/window-reveal-suppression.js";
import { gatewayLog } from "./logging/gateway-logger.js";
import {
  resolveDevRendererUrl,
  resolveTranscriptAllowedOrigin,
} from "./renderer-dev-url.js";
import { loadRendererContent } from "./renderer-load.js";
import { resolveResourcesDir } from "./resources-dir.js";
import { isAllowedRendererExternalUrl } from "./settings/external-url-allowlist.js";
import {
  resolveCachedTranscriptFile,
  resolveTranscriptCacheDir,
  TRANSCRIPT_APP_PATH_PREFIX,
} from "./transcript/transcript-read-cache.js";

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

// The native window background painted before the renderer document paints. It
// must match the splash palette in `renderer/design-system/index.html`, which
// carries the design-system LIGHT `--background` token value (oklch(0.989 0 0))
// because the mounted app resolves to light by default (`defaultTheme="light"`
// in `renderer/main.tsx`). The previous hardcoded dark `#0f1723` here and in the
// splash produced a dark frame in front of a light app on every default boot.
const INITIAL_WINDOW_BACKGROUND_COLOR = "#fbfbfb";

// FEA-4001: the default size for a FRESH window (no persisted bounds) lives in
// the electron-free leaf `../shared/window-defaults.js` (ISS-5068) so tests and
// E2E specs that measure the app at its launch width can import the real value
// instead of re-declaring 1380 locally. This module still owns where they are
// APPLIED, the `BrowserWindow` call below.

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

/**
 * CORS headers for an app:// response, using the single canonical loopback-origin
 * validator {@link resolveTranscriptAllowedOrigin}. Packaged builds serve the
 * renderer from app://renderer (same-origin) and get `{}` — no ACAO is emitted.
 * Only the unpackaged Vite dev renderer fetches app:// assets cross-origin, and
 * it always presents a bare loopback http origin (see {@link resolveDevRendererUrl}).
 * Reflect exactly that origin so the dev renderer can fetch assets; never a
 * wildcard, and never a non-loopback or credentialed origin.
 */
function corsHeadersForDevOrigin(request: Request): Record<string, string> {
  const allowedOrigin = resolveTranscriptAllowedOrigin(
    request.headers.get("Origin")
  );
  if (!allowedOrigin) {
    return {};
  }
  return { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" };
}

function serveAppProtocolAsset(request: Request): Response {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const corsHeaders = corsHeadersForDevOrigin(request);

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

  // Cached cloud transcripts (FEA-3324 Option B2) live under userData (outside
  // RENDERER_DIR) and stream rather than buffer, so they take a dedicated path
  // before the bundled-asset resolution below.
  if (decodedPathname.startsWith(TRANSCRIPT_APP_PATH_PREFIX)) {
    // Thread the fetch's `Origin` so the streamed response can echo an ACAO
    // header for the loopback dev origin (the `app://` scheme is corsEnabled;
    // see startup.ts). Same-origin (packaged) fetches carry no Origin header.
    return serveTranscriptAsset(decodedPathname, request.headers.get("Origin"));
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
  const headers: Record<string, string> = {
    "Content-Type": mimeType(ext),
    ...corsHeaders,
  };
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

/**
 * Serve a prepared cloud transcript (FEA-3324 Option B2) from the userData
 * cache, streamed via the `app://` scheme so the (multi-MB) bytes reach the
 * renderer over Chromium's network stack — not the IPC bridge — and under the
 * unchanged `connect-src 'self' app:`. The main process has already authorized
 * and downloaded the file (`transcript-read-ipc.ts`); this only serves bytes
 * already on disk. Path validation + the traversal/realpath guard live in
 * {@link resolveCachedTranscriptFile}.
 */
function serveTranscriptAsset(
  pathname: string,
  requestOrigin: string | null
): Response {
  // In dev the renderer fetches this from the loopback Vite origin, which is
  // cross-origin to `app://`; the `corsEnabled` scheme (startup.ts) requires the
  // response — SUCCESS AND ERROR alike — to echo that origin, otherwise the
  // renderer's `fetch()` rejects with a generic CORS TypeError instead of seeing
  // the clean status. Only a bare loopback HTTP origin is granted (never `*`,
  // never a remote origin); packaged same-origin fetches send no Origin and get
  // no ACAO, which is correct.
  const allowedOrigin = resolveTranscriptAllowedOrigin(requestOrigin);
  const corsHeaders: Record<string, string> = allowedOrigin
    ? {
        "Access-Control-Allow-Origin": allowedOrigin,
        // The origin varies per dev port, so mark the response as
        // origin-dependent for any intermediary/HTTP cache correctness.
        Vary: "Origin",
      }
    : {};

  const resolved = resolveCachedTranscriptFile(
    resolveTranscriptCacheDir(app.getPath("userData")),
    pathname
  );
  if (!resolved) {
    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
  const body = Readable.toWeb(
    createReadStream(resolved.filePath)
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Content-Length": String(resolved.size),
      // Content-addressed immutable bytes, but the URL is minted per read and the
      // cache evicts, so don't let the renderer HTTP-cache pin them.
      "Cache-Control": "no-store",
      ...corsHeaders,
    },
  });
}

export type DesktopWindowOptions = {
  /** FEA-2648: mark the window as golden launch mode. */
  golden?: boolean;
  /**
   * ISS-4898 (wongk + codex review): the web-app origin this desktop is
   * CONFIGURED against, read fresh on every open so a profile switch takes
   * effect without a relaunch. Renderer-opened links on this exact origin are
   * admitted alongside the fixed production host set — without it, every
   * session-detail linked-artifact pill on a stage/preview/localhost profile
   * rendered live and was silently denied. Omitted (or returning null) leaves
   * only the fixed allowlist, which is the correct fail-closed posture.
   */
  resolveWebAppOrigin?: () => string | null;
  /**
   * ISS-5346: bounded wait for the renderer to mount, resolving to the reason
   * the window is being revealed. Wired in production to
   * `RendererReadinessGates.waitForInitialWindowRevealReadiness()`, whose own
   * fail-open guarantees this settles.
   *
   * Omitted (bare constructions in harnesses/tests) keeps the pre-ISS-5346
   * behavior: reveal as soon as the renderer reports nonblank shell content.
   */
  waitForInitialRevealReadiness?: () => Promise<WindowRevealReason>;
  /**
   * ISS-5346: report the `Mounted` phase of `desktop:renderer-ready`. Wired in
   * production to `RendererReadinessGates.notifyRendererMounted()`, which is
   * what releases {@link waitForInitialRevealReadiness}. The two are passed
   * separately because the gates object is main-process application state that
   * `DesktopWindow` deliberately does not own.
   */
  onRendererMounted?: () => void;
};

export class DesktopWindow {
  private readonly golden: boolean;
  /**
   * ISS-5987: this launch never puts its window on screen. Resolved once, at
   * construction, from the launch arguments — see
   * {@link isWindowRevealSuppressed}.
   */
  private readonly revealSuppressed: boolean;
  private readonly resolveWebAppOrigin: () => string | null;
  private browserWindow: BrowserWindow | null = null;
  private disposing = false;
  private quitting = false;
  private allowedRendererUrl: string | null = null;
  private initiallyShown = false;
  private readonly initialShowResolvers = new Set<() => void>();
  /** ISS-5346: sequences the one-shot reveal behind the renderer mount. */
  private readonly revealGate: InitialWindowRevealGate;
  private readonly onRendererMounted?: () => void;
  private crashReloadTimestamps: number[] = [];
  private recovering = false;
  private resumeHandler: (() => void) | null = null;
  private childProcessGoneHandler:
    | ((event: Electron.Event, details: Electron.Details) => void)
    | null = null;

  constructor(options?: DesktopWindowOptions) {
    this.golden = options?.golden ?? false;
    this.revealSuppressed = isWindowRevealSuppressed(process.argv, {
      isPackaged: app.isPackaged,
    });
    this.resolveWebAppOrigin = options?.resolveWebAppOrigin ?? (() => null);
    this.onRendererMounted = options?.onRendererMounted;
    const waitForInitialRevealReadiness =
      options?.waitForInitialRevealReadiness ??
      (() => Promise.resolve(WindowRevealReason.RendererReady));
    this.revealGate = new InitialWindowRevealGate({
      waitForReadiness: waitForInitialRevealReadiness,
      reveal: (reason) => this.showInitialWindow(reason),
      onReadinessError: (message) =>
        gatewayLog.warn(
          "startup",
          `Initial window readiness wait failed, revealing anyway: ${message}`
        ),
    });
  }

  init(): void {
    if (this.browserWindow) {
      return;
    }

    this.allowedRendererUrl = null;
    this.browserWindow = new BrowserWindow({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
      show: false,
      backgroundColor: INITIAL_WINDOW_BACKGROUND_COLOR,
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
        : {
            icon: nativeImage.createFromPath(
              path.join(resolveResourcesDir(), "icon-1024.png")
            ),
          }),
      webPreferences: {
        contextIsolation: true,
        sandbox: false,
        preload: this.resolvePreloadPath(),
        additionalArguments: ["--closedloop-agent-dashboard-design-system"],
        // ISS-6112: an off-screen e2e launch keeps its renderer unthrottled and
        // reporting `visible`. Empty for every other launch, so a real user's
        // window still throttles when they background it.
        ...windowRevealSuppressedWebPreferences(this.revealSuppressed),
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

  /** The configured web-app origin, or null when it cannot be resolved. */
  private readWebAppOrigin(): string | null {
    try {
      return this.resolveWebAppOrigin();
    } catch {
      return null;
    }
  }

  private installNavigationGuards(): void {
    if (!this.browserWindow) {
      return;
    }

    this.browserWindow.webContents.setWindowOpenHandler(({ url }) => {
      // ISS-4898: the fixed production host set PLUS the exact origin this
      // desktop is configured against, resolved per open so a profile switch
      // needs no relaunch. A throwing resolver must never wedge a link, and
      // must never widen the allowlist — it degrades to the fixed set.
      if (isAllowedRendererExternalUrl(url, this.readWebAppOrigin())) {
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
   *
   * ISS-5574 (codex review on #4661): `did-finish-load` alone was not enough
   * once the renderer gained a reason to retitle itself AFTER load. Electron
   * mirrors every `document.title` write onto the native window title via
   * `page-title-updated`, so a renderer-side title (the Sessions/Branches Labs
   * toggle, or anything added later) would silently overwrite the GOLDEN marker
   * a walkthrough identifies the window by. Suppressing the default here keeps
   * the marker authoritative for the life of a golden window; non-golden windows
   * are untouched and still take their title from the page.
   */
  private installGoldenTitle(): void {
    if (!(this.golden && this.browserWindow)) {
      return;
    }

    this.browserWindow.webContents.on("did-finish-load", () => {
      this.browserWindow?.setTitle(GOLDEN_WINDOW_TITLE);
    });
    this.browserWindow.on("page-title-updated", (event) => {
      event.preventDefault();
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

  /**
   * Show and focus the window.
   *
   * ISS-5346: the INITIAL reveal belongs to the gate, and this is the path that
   * used to steal it — Electron emits `activate` on the first macOS launch,
   * which `startup.ts` routes through `handleActivate()` to here. The `intent`
   * is what separates that cold-launch event from a real user-initiated open;
   * see {@link WindowShowIntent}. It defaults to `UserRequested` because every
   * caller but `handleActivate` is an unambiguous user action, and because a
   * method named `show()` defaulting to "don't show" would be a trap.
   */
  show(intent: WindowShowIntent = WindowShowIntent.UserRequested): void {
    // A destroyed-but-not-null BrowserWindow makes .show()/.focus() throw
    // "Object has been destroyed". Async callers (e.g. a notification click
    // that fires long after teardown) can hit exactly that state, so guard
    // here rather than relying on every call site to wrap the call.
    if (!this.browserWindow || this.browserWindow.isDestroyed()) {
      return;
    }
    this.revealGate.requestShow(intent, () => {
      this.presentWindow({ focus: true });
    });
  }

  /**
   * The ONE place the OS window is actually put on screen.
   *
   * ISS-5987: a suppressed launch stops here and nowhere earlier, so everything
   * upstream — the reveal gate, its reason logging, the `whenInitiallyShown`
   * waiters, and every caller that asks for a show — behaves exactly as it does
   * in production. Only the window stays off screen. Routing both show paths
   * through this method is what keeps a later caller (a notification click, a
   * macOS `activate`) from reintroducing a window mid-run.
   */
  private presentWindow({ focus }: { focus: boolean }): void {
    if (this.revealSuppressed) {
      return;
    }
    this.browserWindow?.show();
    if (focus) {
      this.browserWindow?.focus();
    }
  }

  /**
   * Handles a renderer readiness milestone from the trusted renderer.
   *
   * ISS-5346: this no longer reveals the window itself, and the PHASE is what
   * decides. `renderer-ready-signal.ts` sends `Shell` BEFORE the React entry
   * mounts, so revealing on it exposed a shell that was mounted but not live;
   * `Shell` now only ARMS the (bounded) reveal gate. `main.tsx` sends `Mounted`
   * after React commits its first render, which is what actually releases the
   * reveal.
   *
   * Deliberately non-blocking: the `desktop:renderer-ready` IPC handler goes on
   * to send `desktop:db:ready`/`desktop:db:changed`, and awaiting anything here
   * would stall that ack behind the very renderer it is acking.
   */
  handleRendererReady(sender: WebContents, phase: RendererReadyPhase): void {
    if (!this.isTrustedSender(sender)) {
      return;
    }

    if (phase === RendererReadyPhase.Mounted) {
      this.onRendererMounted?.();
    }
    this.revealGate.requestReveal();
  }

  /**
   * True when an IPC event came from this app's current renderer window. See
   * {@link isTrustedRendererSender} for the destroyed-window state it fails
   * closed on — the bare `sender === this.browserWindow?.webContents` this
   * replaces threw out of every IPC handler gated on it during teardown.
   */
  isTrustedSender(sender: WebContents): boolean {
    return isTrustedRendererSender(this.browserWindow, sender);
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
    // ISS-5346: re-arm the one-shot reveal so a rebuilt window can be revealed
    // again, matching the `initiallyShown` reset above.
    this.revealGate.reset();
    this.disposing = false;
  }

  private showInitialWindow(reason: WindowRevealReason): void {
    if (this.initiallyShown) {
      return;
    }

    this.initiallyShown = true;
    gatewayLog.info("startup", `Desktop window visible reason=${reason}`);
    this.presentWindow({ focus: false });
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
