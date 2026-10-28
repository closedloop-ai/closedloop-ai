import {
  baseUrlDuplicatesDeliveryPath,
  isPenseroTokenShape,
  isSecureHttpsUrl,
  PENSERO_DELIVERY_PATH,
} from "@repo/pensero/credential";
import { z } from "zod";

/**
 * Route-boundary validation for a submitted Pensero credential (ISS-8007).
 *
 * Both predicates are IMPORTED from `@repo/pensero/credential`, the same module
 * `keys.ts` validates the env var with, rather than restated as local regexes.
 * A UI that accepts a credential the server-side Pensero client will later
 * reject is worse than no UI, and two hand-kept copies of "what a valid
 * credential looks like" is how that happens.
 */

/** Bound the accepted length so a multi-megabyte body cannot reach the regex. */
const MAX_TOKEN_LENGTH = 500;
const MAX_BASE_URL_LENGTH = 2048;

/**
 * Bound the team-identifier list at both ends of its size (ISS-8761). Each
 * identifier is joined into a query parameter, so an unbounded list is an
 * unbounded request URL, and an unbounded single identifier is the same problem
 * in one field.
 */
const MAX_TEAM_IDENTIFIERS = 50;
const MAX_TEAM_IDENTIFIER_LENGTH = 200;

export const setPenseroCredentialValidator = z.object({
  token: z
    .string()
    .min(1, "Pensero token is required")
    .max(MAX_TOKEN_LENGTH, "Pensero token is too long")
    .refine(isPenseroTokenShape, {
      message:
        "Pensero token must look like tk_<public>:sk_<secret> with no surrounding whitespace.",
    }),
  /**
   * Optional per-org base-URL override. `null` explicitly CLEARS a previous
   * override (falling back to the deployment default); omitting the field is
   * treated the same way by the service, so there is no third "leave it alone"
   * state to get wrong.
   *
   * Trimmed BEFORE validation, because `new URL()` tolerates surrounding
   * whitespace: without this a padded value would validate and then be STORED
   * padded. The card's `type="url"` field already strips whitespace client-side,
   * but that is the platform's guarantee for one client, not this contract's.
   *
   * `isSecureHttpsUrl` enforces four rules, and the message below names all
   * four because an admin who is rejected has to be told WHICH one they hit:
   * https:// only (so the secret-bearing `Authorization` header is never sent
   * in cleartext); a host that is not internal to the deployment (loopback,
   * private, link-local, or metadata — a tenant must not be able to aim the
   * server's own requests there, and unlike the env var there is no exemption);
   * no query string or fragment (the delivery-metrics client refuses to build a
   * request URL from one); and no userinfo, because `base_url` is stored in
   * plaintext and read back by every org member.
   */
  baseUrl: z
    .string()
    .trim()
    .max(MAX_BASE_URL_LENGTH, "Base URL is too long")
    .refine(isSecureHttpsUrl, {
      message:
        "Pensero base URL must be an absolute https:// URL on a public host, with no query string, fragment, or embedded username/password.",
    })
    /**
     * ISS-9689, and the rule none of `isSecureHttpsUrl`'s four constrains: the
     * PATH. An org admin pasted the full request URL
     * (`https://pensero.ai/api/v1/delivery`) into this field, all four rules
     * passed, and the daily cron then spent eleven days asking for
     * `/api/v1/delivery/v1/delivery` and answering `404 basePathSegments=3`.
     *
     * Deliberately NOT a path-shape rule — a multi-segment tenant base such as
     * `https://tenant.example/private/customer-42` is legitimate and stays
     * accepted. This refuses only the one shape that provably cannot work,
     * whatever the deployment: a base the client would append its own
     * `/v1/delivery` to when it already ends in one.
     *
     * Its own `.refine`, not folded into the predicate above, so the admin is
     * told WHICH rule they hit and what to type instead — a combined message
     * naming five rules is one nobody reads.
     */
    .refine((value) => !baseUrlDuplicatesDeliveryPath(value), {
      message: `Pensero base URL already ends in ${PENSERO_DELIVERY_PATH}, which would be requested twice. Enter the API base (for example https://pensero.ai/api), not the full request URL.`,
    })
    .nullish(),
  /**
   * PROVIDER team identifiers this org's scheduled poll is narrowed to
   * (ISS-8761). An EMPTY list means "do not narrow": the scheduler omits the
   * `team_identifiers` parameter entirely and accepts Pensero's all-teams
   * response. Sending an empty parameter instead would ask Pensero to scope to
   * nothing, and the empty window it returned would be indistinguishable from a
   * quiet day.
   *
   * OMITTING the key is a THIRD state, and unlike `baseUrl` above it does not
   * collapse into the empty one (codex + whitlockk, #6492): it means "leave the
   * stored list alone". The control is behind a closed-by-default flag, so a
   * client that cannot see the stored list cannot restate it, and treating its
   * omission as "clear" silently widened an org's poll to every Pensero team
   * whenever an admin rotated a token with the flag off. The service owns that
   * rule; this validator's job is only to keep the three states distinguishable
   * on the wire, which `.optional()` (rather than a default) is what does.
   *
   * These are Pensero's own identifiers. They are deliberately NOT validated
   * against, derived from, or defaulted to ClosedLoop `Team` names — the two
   * name different populations, and silently substituting one for the other
   * would narrow a poll to a set the admin never chose.
   *
   * Trimmed then filtered, so a trailing comma in the card's input does not
   * store a blank identifier that would be joined into the query as `,,`.
   */
  teamIdentifiers: z
    .array(
      z
        .string()
        .trim()
        .max(MAX_TEAM_IDENTIFIER_LENGTH, "Team identifier is too long")
    )
    .max(MAX_TEAM_IDENTIFIERS, "Too many team identifiers")
    .transform((values) => values.filter((value) => value.length > 0))
    .optional(),
});
