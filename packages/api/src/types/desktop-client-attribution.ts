/**
 * ISS-8749: caller-attested Desktop build metadata, carried from the Desktop
 * main process to `apps/api` on every first-party cloud request and recorded on
 * the request span, rejected requests included (ISS-11431).
 *
 * Two rules the rest of this module exists to enforce.
 *
 * TELEMETRY ONLY, for the two ISS-8749 members. `InstallationId` and
 * `ClientVersion` are supplied by the caller and are never verified against
 * anything. Nothing in the platform may authenticate, authorize, scope a tenant,
 * or route on them — the session token does all of that, and a header a client
 * writes for itself cannot be evidence of anything. The API therefore reads them
 * exactly once, into the span attribution store.
 *
 * `ComputeTargetId` (ISS-9164) is the deliberate exception, and it is an
 * exception to "telemetry only", NOT to "never evidence of anything". The
 * updater feed routes ROUTE on it: they look the target up to decide which
 * desktop release ring to serve. That is sound only because the ring is not a
 * trust boundary — every ring serves an artifact an unauthenticated client can
 * already download, and the request itself carries no session (a packaged,
 * signed build cannot redirect its baked-in feed URL, so the feed is the one
 * first-party endpoint with no auth to read). It still authenticates nothing,
 * scopes no tenant, and must never be reached for by a route that does.
 *
 * VERSION-SKEWED. A Desktop build older than this change sends neither header,
 * and must keep working unchanged. So both fields are optional at every hop, an
 * absent value is OMITTED rather than serialized as null or a placeholder, and
 * a malformed value is dropped on its own rather than failing the request or
 * taking its sibling with it.
 */
import { z } from "zod";

/**
 * The wire header names. One declaration, imported by the Desktop sender and
 * the API reader, so a rename cannot silently half-land.
 *
 * `x-desktop-client-version` is the Electron app build, the same value the
 * analytics lane already calls `desktop_client_version`. It is deliberately NOT
 * the Code plugin version (`x-desktop-plugin-version`, `desktop-write-lane.ts`)
 * — that file's own comment warns against conflating the two.
 */
export const DesktopClientAttributionHeader = {
  InstallationId: "x-desktop-installation-id",
  ClientVersion: "x-desktop-client-version",
  /**
   * ISS-9164: the compute target this install writes under, sent on the desktop
   * updater's FEED CHECK so the feed can resolve a release ring. Not part of
   * {@link DesktopClientAttribution} — see the module docstring for why it is
   * deliberately NOT carried on the general first-party request lane.
   *
   * The check, and only the check: the desktop takes it back off electron-updater's
   * shared `requestHeaders` before a download starts, because the asset route 302s
   * cross-origin to the release host and the pinned `builder-util-runtime` would
   * carry it there (`registerUpdaterDownloadHeaderNarrowing`, #6867). The asset
   * route therefore always resolves the general ring today.
   *
   * Since ISS-9790 that removal is not hardcoded to THIS header: it falls out of
   * {@link UpdaterHeaderRedirectSafety}, and the download leg keeps only what
   * {@link DesktopUpdaterRequestFields} classifies `AnyOrigin`. Add a header
   * there, not to the narrowing function.
   */
  ComputeTargetId: "x-desktop-compute-target-id",
} as const;

/** Literal union of the Desktop client-attribution header names. */
export type DesktopClientAttributionHeader =
  (typeof DesktopClientAttributionHeader)[keyof typeof DesktopClientAttributionHeader];

/**
 * Maximum accepted length of the attested Desktop build version.
 *
 * Kept equal to `TelemetryTextMaxLength.AppClientVersion`, which bounds the same
 * value once it reaches the span. Restated rather than imported because
 * `packages/api` does not depend on `@closedloop-ai/telemetry-contract`; a
 * version longer than the span's bound would be accepted here and then dropped
 * by the span schema, which is safe but silently loses the attribute.
 */
export const DESKTOP_CLIENT_VERSION_MAX_LENGTH = 64;

/**
 * A dotted release version, optionally with a pre-release/build suffix.
 *
 * This is the whole narrowing, and it lives here because HERE is the trust
 * boundary: the value is whatever a caller typed into a header. The span schema
 * downstream only bounds length and control characters, so a path, an address,
 * or a sentence is unrepresentable because THIS pattern refuses it — not
 * because anything later would. A Desktop build that reports something else has
 * its version dropped and keeps its installation id.
 *
 * The suffix is a dot- or hyphen-separated list of identifiers, each of which
 * must be alphanumeric. Spelling it that way rather than as one `[0-9A-Za-z.-]+`
 * class is the difference between a suffix and a pile of punctuation: the loose
 * class also matched `1.2.3+.` and `1.2.3+-`, which no Desktop resolver emits
 * and which would have put junk in the `app.client.version` facet.
 */
const DESKTOP_CLIENT_VERSION_PATTERN =
  /^\d+(\.\d+){0,3}(?:[-+][0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

/**
 * Per-field validators, deliberately not combined into one object schema.
 *
 * Validating each header on its own is what makes "degrade by omission" true at
 * the field level: a Desktop build that reports a garbage version still gets its
 * installation id recorded, where a whole-object parse would have discarded
 * both. The same reasoning the span emitter already applies to its `.strict()`
 * boundary.
 */
export const DesktopInstallationIdSchema = z.uuid();

export const DesktopClientVersionSchema = z
  .string()
  .min(1)
  .max(DESKTOP_CLIENT_VERSION_MAX_LENGTH)
  .regex(DESKTOP_CLIENT_VERSION_PATTERN);

/** The attested Desktop build metadata, both members independently optional. */
export type DesktopClientAttribution = {
  installationId?: string;
  clientVersion?: string;
};

/**
 * Render the attribution as request headers, omitting any field the caller
 * could not supply or whose value does not satisfy the contract.
 *
 * Validating on the SEND side as well as the receive side is not belt-and-
 * braces: a header this process cannot justify is one the server would drop
 * anyway, and sending it would put an unvalidated local string on the wire for
 * no benefit.
 */
export function buildDesktopClientAttributionHeaders(
  attribution: DesktopClientAttribution | undefined
): Record<string, string> {
  if (!attribution) {
    return {};
  }
  const installationId = DesktopInstallationIdSchema.safeParse(
    attribution.installationId
  );
  const clientVersion = DesktopClientVersionSchema.safeParse(
    attribution.clientVersion
  );
  return {
    ...(installationId.success && {
      [DesktopClientAttributionHeader.InstallationId]: installationId.data,
    }),
    ...(clientVersion.success && {
      [DesktopClientAttributionHeader.ClientVersion]: clientVersion.data,
    }),
  };
}

/**
 * Read the attested metadata off an inbound request, dropping anything that
 * does not validate.
 *
 * Total by construction: absent headers, a header from a newer client carrying
 * a shape this build does not accept, and a hostile value all resolve to an
 * absent field. Nothing here can throw, because a request must never fail on
 * the strength of a telemetry header.
 */
export function parseDesktopClientAttributionHeaders(
  headers: Headers
): DesktopClientAttribution {
  const installationId = DesktopInstallationIdSchema.safeParse(
    headers.get(DesktopClientAttributionHeader.InstallationId) ?? undefined
  );
  const clientVersion = DesktopClientVersionSchema.safeParse(
    headers.get(DesktopClientAttributionHeader.ClientVersion) ?? undefined
  );
  return {
    ...(installationId.success && { installationId: installationId.data }),
    ...(clientVersion.success && { clientVersion: clientVersion.data }),
  };
}

/**
 * ISS-9164: the release ring the updater feed resolved, answered back on the
 * response.
 *
 * A response header rather than a body field because the body is
 * `latest-mac.yml`, whose shape electron-updater owns. Nothing in this repo reads
 * it today — PRD-707 v3 cancelled the idle auto-relaunch (ISS-9263) that was to
 * be its first consumer — so it ships as the answer a later ring-aware client can
 * gate on without a second lookup. Clients that ignore it are unaffected.
 */
export const DesktopUpdaterRingHeader = "x-desktop-ring" as const;

/**
 * The compute-target id, which is a `ComputeTarget.id` and therefore a UUID.
 *
 * The narrowing IS the malformed-id gate the ring resolver relies on: a value
 * that is not a UUID never reaches a database lookup or the negative cache, so
 * the unauthenticated feed route cannot be handed arbitrary strings to key
 * either on.
 */
export const DesktopComputeTargetIdSchema = z.uuid();

/**
 * What a desktop updater request attests about itself. Both members independently
 * optional, for the same reason {@link DesktopClientAttribution}'s are: an
 * installed build that predates ISS-9164 sends neither, and a singleplayer or
 * freshly installed client has no compute target to name.
 */
export type DesktopUpdaterRequestAttribution = {
  computeTargetId?: string | null;
  clientVersion?: string | null;
};

/**
 * ISS-9790: whether a header stamped on `autoUpdater.requestHeaders` may
 * survive a cross-origin redirect.
 *
 * `requestHeaders` is ONE property, read by the feed check and again by the
 * asset DOWNLOAD (`AppUpdater.computeRequestHeaders`), and the asset route
 * answers with a cross-origin 302 to the release host. Nothing downstream
 * protects it: `builder-util-runtime@9.6.2` — the version
 * `electron-updater@6.8.7` pins EXACTLY, not by caret — replays every header
 * onto the redirect target and deletes exactly one, `authorization`
 * (`prepareRedirectUrlOptions`, `out/httpExecutor.js:252`). It carries no
 * sensitive-header set: `SENSITIVE_REDIRECT_HEADERS` and
 * `addSensitiveRedirectHeader` landed in `9.7.0`, whose copy in this tree
 * belongs to electron-builder and is a different module instance the updater
 * never reads. So there is no upstream seam to register a name with, and the
 * property must simply not be carrying anything first-party by the time a
 * download starts.
 */
export const UpdaterHeaderRedirectSafety = {
  /**
   * Safe to hand a third-party release host: the value tells it nothing the
   * request line did not already.
   */
  AnyOrigin: "any-origin",
  /** Must be off the shared property before a download starts. */
  FirstPartyOnly: "first-party-only",
} as const;

/** Literal union of the redirect-safety classifications. */
export type UpdaterHeaderRedirectSafety =
  (typeof UpdaterHeaderRedirectSafety)[keyof typeof UpdaterHeaderRedirectSafety];

/** Everything this module needs to know about one updater attribution field. */
type DesktopUpdaterRequestFieldSpec = {
  header: DesktopClientAttributionHeader;
  schema: z.ZodType<string>;
  read: (
    attribution: DesktopUpdaterRequestAttribution
  ) => string | null | undefined;
  redirectSafety: UpdaterHeaderRedirectSafety;
};

/**
 * Every updater attribution field, keyed by the field it describes so a new
 * member of {@link DesktopUpdaterRequestAttribution} fails `tsc` until it has a
 * wire name, a validator, a reader, AND a redirect classification.
 *
 * `Record<keyof T, …>` is the whole point: this module validates field-by-field
 * rather than through one object schema (see
 * {@link buildDesktopClientAttributionHeaders}), which means there is no
 * `.strict()` parse to reject an unknown key and therefore nothing that would
 * otherwise notice a field added without one of those four. It would simply
 * never be sent — or, since ISS-9790, be sent and then forwarded to the release
 * host with nothing having decided that was acceptable.
 *
 * ONE record rather than four parallel ones because
 * {@link REDIRECT_SAFE_UPDATER_HEADERS} is DERIVED from it: a field's wire name
 * and its redirect answer have to come off the same row, or the derived set can
 * name a header the builder never sends and miss one it does.
 */
const DesktopUpdaterRequestFields: Record<
  keyof DesktopUpdaterRequestAttribution,
  DesktopUpdaterRequestFieldSpec
> = {
  computeTargetId: {
    header: DesktopClientAttributionHeader.ComputeTargetId,
    schema: DesktopComputeTargetIdSchema,
    read: (attribution) => attribution.computeTargetId,
    // An opaque per-install identifier. The release host has no business
    // learning which install asked for a build (davetho, #6867).
    redirectSafety: UpdaterHeaderRedirectSafety.FirstPartyOnly,
  },
  clientVersion: {
    header: DesktopClientAttributionHeader.ClientVersion,
    schema: DesktopClientVersionSchema,
    read: (attribution) => attribution.clientVersion,
    // Evaluated rather than swept along (ISS-9790 acceptance): the asset URL
    // already spells the version
    // (`…/desktop-v<ver>/Closedloop-<ver>-universal-mac.zip`), so this is a
    // header and not a disclosure, and it deliberately stays on both legs.
    redirectSafety: UpdaterHeaderRedirectSafety.AnyOrigin,
  },
};

/**
 * The header names that may cross an origin boundary, DERIVED from the
 * classification above rather than listed beside it.
 *
 * A hand-written `ReadonlySet<string>` is the shape this repo has been bitten
 * by: it widens to `string`, so a field added to
 * {@link DesktopUpdaterRequestAttribution} would compile, be stamped by the
 * builder, and be silently kept on the download leg. Derived, the exhaustive
 * `Record` is the only thing that can answer, and omitting a row fails `tsc`.
 *
 * Lower-cased on the way in so the lookup in
 * {@link narrowDesktopUpdaterHeadersForRedirect} can be case-insensitive, which
 * HTTP header names are.
 */
const REDIRECT_SAFE_UPDATER_HEADERS: ReadonlySet<string> = new Set(
  Object.values(DesktopUpdaterRequestFields)
    .filter(
      (field) => field.redirectSafety === UpdaterHeaderRedirectSafety.AnyOrigin
    )
    .map((field) => field.header.toLowerCase())
);

/**
 * Render a desktop updater request's headers, omitting any field this install
 * cannot supply or whose value does not satisfy the contract.
 *
 * Omission is per field, not all-or-nothing: an install with no compute target
 * still attests its version, and a build reporting a garbage version still gets
 * ringed. The server's absent-value path is the same one an older build takes.
 */
export function buildDesktopUpdaterRequestHeaders(
  attribution: DesktopUpdaterRequestAttribution
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const field of Object.values(DesktopUpdaterRequestFields)) {
    const parsed = field.schema.safeParse(field.read(attribution));
    if (parsed.success) {
      headers[field.header] = parsed.data;
    }
  }
  return headers;
}

/**
 * Read the attested compute-target id off an inbound updater request, or
 * `undefined` when it is absent or malformed.
 *
 * Total by construction, like its attribution sibling: an updater request must
 * never fail on the strength of this header, because the client that sent it
 * cannot be told to stop.
 */
export function parseDesktopUpdaterComputeTargetId(
  headers: Headers
): string | undefined {
  const computeTargetId = DesktopComputeTargetIdSchema.safeParse(
    headers.get(DesktopClientAttributionHeader.ComputeTargetId) ?? undefined
  );
  return computeTargetId.success ? computeTargetId.data : undefined;
}

/**
 * ISS-9790 — drop every header that must not cross an origin boundary, leaving
 * the shared `autoUpdater.requestHeaders` safe for a download that 302s to a
 * third-party release host.
 *
 * FAIL-CLOSED, and that is the reason it takes the LIVE property rather than
 * rebuilding a known-good pair from scratch. A header this module never
 * classified — one a future caller spreads straight onto the singleton, which
 * no `Record<keyof T, …>` can see — is DROPPED rather than passed through.
 * Rebuilding `{clientVersion}` instead is only correct for as long as everyone
 * who adds a header remembers to come back here and retype it, which is exactly
 * the review attention this ticket exists to stop depending on.
 *
 * It is a narrowing of the SET, not a per-hop strip, because the pinned
 * `builder-util-runtime` offers no hook at the hop (see
 * {@link UpdaterHeaderRedirectSafety}). Applied before the download starts it
 * is strictly stronger for that leg — the header is absent from the first hop,
 * the tenth, and every retry, not just the one a strip would have caught.
 *
 * The residual it does NOT cover, stated rather than implied: the FEED CHECK
 * leg still carries `FirstPartyOnly` headers, so a cross-origin 302 introduced
 * on our own feed route would forward them. That route is first-party and does
 * not redirect today; `updater-redirect-header-leak.test.ts` pins what the
 * pinned dependency would do if it did.
 *
 * Total: a null, absent, or never-stamped property narrows to an empty set.
 * Generic in the value so it can take `electron-updater`'s `OutgoingHttpHeaders`
 * without a cast at the call site.
 */
export function narrowDesktopUpdaterHeadersForRedirect<T>(
  headers: Readonly<Record<string, T>> | null | undefined
): Record<string, T> {
  // A plain object literal is safe here where a dispatch table would not be:
  // only an allow-listed name is ever assigned, and no `__proto__` spelling can
  // reach the derived set.
  const narrowed: Record<string, T> = {};
  if (!headers) {
    return narrowed;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (REDIRECT_SAFE_UPDATER_HEADERS.has(name.toLowerCase())) {
      narrowed[name] = value;
    }
  }
  return narrowed;
}
