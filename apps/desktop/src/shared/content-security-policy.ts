// Content-Security-Policy for the packaged `app://` renderer.
//
// The renderer talks to the main process exclusively over the contextIsolated
// IPC bridge (`window.desktopApi`): the REST transport is inert
// (desktop-app-core-provider.tsx) and telemetry is shipped over IPC, so the
// renderer makes no outbound network requests and `connect-src` needs no remote
// origins. Scripts are locked to same-origin bundles — the former inline
// readiness `<script>` now loads as a module (design-system/index.html →
// renderer-ready-signal.ts) so no `'unsafe-inline'`/hash is required for
// `script-src`. `style-src` keeps `'unsafe-inline'` on purpose: the design
// system and react-grid-layout set element `style` attributes at runtime, which
// a nonce/hash cannot cover, and this also permits the inline `<style>` shell in
// index.html. Bundled fonts/logos and Vite-inlined `data:` assets are covered by
// `'self' app:`/`data:`.
const BASE_CSP_DIRECTIVES = [
  "default-src 'self' app:",
  "script-src 'self' app:",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src 'self' app: data:",
  "font-src 'self' app: data:",
  "connect-src 'self' app:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
] as const;

/**
 * Policy for the `<meta http-equiv>` tag injected into the built index.html
 * (vite.renderer.config.ts). `frame-ancestors` is intentionally omitted: it is
 * only honored as an HTTP header, so emitting it in a `<meta>` tag just logs a
 * console warning.
 */
export const CONTENT_SECURITY_POLICY_META = BASE_CSP_DIRECTIVES.join("; ");

/**
 * Policy for the `Content-Security-Policy` response header attached to every
 * `app://` response (main/content-security-policy.ts). Adds `frame-ancestors`
 * to block the renderer from being embedded as a frame.
 */
export const CONTENT_SECURITY_POLICY_HEADER = [
  ...BASE_CSP_DIRECTIVES,
  "frame-ancestors 'none'",
].join("; ");
