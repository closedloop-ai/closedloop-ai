import { z } from "zod";

/**
 * The one thing a refused Clerk call carries that names WHICH refusal it was.
 *
 * Clerk rejects (and, on the `signIn.sso` future API, ANSWERS) with a
 * `ClerkAPIResponseError` whose `errors[].code` is the only machine-readable
 * fact about the failure. ISS-11244 established that discarding it is what
 * makes a browser-only refusal undiagnosable from outside the reporter's
 * browser; ISS-11315 found the sibling sign-up leg still discarding it, so the
 * schema moved here rather than being spelled a second time.
 *
 * Shared by BOTH connect legs: `link/clerk-error-classification.ts` (the
 * signed-in GitHub link) and `sso-refusal-classification.ts` (the signed-out
 * sign-up hand-off).
 */
const clerkApiResponseErrorSchema = z.object({
  errors: z.array(z.object({ code: z.string().min(1) })).min(1),
});

/**
 * The Clerk error code behind an unknown value, or null when the value is not
 * a Clerk API response error. Total: never throws, so classification can never
 * fail the failure it is describing.
 */
export function readClerkErrorCode(error: unknown): string | null {
  const parsed = clerkApiResponseErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.errors[0].code : null;
}
