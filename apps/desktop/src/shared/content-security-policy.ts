import { DESKTOP_REPLAY_API_ORIGINS } from "@repo/api/src/types/desktop-session-replay-pilot";
import { DESKTOP_DOC_SYNC_ORIGINS } from "@repo/api/src/types/doc-sync-connection";
import { LIVEBLOCKS_CONNECTION_ORIGINS } from "@repo/api/src/types/liveblocks-connection";

// Content-Security-Policy for the packaged `app://` renderer.
//
// The renderer talks to the main process exclusively over the contextIsolated
// IPC bridge (`window.desktopApi`): cloud REST marshals over IPC (PLN-1138 D-G
// Option B) and telemetry ships over IPC. Even the (multi-MB) session transcript
// bytes stay same-origin — the main process fetches them from the short-lived
// signed S3 URL and serves them to the renderer over the `app://` scheme
// (FEA-3324 Option B2), so the renderer fetches no app data of its own.
// `connect-src` admits the replay proxy, the shared document collaboration
// SDK's HTTPS/WebSocket endpoints, and the document sync service's WebSocket
// origins (PLN-2189). Cloud REST and attachment bytes stay in main.
// `img-src` admits exactly one — the Clerk avatar host, see
// ISS-10402 below — because an `<img>` load is a browser-issued subresource
// request whose bytes the renderer can never read. Scripts are locked to same-origin
// bundles — the former inline readiness `<script>` now loads as a module
// (design-system/index.html → renderer-ready-signal.ts) so no
// `'unsafe-inline'`/hash is required for `script-src`. `style-src` keeps
// `'unsafe-inline'` on purpose: the design system and react-grid-layout set
// element `style` attributes at runtime, which a nonce/hash cannot cover, and
// this also permits the inline `<style>` shell in index.html. Bundled
// fonts/logos and Vite-inlined `data:` assets are covered by `'self' app:`/`data:`.
/**
 * Every REMOTE origin `img-src` admits, as data rather than as prose inside the
 * directive string. The directive below is built from it, so the policy and the
 * predicate {@link isRendererDisplayableImageUrl} can never disagree about which
 * hosts an `<img>` may point at.
 */
export const RENDERER_REMOTE_IMAGE_ORIGINS = ["https://img.clerk.com"] as const;

const BASE_CSP_DIRECTIVES = [
  "default-src 'self' app:",
  "script-src 'self' app:",
  "style-src 'self' app: 'unsafe-inline'",
  // ISS-10402: `https://img.clerk.com` is the one remote origin `img-src`
  // admits, a deliberate exception to the same-origin invariant described
  // above. Clerk serves every user avatar from that host, so without it `img-src`
  // blocked all of them -- measured at 120 blocked loads in a single session,
  // which also buried real errors in the console. It is scoped to that exact
  // host, on `img-src` only, and an image response cannot be read cross-origin
  // by the renderer.
  //
  // The alternative that would preserve the invariant exactly is proxying avatar
  // bytes through the main process over `app://`, the way transcript bytes are
  // (FEA-3324 Option B2). That is the stricter design and remains open; it costs
  // a main-process fetch + cache per avatar, which was not worth blocking the
  // fix for every avatar in the app being broken today.
  `img-src 'self' app: data: ${RENDERER_REMOTE_IMAGE_ORIGINS.join(" ")}`,
  "font-src 'self' app: data:",
  `connect-src 'self' app: ${[...DESKTOP_REPLAY_API_ORIGINS, ...LIVEBLOCKS_CONNECTION_ORIGINS, ...DESKTOP_DOC_SYNC_ORIGINS].join(" ")}`,
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

/**
 * Whether the packaged renderer can actually DISPLAY an image at this URL under
 * the policy above.
 *
 * ISS-11465: the server-supplied organization logo and user avatar are the only
 * `<img>` sources in this app that come from OUTSIDE the bundle, and neither is
 * constrained to Clerk. `User.avatarUrl` is whatever `PUT /users/:id` accepted,
 * so a member who set a custom avatar URL hands the renderer a source `img-src`
 * refuses — and a refused source paints nothing while the `<img>` element is
 * still mounted, i.e. a silently blank avatar with no initial-letter fallback
 * behind it. Screening here turns that into "no image", which is the case the
 * fallback exists for.
 *
 * A relative or otherwise unparseable value is NOT displayable: the renderer
 * builds none of these URLs itself, so anything that is not an absolute URL on
 * an admitted scheme or origin is malformed input, not a same-origin asset.
 */
export function isRendererDisplayableImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "data:" || parsed.protocol === "app:") {
    return true;
  }
  return RENDERER_REMOTE_IMAGE_ORIGINS.some(
    (origin) => parsed.origin === origin
  );
}
