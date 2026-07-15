import { z } from "zod";

/**
 * Shared contract for `POST /desktop/authorize` — the desktop loopback OAuth
 * mint (FEA-2409 / FEA-2460). Used by BOTH the API route/service and the web
 * authorize page's mint hook, so it is canonicalized here rather than declared
 * separately in each app (per the "never define the same type twice" rule).
 *
 * The web page sends only the desktop-supplied binding material; the route
 * binds the minted code to the Clerk-resolved internal user/org — never to
 * anything the client supplies. `webAppOrigin` is the page's own origin, echoed
 * so the route can match it against the browser-sent `Origin` header as CSRF
 * defense-in-depth.
 */
export type DesktopAuthorizeMintRequest = {
  webAppOrigin: string;
  gatewayId: string;
  gatewayPublicKeyPem: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
};

/**
 * Body returned by `POST /desktop/authorize` (raw, un-enveloped). This schema is
 * the single source of truth for the response shape: the API service builds its
 * result to satisfy it, and the web mint hook parses the raw response through it
 * so a malformed 2xx surfaces as an error instead of handing the desktop a
 * missing/undefined `code`. Unknown keys are ignored (forward-compatible).
 */
export const desktopAuthorizeMintResultSchema = z.object({
  code: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type DesktopAuthorizeMintResult = z.infer<
  typeof desktopAuthorizeMintResultSchema
>;
