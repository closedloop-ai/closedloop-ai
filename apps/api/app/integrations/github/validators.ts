import { GitHubClerkLinkClientFailureStage } from "@repo/api/src/types/github";
import { z } from "zod";

/**
 * PLN-1742 M5: the OAuth `code` is retired — a claim is verified through the
 * App-JWT installation lookup plus the web callback's CSRF state, not a code
 * exchange. A stale `apps/app` deploy may still POST `{ code, installationId }`;
 * `z.object()` strips unknown keys, so the skewed payload degrades to a plain
 * claim instead of failing.
 */
export const claimGitHubInstallationValidator = z.object({
  installationId: z.string().min(1, "Installation id is required"),
});

/**
 * ISS-11244: the browser's report of a link failure this API could not otherwise
 * see. Every error field is optional because a report need not carry one — three
 * of the four stages resolved without refusing at all — and `z.object()` strips
 * unknown keys, so a newer browser sending more degrades to the fields this
 * server knows rather than failing the report.
 *
 * `stage` has a DEFAULT rather than being required, so a browser shipped before
 * it existed still records: an older client posting `{}` or `{clerkErrorCode}` is
 * exactly the `threw` case it used to be the only reporter of, and rejecting it
 * would return that browser's only observation to silence.
 *
 * Codes are bounded at 200 characters: a Clerk error code is a short snake_case
 * token, and the value lands in a log attribute a monitor facets on.
 * `apiErrorStatus` is an HTTP status, with 0 reserved by the shared client for a
 * transport failure that never reached a server.
 */
export const reportGitHubClerkLinkClientFailureValidator = z.object({
  apiErrorCode: z.string().min(1).max(200).optional(),
  apiErrorStatus: z.number().int().min(0).max(599).optional(),
  clerkErrorCode: z.string().min(1).max(200).optional(),
  // `.default` and DELIBERATELY NOT `.catch` (ISS-11315 review, tamsinb).
  // The two cover opposite skews and only one of them is safe here. `.default`
  // supplies a value when the key is ABSENT — an older browser that predates
  // the field, whose report genuinely IS the `threw` case it used to be the
  // only reporter of. `.catch` would cover the other direction, a NEWER browser
  // sending a stage this deployment has never heard of — and folding that to
  // `threw` writes a WRONG FACT into the monitor: a `signup_handoff_refused`
  // would land beside real throws with nothing to tell them apart. ISS-11244
  // ruled that a refused report beats a mislabelled one, and
  // `client-failure/route.test.ts` pins it. Refusing loses one report; catching
  // corrupts the facet every report is read through.
  stage: z
    .enum(GitHubClerkLinkClientFailureStage)
    .default(GitHubClerkLinkClientFailureStage.Threw),
});
