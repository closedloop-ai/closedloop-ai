import { fromBase64Url, toBase64Url } from "./base64url";

/**
 * Wire contract for the desktop loopback OAuth **authorize URL** (FEA-2525 /
 * PLN-843 Amendment 1). The desktop main process builds this URL and the web
 * authorize page parses it — two processes in two separate builds — so the
 * query-param key names are a cross-process contract that would otherwise drift
 * silently (a rename on one side compiles but breaks installed desktop builds).
 *
 * Canonicalized here (per the "never define the same contract twice" rule) so
 * `apps/desktop`'s `buildDesktopAuthorizeUrl` and `packages/app`'s
 * `parseDesktopAuthorizeParams` import the SAME keys instead of each hardcoding
 * the literals. Dependency-free (only global `btoa`/`atob`) so bundling this
 * into the Electron main process pulls in nothing else.
 */
export const DESKTOP_AUTHORIZE_QUERY_PARAMS = {
  codeChallenge: "code_challenge",
  codeChallengeMethod: "code_challenge_method",
  state: "state",
  redirectUri: "redirect_uri",
  gatewayId: "gateway_id",
  gatewayPublicKey: "gateway_public_key",
  deviceName: "device_name",
  platform: "platform",
  /**
   * ISS-5112 / ISS-5954: which sign-in METHOD the person picked in the DESKTOP
   * UI, so the signed-out detour lands them on that method's flow — a social
   * provider's consent screen, or the email form — instead of a second chooser
   * they already answered once. The key is still spelled `provider` on the
   * wire: renaming it would orphan every installed desktop build.
   *
   * OPTIONAL in both directions, deliberately. An older desktop build omits it
   * and the page behaves exactly as before; an older web build receives a value
   * it does not know (`email`, from a newer desktop) and resolves it to GitHub
   * — today's behavior, no crash. Neither side may treat its absence as an
   * error, and the value is a HINT only — it selects a sign-in flow and carries
   * no authority, so it is never an input to the PKCE/PoP checks that actually
   * gate the mint.
   */
  provider: "provider",
  /**
   * ISS-5954 M5: the address typed into the desktop email form, so the Clerk
   * sign-up form opens prefilled instead of asking again. base64url-encoded —
   * the authorize-URL contract already documents `+` decaying through Clerk's
   * re-decode-and-re-navigate path, and plus-addressing is common; a silently
   * corrupted prefill is worse than none. A HINT with no authority: it reaches
   * nothing but the form's field value, and Clerk still verifies the address.
   * Additive and optional in both directions, same posture as `provider`.
   */
  emailHint: "email_hint",
  /**
   * ISS-5954: which way the desktop door that started this flow was framed —
   * `sign-up` (the converting onboarding doors) or `sign-in` (the
   * returning-user doors). Consumed only by the email landing branch, which
   * renders the matching Clerk embed instead of answering "Already have an
   * account? Sign in" with an account-creation form. A HINT with no
   * authority, additive and optional in both directions, same posture as
   * `provider`: absent or unrecognized means the sign-up embed — the
   * pre-existing behavior.
   */
  framing: "framing",
  /**
   * Additive capability marker: only Desktop builds that understand the
   * organization-less bootstrap callback advertise it. The web signup gate
   * must not return a bootstrap code to an older install that would attempt to
   * redeem it as an ordinary authorization code.
   */
  bootstrapSupported: "bootstrap_supported",
} as const;

export const DESKTOP_BOOTSTRAP_SUPPORTED_TRUE = "1";

/** Additive loopback marker selecting the organization-less bootstrap redeem. */
export const DESKTOP_BOOTSTRAP_QUERY_PARAM = "desktop_bootstrap";
export const DESKTOP_BOOTSTRAP_TRUE = "1";

export function isDesktopBootstrapValue(value: string | null): boolean {
  return value === DESKTOP_BOOTSTRAP_TRUE;
}

/**
 * Every sign-in method the desktop UI can pre-select: the wire vocabulary of
 * the `provider` hint (ISS-5954 M2). `email` is NOT an OAuth provider — it
 * must never reach `authenticateWithRedirect` — which is why the OAuth subset
 * below ({@link DesktopSignInProvider}) stays its own narrower type.
 *
 * No Zod here on purpose — this module is dependency-free so bundling it into
 * the Electron main process pulls in nothing else (see the file header). The
 * validating boundary is the IPC handler, which does use Zod.
 */
export const DesktopSignInMethod = {
  GitHub: "github",
  Google: "google",
  Email: "email",
} as const;
export type DesktopSignInMethod =
  (typeof DesktopSignInMethod)[keyof typeof DesktopSignInMethod];

const DESKTOP_AUTH_METHODS: readonly string[] =
  Object.values(DesktopSignInMethod);

/** Narrow an untrusted query-string value to a known method; null otherwise. */
export function parseDesktopSignInMethod(
  value: string | null | undefined
): DesktopSignInMethod | null {
  return value && DESKTOP_AUTH_METHODS.includes(value)
    ? (value as DesktopSignInMethod)
    : null;
}

/**
 * The OAuth subset of {@link DesktopSignInMethod}: methods with a social
 * consent screen and a Clerk `oauth_*` strategy. Kept separate so exhaustive
 * strategy maps (`satisfies Record<DesktopSignInProvider, string>`) stay
 * exhaustive over strategies that actually exist — routing `email` into one
 * fails `tsc`, not production. An earlier docblock here claimed email was
 * excluded because "it is a magic-link flow"; it is not — desktop email lands
 * on the Clerk form (ISS-5954 M3). Email is excluded because it has no OAuth
 * strategy.
 */
export const DesktopSignInProvider = {
  GitHub: "github",
  Google: "google",
} as const;
export type DesktopSignInProvider =
  (typeof DesktopSignInProvider)[keyof typeof DesktopSignInProvider];

/**
 * The OAuth provider behind a method, or null for the email method — the one
 * branch point where the landing page decides "consent screen" vs "form".
 * Exhaustive via `satisfies`: a new method fails `tsc` here until it is
 * intentionally mapped.
 */
const PROVIDER_FOR_SIGN_IN_METHOD = {
  [DesktopSignInMethod.GitHub]: DesktopSignInProvider.GitHub,
  [DesktopSignInMethod.Google]: DesktopSignInProvider.Google,
  [DesktopSignInMethod.Email]: null,
} as const satisfies Record<DesktopSignInMethod, DesktopSignInProvider | null>;

export function providerForSignInMethod(
  method: DesktopSignInMethod
): DesktopSignInProvider | null {
  return PROVIDER_FOR_SIGN_IN_METHOD[method];
}

/**
 * The `gateway_public_key` value is a multi-line SPKI PEM: it carries spaces
 * (in the `-----BEGIN PUBLIC KEY-----` header/footer) and newlines between
 * lines. As a raw query-param value that survives a *direct* browser
 * navigation (the app form-decodes `+`→space and `%0A`→newline server-side),
 * but NOT the signed-out sign-in detour: Clerk re-decodes and re-navigates to
 * the URL client-side, where the browser strips literal newlines and `+` can
 * decay to a literal plus. Either mutation corrupts the PEM, and the authorize
 * mint then rejects the key with a 400. base64url carries none of those fragile
 * characters, so the key round-trips through any redirect/decode path.
 *
 * `btoa`/`atob` are globals in both the Electron main process (Node) and the
 * browser; the PEM is ASCII, so the Latin1 round-trip is exact. The mechanics
 * live in the dependency-free {@link toBase64Url}/{@link fromBase64Url} codec so
 * the same base64url logic is not re-implemented per surface; these wrappers add
 * only the gateway-key semantics (an empty decode is treated as malformed).
 */

export function encodeDesktopGatewayPublicKey(pem: string): string {
  return toBase64Url(pem);
}

/** Inverse of {@link encodeDesktopGatewayPublicKey}; null on a malformed value. */
export function decodeDesktopGatewayPublicKey(value: string): string | null {
  const decoded = fromBase64Url(value);
  return decoded && decoded.length > 0 ? decoded : null;
}

/**
 * RFC 5321's practical address ceiling; anything longer is not a mailbox this
 * hint should carry across a URL. Exported so the IPC boundary bounds the
 * argument with this same ceiling instead of a second hand-picked number.
 */
export const DESKTOP_EMAIL_HINT_MAX_LENGTH = 254;

/**
 * Minimal plausibility, not RFC validation: something@something, no
 * whitespace/control characters. The hint prefills a form field Clerk then
 * verifies for real, so the narrowing exists to keep garbage and smuggled
 * content out of the URL and the field — not to adjudicate address validity.
 */
const PLAUSIBLE_EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/**
 * Printable ASCII only, and it is load-bearing: `btoa` inside
 * {@link toBase64Url} throws on any code point above U+00FF, so without this
 * narrowing an internationalized address would turn the whole sign-in into
 * `start_failed` instead of degrading to "no prefill". It also keeps control
 * bytes — which `\s` does not cover — out of the URL and the prefilled field.
 */
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;

/**
 * Encode a typed address for the `email_hint` param (ISS-5954 M5), or null
 * when the value is not a plausible address — the caller then omits the param
 * entirely, per the absent-optional-field rule. Total: never throws, so an
 * implausible address can never fail the sign-in it decorates.
 */
export function encodeDesktopEmailHint(email: string): string | null {
  const trimmed = email.trim();
  return isPlausibleEmailHint(trimmed) ? toBase64Url(trimmed) : null;
}

/**
 * Inverse of {@link encodeDesktopEmailHint}: the plausible address, or null on
 * a malformed, implausible, or oversize value. Untrusted input narrowed on the
 * way in — the result reaches nothing but a prefilled field value.
 */
export function decodeDesktopEmailHint(
  value: string | null | undefined
): string | null {
  if (!value) {
    return null;
  }
  const decoded = fromBase64Url(value);
  return decoded && isPlausibleEmailHint(decoded) ? decoded : null;
}

function isPlausibleEmailHint(value: string): boolean {
  return (
    value.length <= DESKTOP_EMAIL_HINT_MAX_LENGTH &&
    PLAUSIBLE_EMAIL_RE.test(value) &&
    PRINTABLE_ASCII_RE.test(value)
  );
}

/**
 * The desktop door's framing (ISS-5954): `sign-up` for the converting
 * onboarding doors, `sign-in` for the returning-user doors (the guest
 * landing's "Already have an account?" step). Rides the
 * authorize URL as the `framing` hint so the email landing branch renders the
 * matching Clerk embed. The renderer's `DesktopAuthFraming` is an alias of
 * this const — one vocabulary, not two spellings of it.
 */
export const DesktopSignInFraming = {
  SignUp: "sign-up",
  SignIn: "sign-in",
} as const;
export type DesktopSignInFraming =
  (typeof DesktopSignInFraming)[keyof typeof DesktopSignInFraming];

const DESKTOP_SIGN_IN_FRAMINGS: readonly string[] =
  Object.values(DesktopSignInFraming);

/** Narrow an untrusted query-string value to a known framing; null otherwise. */
export function parseDesktopSignInFraming(
  value: string | null | undefined
): DesktopSignInFraming | null {
  return value && DESKTOP_SIGN_IN_FRAMINGS.includes(value)
    ? (value as DesktopSignInFraming)
    : null;
}

/**
 * ISS-10913: whether the auth return that produced this callback CREATED a new
 * account. Stamped by the web authorize page onto the desktop's loopback
 * `redirect_uri`. The page derives the fact on the server from the pending
 * authorize run and the signed-in user's creation time (ISS-11395 / PLN-2118);
 * no web hop carries it on a URL.
 *
 * ADDITIVE AND PRESENT-ONLY-WHEN-TRUE in both directions. An older web app
 * never sends it and an older desktop build never reads it, and neither may
 * treat its absence as an error: absence means "no creation was observed",
 * which is not the same claim as "an existing account signed in" and is why
 * the analytics fold reports a set with an explicit `unknown` rather than a
 * value that can go missing.
 */
export const DESKTOP_ACCOUNT_CREATED_QUERY_PARAM = "account_created";

/** The one wire spelling of a true {@link DESKTOP_ACCOUNT_CREATED_QUERY_PARAM}. */
export const DESKTOP_ACCOUNT_CREATED_TRUE = "1";

/**
 * Narrow an untrusted callback/query value to "a new account was created".
 * Total and closed: only the exact {@link DESKTOP_ACCOUNT_CREATED_TRUE}
 * spelling is a creation, so an empty or unrecognized value degrades to "not
 * observed" instead of fabricating an outcome.
 *
 * A REPEATED key never reaches here, and the FIRST value is what decides it:
 * the loopback listener extracts one string with `searchParams.get` before
 * calling, so `account_created=1&account_created=0` is a creation and
 * `account_created=0&account_created=1` is not. This function sees only the
 * single string it is handed (tamsinb on #7793).
 */
export function isDesktopAccountCreatedValue(
  value: string | null | undefined
): boolean {
  return value === DESKTOP_ACCOUNT_CREATED_TRUE;
}

/**
 * The BARE (no org slug) web path the desktop opens to start a loopback
 * authorize run.
 *
 * Canonical here, beside the query-param keys, because the desktop's URL
 * builder and every web hop that has to hand a user BACK to this run name the
 * same path: the signed-out deep link's post-auth target, the onboarding
 * exemption, and the org-creation return (ISS-11272). It is the bare form
 * deliberately — `apps/app/proxy.ts` re-prefixes the session's ACTIVE org slug,
 * so a hop that has just changed which org is active must not carry the old
 * one.
 */
export const DESKTOP_AUTHORIZE_PATHNAME =
  "/settings/integrations/desktop/authorize";

/**
 * How long the desktop waits on its loopback listener for an OAuth sign-in's
 * callback. The loopback callback covers the whole browser interaction —
 * sign-in / sign-up + consent — so it is minutes, not the ~60s server-side
 * authorization-code TTL (the code is minted at consent and redeemed within ~1s
 * of the redirect).
 *
 * Shared with the web app (PLN-2118) because the pending-run cookie that
 * carries an authorize run across the Clerk round trip lives exactly as long as
 * the desktop is still listening for it; a second copy of the number would let
 * the cookie outlive the run it resumes.
 */
export const DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;

/**
 * ISS-5954 M3: the loopback ceiling for an EMAIL sign-in, which is the slow
 * path — the Clerk form wants an address, a password, and a verification code
 * fetched from the person's inbox (possibly from a spam folder, possibly after a
 * resend). The OAuth ceiling above is tuned for a consent bounce and would cut
 * this journey off mid-inbox. Shared with the web app for the same reason as
 * {@link DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS}.
 */
export const DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS = 15 * 60_000;

/**
 * Cookie that carries a pending desktop authorize run across the Clerk round
 * trip (ISS-11396 / PLN-2118), so any hop that drops the authorize query string
 * still resumes on the consent page.
 */
export const DESKTOP_AUTHORIZE_RUN_COOKIE = "desktop_authorize_run";

/**
 * Web route that clears {@link DESKTOP_AUTHORIZE_RUN_COOKIE} (`DELETE`). The
 * consent page calls it before handing back to the desktop, which is what makes
 * a run single-use.
 */
export const DESKTOP_AUTHORIZE_RUN_PATHNAME = "/api/desktop/authorize-run";
