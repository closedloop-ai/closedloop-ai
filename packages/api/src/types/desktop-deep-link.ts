/**
 * The OS-level custom URI scheme the Desktop app registers as a protocol client
 * (ISS-6109). The web "Launch Desktop App" control navigates to it; the OS hands
 * it to `apps/desktop/src/main/lifecycle/deep-link.ts`.
 *
 * This is a cross-process, version-skewed wire contract: the browser cannot see
 * which Desktop build (if any) will receive the URL, and an already-installed
 * build predating ISS-6109 registers nothing at all. Changing the scheme orphans
 * every installed client, so both sides import this constant rather than
 * spelling the literal.
 */
export const DESKTOP_DEEP_LINK_SCHEME = "closedloop" as const;

/**
 * The only Desktop deep link that exists: a bare, payload-free "launch or focus
 * the app" signal.
 *
 * Deliberately carries no session id, target id, or path. A registered protocol
 * handler is a remotely reachable entry point into a local process — any web
 * page anywhere can navigate a user to it — so the payload-free form is the one
 * with no attack surface to validate. A payload-carrying deep link is a separate
 * increment that owes its own allowlist (ISS-6109).
 */
export const DESKTOP_DEEP_LINK_URL = `${DESKTOP_DEEP_LINK_SCHEME}://` as const;
