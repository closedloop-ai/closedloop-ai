import { isUuidV4 } from "@repo/api/src/types/onboarding-analytics";
import { z } from "zod";
import { isValidS256CodeChallenge } from "@/lib/auth/pkce";

const codeChallenge = z.string().refine(isValidS256CodeChallenge);
export const signInAnalyticsRegistrationSchema = z
  .object({
    codeChallenge,
    flowId: z.string().refine(isUuidV4),
  })
  .strict();
export const signInAnalyticsReportSchema = z.object({ codeChallenge }).strict();
