import type { CustomScheme } from "electron";

/** The custom scheme the packaged renderer and prepared transcripts are served over. */
export const APP_SCHEME = "app" as const;

/** The host the packaged renderer document is served under. */
export const APP_RENDERER_HOST = "renderer" as const;

/**
 * The `Origin` the packaged renderer's requests carry. The doc-sync service
 * admits exactly this string (`DESKTOP_RENDERER_ORIGIN`, PLN-2189 T-4.5).
 */
export const APP_RENDERER_ORIGIN =
  `${APP_SCHEME}://${APP_RENDERER_HOST}` as const;

/**
 * Privileged-scheme registration for `app://` (FEA-3324 / FEA-3549 / FEA-3548).
 *
 * Must be passed to `protocol.registerSchemesAsPrivileged` BEFORE app `ready`
 * (see startup.ts). Beyond the packaged renderer's `standard`/`secure` needs:
 *
 * - `supportFetchAPI` + `corsEnabled` let the renderer `fetch()` a prepared
 *   transcript over `app://`. In dev the renderer document is served from the
 *   loopback Vite origin, so that fetch is CROSS-ORIGIN to `app://`; without
 *   `corsEnabled` Chromium blocks it ("Cross origin requests are only supported
 *   for protocol schemes: …") and transcripts never load — the visible symptom
 *   of both FEA-3549 and FEA-3548 (a synced transcript still reads back as an
 *   `app://` URL). `corsEnabled` only makes the scheme ELIGIBLE for cross-origin
 *   fetch; the response's `Access-Control-Allow-Origin` is still scoped to the
 *   loopback dev origin (window.ts `serveTranscriptAsset`).
 * - `stream` lets the protocol handler return a streamed `ReadableStream` body
 *   so a multi-MB transcript is not buffered whole in main.
 *
 * Exported as data so the privilege set is unit-testable without booting
 * Electron.
 */
export const APP_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
};
