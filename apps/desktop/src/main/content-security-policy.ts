import type { Session } from "electron";
import { CONTENT_SECURITY_POLICY_HEADER } from "../shared/content-security-policy.js";

let installed = false;

/**
 * Attach a strict Content-Security-Policy header to every `app://` renderer
 * response. The packaged renderer is served from the custom `app:` protocol
 * (window.ts) and otherwise loads with no CSP, so an injected script would run
 * with full renderer privileges — a real risk given the renderer's IPC reaches
 * host operations. This is defense-in-depth with the build-injected `<meta>`
 * CSP in index.html.
 *
 * The listener is scoped to `app://` URLs and passes every other request's
 * headers through untouched, so the loopback Vite dev server
 * (`http://127.0.0.1`, which serves its own HMR-friendly document with no CSP)
 * is unaffected.
 */
export function installAppContentSecurityPolicy(session: Session): void {
  if (installed) {
    return;
  }
  installed = true;

  session.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith("app://")) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const responseHeaders = stripContentSecurityPolicy(details.responseHeaders);
    responseHeaders["Content-Security-Policy"] = [
      CONTENT_SECURITY_POLICY_HEADER,
    ];
    callback({ responseHeaders });
  });
}

/**
 * Drop any pre-existing CSP header (case-insensitively) so ours is the only
 * policy in force rather than an additional, intersected one.
 */
function stripContentSecurityPolicy(
  headers: Record<string, string[]> | undefined
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === "content-security-policy") {
      continue;
    }
    next[key] = value;
  }
  return next;
}
