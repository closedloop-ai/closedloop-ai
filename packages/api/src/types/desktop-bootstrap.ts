import { z } from "zod";

/**
 * ISS-10966 (PLN-2095 Slice 1) — the shared wire contract for the desktop
 * BOOTSTRAP handoff: the mint a browser performs for a freshly signed-up user
 * who has no organization yet, so the Desktop-originated signup returns to
 * Desktop instead of finishing organization setup in the browser tab.
 *
 * WHY A SECOND CONTRACT RATHER THAN A FIELD ON THE FIRST. Its sibling
 * {@link ./desktop-authorize} mints against a principal Clerk reports as
 * signed-in WITH an organization, and everything downstream of that mint is
 * organization-bound: the code row carries `user_id` and `organization_id`, and
 * redeeming it issues an org-scoped desktop session. The bootstrap principal has
 * neither — there is no internal `user` row to point at, because
 * `apps/api/lib/auth/find-or-create-user.ts` resolves users only as
 * `(clerkUserId, clerkOrgId)` pairs. Widening the existing contract to express
 * "no organization" would relax an invariant every existing reader relies on;
 * a separate contract, table and route leave that one byte-for-byte intact.
 *
 * NOTHING IN THIS MODULE IS ON A READ OR WRITE PATH YET. Slice 1 ships the
 * contract and the storage it will use; the mint route (Slice 2), the redeem
 * route (Slice 3) and the browser surface (Slice 4) import from here.
 */

/**
 * Body sent to `POST /desktop/bootstrap-authorize`.
 *
 * Deliberately the SAME six fields as
 * {@link ./desktop-authorize.DesktopAuthorizeMintRequest}, and deliberately a
 * separate type rather than an alias of it: the two requests are validated by
 * two `.strict()` validators against two different principals, and an alias
 * would make a future field added for one silently part of the other's accepted
 * surface. The client supplies only device-binding material — the server binds
 * the minted code to the Clerk-resolved `clerkUserId`, never to anything here.
 *
 * `webAppOrigin` is the page's own origin, echoed so the route can match it
 * against the browser-sent `Origin` header as CSRF defense-in-depth.
 */
export type DesktopBootstrapMintRequest = {
  webAppOrigin: string;
  gatewayId: string;
  gatewayPublicKeyPem: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
};

/**
 * Body returned by `POST /desktop/bootstrap-authorize` (raw, un-enveloped).
 * Single source of truth for the response shape: the service builds its result
 * to satisfy it, and the browser mint hook parses the raw response through it,
 * so a malformed 2xx surfaces as an error instead of handing Desktop an
 * `undefined` code.
 *
 * NOT `.strict()`, which is the deliberate choice and not an omission. This
 * schema sits on the RESPONSE side of a version-skewed boundary: a newer API
 * adding a field must not make an older browser bundle reject the whole payload
 * and strand a user mid-signup. Unknown keys are therefore ignored, exactly as
 * the sibling `desktopAuthorizeMintResultSchema` ignores them. The REQUEST
 * validator — where an unknown key means a client the server does not
 * understand and the strict-boundary rule applies — lives with the route.
 */
export const desktopBootstrapMintResultSchema = z.object({
  code: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type DesktopBootstrapMintResult = z.infer<
  typeof desktopBootstrapMintResultSchema
>;

export const desktopBootstrapRedeemResultSchema = z.object({
  bootstrapToken: z.string().min(1),
  expiresAt: z.string().min(1),
  /** Clerk subject for the signed-up user while no internal org-bound user exists. */
  pendingUserId: z.string().min(1),
});

export type DesktopBootstrapRedeemResult = z.infer<
  typeof desktopBootstrapRedeemResultSchema
>;

export type DesktopBootstrapOrganizationRequest = z.infer<
  typeof desktopBootstrapOrganizationRequestSchema
>;

export const DESKTOP_BOOTSTRAP_ORGANIZATION_NAME_MAX_LENGTH = 100;
export const DESKTOP_BOOTSTRAP_ORGANIZATION_SLUG_MAX_LENGTH = 100;

/**
 * Every refusal code the bootstrap mint, token and organization routes put on the wire,
 * as a const object so no call site or test repeats the literal.
 *
 * One code per DISTINGUISHABLE refusal, mirroring the sibling mint's vocabulary
 * so a reader of either route recognises the other. Each route has a retryable
 * 503 failure code; validation and authorization refusals are not retryable.
 *
 * NEITHER KEY IS NAMED `InvalidRequest`, deliberately. The two refusals below
 * are the route's own body/key validation (`INVALID_DESKTOP_BOOTSTRAP`) and the
 * service's refusal of an already-valid body (`DESKTOP_BOOTSTRAP_INVALID_REQUEST`)
 * — mirroring `apps/api/app/desktop/authorize/route.ts:71` and `:114`. A key
 * spelled `InvalidRequest` reads as the second and resolves to the first, so a
 * later slice reaching for it on a service refusal would put the route's code on
 * the wire with nothing red. `InvalidBody` and `ServiceRejected` name the branch
 * each one actually belongs to.
 */
export const DesktopBootstrapErrorCode = {
  /**
   * No pending, organization-less Clerk principal. Distinct spelling from the
   * sibling's `SESSION_REQUIRED` on purpose: this route admits a strictly
   * NARROWER principal than a signed-in user, so a client must not read the two
   * refusals as the same condition and retry one against the other.
   */
  PendingSessionRequired: "PENDING_SESSION_REQUIRED",
  /** Body failed validation, or the device key is not a usable Ed25519 SPKI PEM. */
  InvalidBody: "INVALID_DESKTOP_BOOTSTRAP",
  /** Origin check failed — the mint did not originate from the trusted web app. */
  Forbidden: "DESKTOP_BOOTSTRAP_FORBIDDEN",
  /** A validated request the service still refused. */
  ServiceRejected: "DESKTOP_BOOTSTRAP_INVALID_REQUEST",
  /** Mint server-side fault; retryable. */
  Failed: "DESKTOP_BOOTSTRAP_FAILED",
  TokenInvalidBody: "INVALID_DESKTOP_BOOTSTRAP_TOKEN",
  TokenFailed: "DESKTOP_BOOTSTRAP_TOKEN_FAILED",
  ProofOfPossessionRequired: "DESKTOP_SESSION_POP_REQUIRED",
  TokenInvalid: "DESKTOP_BOOTSTRAP_TOKEN_INVALID",
  BootstrapRequired: "DESKTOP_BOOTSTRAP_REQUIRED",
  OrganizationInvalidBody: "INVALID_DESKTOP_ORGANIZATION",
  OrganizationFailed: "DESKTOP_ORGANIZATION_FAILED",
  OrganizationAlreadyExists: "DESKTOP_ORGANIZATION_ALREADY_EXISTS",
  BootstrapInvalid: "DESKTOP_BOOTSTRAP_INVALID",
} as const;
export type DesktopBootstrapErrorCode =
  (typeof DesktopBootstrapErrorCode)[keyof typeof DesktopBootstrapErrorCode];

/**
 * Clerk's `choose-organization` session task key — the task whose create screen
 * is the reporter's "Setup your organization" page (`packages/auth/components/
 * appearance.ts` styles that same screen).
 *
 * Named here rather than typed inline at the read site because Slice 4 branches
 * on it to decide whether to render the Clerk embed at all: a typo in a bare
 * literal would silently never match, the embed would render, and the bug this
 * ticket describes would look unfixed with nothing red. The value is Clerk's,
 * not ours — it is one member of `@clerk/shared`'s `SessionTask['key']` union,
 * so it is pinned as a literal and asserted against the session resource at the
 * read site rather than re-declared as our own vocabulary.
 */
export const CLERK_SESSION_TASK_CHOOSE_ORGANIZATION =
  "choose-organization" as const;

export const ORGANIZATION_LOGO_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const DESKTOP_BOOTSTRAP_LOGO_MAX_BASE64_CHARS =
  4 * Math.ceil(ORGANIZATION_LOGO_MAX_SIZE_BYTES / 3);

export const desktopBootstrapOrganizationLogoSchema = z
  .object({
    name: z.string().min(1).max(255),
    type: z.string().startsWith("image/").max(255),
    base64: z
      .string()
      .min(4)
      .max(DESKTOP_BOOTSTRAP_LOGO_MAX_BASE64_CHARS)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .refine((value) => {
        const padding = value.length - value.replaceAll("=", "").length;
        return (
          value.length % 4 === 0 &&
          (value.length / 4) * 3 - padding <= ORGANIZATION_LOGO_MAX_SIZE_BYTES
        );
      }),
  })
  .strict();
export type DesktopBootstrapOrganizationLogo = z.infer<
  typeof desktopBootstrapOrganizationLogoSchema
>;

export const desktopBootstrapOrganizationRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(DESKTOP_BOOTSTRAP_ORGANIZATION_NAME_MAX_LENGTH),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(DESKTOP_BOOTSTRAP_ORGANIZATION_SLUG_MAX_LENGTH),
    /** Optional staged logo; omitted by older Desktop builds. */
    logo: desktopBootstrapOrganizationLogoSchema.optional(),
  })
  .strict();

/** Main-process upload metadata; never accepts a caller-selected bucket or URL. */
export const desktopBootstrapLogoReferenceSchema =
  desktopBootstrapOrganizationLogoSchema.omit({ base64: true }).extend({
    size: z.number().int().positive().max(ORGANIZATION_LOGO_MAX_SIZE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  });
export type DesktopBootstrapLogoReference = z.infer<
  typeof desktopBootstrapLogoReferenceSchema
>;

/** HTTP uses a reference; raw logo bytes are confined to renderer-to-main IPC. */
export const desktopBootstrapOrganizationHttpRequestSchema =
  desktopBootstrapOrganizationRequestSchema
    .omit({ logo: true })
    .extend({ logo: desktopBootstrapLogoReferenceSchema.optional() });
export type DesktopBootstrapOrganizationHttpRequest = z.infer<
  typeof desktopBootstrapOrganizationHttpRequestSchema
>;

export const desktopBootstrapLogoUploadResultSchema = z.object({
  uploadUrl: z.url().refine((value) => new URL(value).protocol === "https:"),
});
