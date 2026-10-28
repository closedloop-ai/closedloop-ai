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
import {
  app,
  type BrowserWindow,
  protocol,
  screen,
  type WebContents,
} from "electron";
import { CONTENT_SECURITY_POLICY_HEADER } from "../shared/content-security-policy.js";
import { DesktopRendererEventChannel } from "../shared/desktop-renderer-event-channel.js";
import { RendererReadyPhase } from "../shared/renderer-ready-phase.js";
import {
  APP_RENDERER_HOST,
  APP_RENDERER_ORIGIN,
  APP_SCHEME,
} from "./app-scheme.js";
import { activateAfterSignIn } from "./auth/activate-after-sign-in.js";
import { resolveDevRendererUrlWithBridgeToken } from "./browser-bridge-host-token.js";
import {
  corsHeadersForDevOrigin,
  DOCUMENT_ASSET_PATH_PREFIX,
  serveDocumentAsset,
} from "./ipc/document-asset-proxy.js";
import {
  evaluateFrameRecovery,
  evaluateRenderProcessGone,
  isFrameDisposed,
  isRendererWindowGone,
  isTrustedRendererSender,
  sendToRendererWindow,
} from "./ipc/renderer-ipc.js";
import {
  createDesktopBrowserWindow,
  GOLDEN_WINDOW_TITLE,
} from "./lifecycle/create-desktop-browser-window.js";
import {
  InitialWindowRevealGate,
  WindowRevealReason,
  WindowShowIntent,
} from "./lifecycle/initial-window-reveal-gate.js";
import {
  attemptRendererDelivery,
  completeRendererNavigationReady,
  prepareRendererRouteOpen,
  type RendererDelivery,
  RendererEventDelivery,
} from "./lifecycle/renderer-event-delivery.js";
import { installRendererNavigationGuards } from "./lifecycle/renderer-navigation-guards.js";
import { RendererRecoveryListeners } from "./lifecycle/renderer-recovery-listeners.js";
import {
  applyWindowPresentation,
  clampWindowBounds,
  type RendererWindowSessionState,
  rendererHashFromUrl,
  rendererUrlWithHash,
  tryCaptureRendererWindowSessionState,
  tryDestroyRendererWindow,
} from "./lifecycle/renderer-window-session-state.js";
import { isWindowRevealSuppressed } from "./lifecycle/window-reveal-suppression.js";
import { gatewayLog } from "./logging/gateway-logger.js";
import { resolveTranscriptAllowedOrigin } from "./renderer-dev-url.js";
import { loadRendererContent } from "./renderer-load.js";
import {
  createRendererHealthReporter,
  type RendererHealthReporter,
} from "./telemetry/renderer-health-telemetry.js";
import {
  resolveCachedTranscriptFile,
  resolveTranscriptCacheDir,
  TRANSCRIPT_APP_PATH_PREFIX,
} from "./transcript/transcript-read-cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RENDERER_DIR = path.resolve(__dirname, "..", "renderer");
const DESIGN_RENDERER_DIR = path.join(RENDERER_DIR, "design-system");
const ASSETS_RENDERER_DIR = path.join(RENDERER_DIR, "assets");
const DESIGN_RENDERER_URL = `${APP_RENDERER_ORIGIN}/design-system/index.html`;
const APP_PROTOCOL = APP_SCHEME;

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

function serveAppProtocolAsset(request: Request): Response | Promise<Response> {
  const corsHeaders = corsHeadersForDevOrigin(request);

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (
    url.protocol !== `${APP_PROTOCOL}:` ||
    url.hostname !== APP_RENDERER_HOST
  ) {
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

  if (
    request.method !== "GET" &&
    !decodedPathname.startsWith(DOCUMENT_ASSET_PATH_PREFIX)
  ) {
    return new Response("Method not allowed", { status: 405 });
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

  if (decodedPathname.startsWith(DOCUMENT_ASSET_PATH_PREFIX)) {
    return serveDocumentAsset(request, corsHeaders);
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
 * renderer over Chromium's network stack — not the IPC bridge — with no
 * transcript origin in `connect-src`. The main process has already authorized
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
   * ISS-4898 (whitlockk + codex review): the web-app origin this desktop is
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
  /** Re-arm application-owned readiness when a renderer generation is released. */
  onRendererReleased?: () => void;
  /** Publish authoritative state after the replacement renderer can receive it. */
  onRendererNavigationReady?: () => void;
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
  private readonly onRendererReleased?: () => void;
  private readonly onRendererNavigationReady?: () => void;
  private readonly rendererEvents = new RendererEventDelivery();
  private rendererGeneration = 0;
  private rendererWindowState: RendererWindowSessionState | null = null;
  private pendingNativePresentation: RendererWindowSessionState | null = null;
  private nextRendererHash: string | null = null;
  private suspending = false;
  private crashReloadTimestamps: number[] = [];
  /** ISS-6331: reports renderer hangs, load failures, and breaker exhaustion. */
  private readonly rendererHealth: RendererHealthReporter;
  private readonly recoveryListeners = new RendererRecoveryListeners();
  private recovering = false;

  constructor(options?: DesktopWindowOptions) {
    this.golden = options?.golden ?? false;
    this.revealSuppressed = isWindowRevealSuppressed(process.argv, {
      isPackaged: app.isPackaged,
    });
    this.resolveWebAppOrigin = options?.resolveWebAppOrigin ?? (() => null);
    this.onRendererMounted = options?.onRendererMounted;
    this.onRendererReleased = options?.onRendererReleased;
    this.onRendererNavigationReady = options?.onRendererNavigationReady;
    this.rendererHealth = createRendererHealthReporter({
      getReloadsInWindow: () => this.crashReloadTimestamps.length,
      isTearingDown: () => this.disposing || this.quitting || this.suspending,
      // The dev renderer is tried first and its failure is recovered from by
      // `loadRendererContent`'s bundled fallback, so it must not be reported.
      getRecoveredLoadUrl: () =>
        resolveDevRendererUrlWithBridgeToken(process.argv, {
          isPackaged: app.isPackaged,
        }),
    });
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
    this.ensureWindow();
  }

  private ensureWindow(): BrowserWindow | null {
    if (this.disposing || this.quitting) {
      return null;
    }
    if (this.browserWindow && !this.browserWindow.isDestroyed()) {
      return this.browserWindow;
    }

    const generation = this.rendererGeneration + 1;
    this.rendererGeneration = generation;
    this.rendererEvents.startGeneration();
    const restoredState = this.rendererWindowState;
    const restoredBounds = restoredState
      ? clampWindowBounds(
          restoredState.bounds,
          screen.getDisplayMatching(restoredState.bounds).workArea
        )
      : null;
    const initialHash = this.nextRendererHash ?? restoredState?.hash ?? "";
    this.pendingNativePresentation = restoredState;
    this.rendererWindowState = null;
    this.nextRendererHash = null;
    this.allowedRendererUrl = null;
    const browserWindow = createDesktopBrowserWindow({
      bounds: restoredBounds,
      golden: this.golden,
      preloadPath: path.join(__dirname, "preload-design-system.cjs"),
      revealSuppressed: this.revealSuppressed,
    });
    this.browserWindow = browserWindow;
    browserWindow.on("close", (event) => {
      if (!this.isCurrentWindow(browserWindow, generation)) {
        return;
      }
      if (this.disposing || this.quitting) {
        return;
      }
      event.preventDefault();
      this.suspendRenderer(browserWindow, generation);
    });
    installRendererNavigationGuards({
      browserWindow,
      isAllowedNavigation: (url) => this.isAllowedNavigation(url),
      isCurrentWindow: () => this.isCurrentWindow(browserWindow, generation),
      resolveWebAppOrigin: this.resolveWebAppOrigin,
    });
    this.installRenderProcessRecovery(browserWindow, generation);
    this.installFrameDisposalRecovery(browserWindow, generation);
    this.rendererHealth.installListeners(browserWindow.webContents);
    this.installGoldenTitle(browserWindow, generation);

    void this.loadContent(browserWindow, generation, initialHash).catch(
      (error) => {
        if (!this.isCurrentWindow(browserWindow, generation)) {
          return;
        }
        gatewayLog.error(
          "renderer-load",
          `Initial renderer load failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    );
    return browserWindow;
  }

  private isCurrentWindow(
    browserWindow: BrowserWindow,
    generation: number
  ): boolean {
    return (
      this.rendererGeneration === generation &&
      this.browserWindow === browserWindow &&
      !browserWindow.isDestroyed()
    );
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
  private async loadContent(
    browserWindow: BrowserWindow,
    generation: number,
    hash = ""
  ): Promise<void> {
    const devRendererUrl = resolveDevRendererUrlWithBridgeToken(process.argv, {
      isPackaged: app.isPackaged,
    });

    await loadRendererContent({
      devRendererUrl: devRendererUrl
        ? rendererUrlWithHash(devRendererUrl, hash)
        : null,
      bundledRendererUrl: rendererUrlWithHash(DESIGN_RENDERER_URL, hash),
      loadUrl: (url) => {
        if (!this.isCurrentWindow(browserWindow, generation)) {
          return Promise.resolve();
        }
        return browserWindow.loadURL(url);
      },
      allowRendererUrl: (url) => {
        if (this.isCurrentWindow(browserWindow, generation)) {
          this.allowRendererUrl(url);
        }
      },
      registerAppProtocol,
      log: gatewayLog,
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
  private installRenderProcessRecovery(
    browserWindow: BrowserWindow,
    generation: number
  ): void {
    browserWindow.webContents.on("render-process-gone", (_event, details) => {
      if (!this.isCurrentWindow(browserWindow, generation)) {
        return;
      }
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
        // ISS-6331: a local warn is where this used to stop, leaving a live
        // window painting a blank frame while heartbeats reported healthy.
        if (decision.budgetExhausted) {
          this.rendererHealth.reportReloadBudgetExhausted(
            decision.reloadTimestamps.length
          );
        }
        return;
      }
      gatewayLog.warn(
        "renderer-recovery",
        `Renderer process gone (reason=${details.reason}); reloading (attempt ${this.crashReloadTimestamps.length})`
      );
      this.recovering = true;
      this.rendererEvents.startGeneration();
      void this.loadContent(
        browserWindow,
        generation,
        rendererHashFromUrl(browserWindow.webContents.getURL())
      )
        .catch((error) => {
          gatewayLog.error(
            "renderer-recovery",
            `Reload after render-process-gone failed: ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          if (this.isCurrentWindow(browserWindow, generation)) {
            this.recovering = false;
          }
        });
    });
  }

  private installFrameDisposalRecovery(
    browserWindow: BrowserWindow,
    generation: number
  ): void {
    const triggerFrameCheck = (): void => {
      void this.checkFrameHealthAndRecover(browserWindow, generation);
    };

    browserWindow.on("focus", triggerFrameCheck);
    browserWindow.on("show", triggerFrameCheck);

    this.recoveryListeners.install(triggerFrameCheck);
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
  private installGoldenTitle(
    browserWindow: BrowserWindow,
    generation: number
  ): void {
    if (!this.golden) {
      return;
    }

    browserWindow.webContents.on("did-finish-load", () => {
      if (this.isCurrentWindow(browserWindow, generation)) {
        browserWindow.setTitle(GOLDEN_WINDOW_TITLE);
      }
    });
    browserWindow.on("page-title-updated", (event) => {
      event.preventDefault();
      if (this.isCurrentWindow(browserWindow, generation)) {
        browserWindow.setTitle(GOLDEN_WINDOW_TITLE);
      }
    });
  }

  private async checkFrameHealthAndRecover(
    browserWindow: BrowserWindow,
    generation: number
  ): Promise<void> {
    if (!this.isCurrentWindow(browserWindow, generation)) {
      return;
    }
    const result = evaluateFrameRecovery({
      window: browserWindow,
      disposing: this.disposing,
      quitting: this.quitting,
      recovering: this.recovering,
      now: Date.now(),
      reloadTimestamps: this.crashReloadTimestamps,
    });
    this.crashReloadTimestamps = result.reloadTimestamps;

    if (!result.shouldReload) {
      if (!browserWindow.isDestroyed() && isFrameDisposed(browserWindow)) {
        gatewayLog.warn(
          "renderer-recovery",
          "Render frame disposed; not reloading (breaker tripped or recovery in flight)"
        );
      }
      // The same shared breaker, so the same ISS-6331 blind spot: a tripped
      // budget here also leaves a blank window nothing will retry.
      if (result.budgetExhausted) {
        this.rendererHealth.reportReloadBudgetExhausted(
          result.reloadTimestamps.length
        );
      }
      return;
    }

    gatewayLog.warn(
      "renderer-recovery",
      `Render frame disposed; reloading (attempt ${this.crashReloadTimestamps.length})`
    );
    this.recovering = true;
    this.rendererEvents.startGeneration();
    try {
      await this.loadContent(
        browserWindow,
        generation,
        rendererHashFromUrl(browserWindow.webContents.getURL())
      );
    } catch (error) {
      gatewayLog.error(
        "renderer-recovery",
        `Reload after frame disposal failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (this.isCurrentWindow(browserWindow, generation)) {
        this.recovering = false;
      }
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
    const delivery = this.rendererEvents.record(channel, args);
    if (!delivery) {
      return false;
    }
    return this.deliverRendererEvent(delivery);
  }

  /** Drop a retained snapshot after its owner confirms the value is stale. */
  clearRendererSnapshot(channel: string): void {
    this.rendererEvents.clearSnapshot(channel);
  }

  /** Show and focus through the per-generation initial reveal gate. */
  show(intent: WindowShowIntent = WindowShowIntent.UserRequested): void {
    if (!this.ensureWindow()) {
      return;
    }
    this.revealGate.requestShow(intent, () => {
      this.presentWindow({ focus: true });
    });
  }

  /** Recreate, present, and deliver one last-wins renderer route intent. */
  showRoute(
    route: string,
    intent: WindowShowIntent = WindowShowIntent.UserRequested
  ): void {
    const { initialHash, queuedRoute } = prepareRendererRouteOpen(
      this.rendererEvents,
      Boolean(this.browserWindow && !this.browserWindow.isDestroyed()),
      route
    );
    this.nextRendererHash = initialHash ?? this.nextRendererHash;
    if (queuedRoute) {
      this.sendToRenderer(DesktopRendererEventChannel.NavigateTab, queuedRoute);
    }
    this.show(intent);
  }

  /** Return from browser authorization without requiring a deep-link click. */
  returnFromBrowserSignIn(): void {
    this.show();
    if (this.revealSuppressed) {
      return;
    }
    activateAfterSignIn({
      window: this.browserWindow,
      // Activate the application explicitly as well as showing its window.
      activateApp: () => app.focus({ steal: true }),
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
    const browserWindow = this.browserWindow;
    if (!browserWindow || browserWindow.isDestroyed()) {
      return;
    }
    const nativePresentation = this.pendingNativePresentation;
    this.pendingNativePresentation = null;
    applyWindowPresentation(browserWindow, nativePresentation);
    browserWindow.show();
    if (focus) {
      browserWindow.focus();
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
    if (phase === RendererReadyPhase.NavigationReady) {
      completeRendererNavigationReady(
        this.rendererEvents,
        (delivery) => {
          this.deliverRendererEvent(delivery);
        },
        () => this.onRendererNavigationReady?.()
      );
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

  /**
   * ISS-8776 — is there no live renderer window to verify a sender against?
   *
   * Reported alongside a refusal, never instead of one: an IPC handler consults
   * this only after {@link isTrustedSender} has already said no, to say whether
   * the refusal was a teardown or a foreign sender. See
   * `ipc-trusted-sender.ts`.
   */
  isRendererWindowGone(): boolean {
    return isRendererWindowGone(this.browserWindow);
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
    this.disposing = true;
    this.recoveryListeners.dispose();
    this.recovering = false;
    // ISS-6331: the crash breaker's rolling window is per-window state. Left
    // behind, a rebuilt window inherits a full budget and reports itself
    // exhausted on its first crash; the suppression map would likewise swallow a
    // new window's first signal.
    this.crashReloadTimestamps = [];
    this.rendererHealth.dispose();
    this.rendererEvents.dispose();
    this.browserWindow?.destroy();
    this.browserWindow = null;
    this.allowedRendererUrl = null;
    this.initiallyShown = false;
    // ISS-5346: re-arm the one-shot reveal so a rebuilt window can be revealed
    // again, matching the `initiallyShown` reset above.
    this.revealGate.reset();
    this.disposing = false;
  }

  private suspendRenderer(
    browserWindow: BrowserWindow,
    generation: number
  ): void {
    if (!this.isCurrentWindow(browserWindow, generation)) {
      return;
    }
    const allowedRendererUrl = this.allowedRendererUrl;
    this.suspending = true;
    try {
      const capture = tryCaptureRendererWindowSessionState(browserWindow);
      if (capture.state) {
        this.rendererWindowState = capture.state;
      } else {
        gatewayLog.warn(
          "renderer-suspension",
          `Unable to capture renderer window state: ${capture.error instanceof Error ? capture.error.message : String(capture.error)}`
        );
      }
      this.browserWindow = null;
      this.allowedRendererUrl = null;
      const destroyError = tryDestroyRendererWindow(browserWindow);
      if (destroyError) {
        gatewayLog.error(
          "renderer-suspension",
          `Unable to destroy renderer window: ${destroyError instanceof Error ? destroyError.message : String(destroyError)}`
        );
        this.browserWindow = browserWindow;
        this.allowedRendererUrl = allowedRendererUrl;
        return;
      }
      this.initiallyShown = false;
      this.recovering = false;
      this.crashReloadTimestamps = [];
      this.rendererEvents.startGeneration();
      this.revealGate.reset();
      this.recoveryListeners.dispose();
      this.rendererHealth.dispose();
      this.onRendererReleased?.();
    } finally {
      this.suspending = false;
    }
  }

  private deliverRendererEvent(delivery: RendererDelivery): boolean {
    return attemptRendererDelivery(this.rendererEvents, delivery, (pending) =>
      sendToRendererWindow(this.browserWindow, pending.channel, ...pending.args)
    );
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
