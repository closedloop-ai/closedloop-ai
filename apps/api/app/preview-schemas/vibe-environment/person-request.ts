import { z } from "zod";

/** Match the workflow's selected-org input without accepting another Clerk id kind. */
const CLERK_ORG_ID = /^org_[A-Za-z0-9]{1,100}$/;

/**
 * ISS-12056: who a vibe environment is for. The skill knows the person's
 * email; `clerkOrgId` picks among their stage Clerk orgs and wins over the
 * server's own choice (ISS-12135), which is why it stays optional.
 */
export const personRequestShape = {
  personEmail: z.email().max(320),
  clerkOrgId: z.string().regex(CLERK_ORG_ID).optional(),
};
