import { getErrorMessage } from "@repo/app/shared/api/api-error";
import { z } from "zod";

/**
 * @file clerk-error-message.ts
 * @description Turns a rejected Clerk call into the sentence the panel shows
 * (ISS-8364). Clerk rejects with a `ClerkAPIResponseError` carrying an `errors`
 * array whose `longMessage` is the user-facing sentence — a plain `.message`
 * read on one of those yields the SDK's own summary, not the reason the action
 * failed, so a user told "Request failed" learns nothing about the "you cannot
 * remove your last sign-in method" that actually happened.
 *
 * The non-Clerk fallback delegates to the canonical `getErrorMessage` rather
 * than restating its chain.
 */
const clerkApiResponseSchema = z.object({
  errors: z
    .array(
      z.object({
        longMessage: z.string().optional(),
        message: z.string().optional(),
      })
    )
    .nonempty(),
});

export function describeClerkError(error: unknown): string {
  const parsed = clerkApiResponseSchema.safeParse(error);
  if (parsed.success) {
    const [first] = parsed.data.errors;
    const sentence = first.longMessage || first.message;
    if (sentence) {
      return sentence;
    }
  }
  return getErrorMessage(error);
}
