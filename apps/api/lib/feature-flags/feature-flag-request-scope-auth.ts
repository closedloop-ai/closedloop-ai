import {
  FEATURE_FLAG_OVERRIDES_HEADER,
  FEATURE_FLAGS_CHECKED_HEADER,
  parseFeatureFlagOverrides,
} from "@repo/api/src/types/feature-flag-overrides";
import { isStaffEmail } from "@repo/api/src/types/staff-email";
import { runWithFeatureFlagRequestScope } from "./feature-flag-request-scope";
import { evaluateServerFeatureFlagForDistinctId } from "./server-feature-flag-evaluation";
import { DEV_MODE_SERVER_FLAG } from "./server-feature-flags";

/** The signed-in caller, as an auth wrapper resolved it. */
export type FeatureFlagRequestCaller = {
  clerkUserId: string | null | undefined;
  email: string | null | undefined;
};

/**
 * ISS-12048: runs an authenticated handler with the caller's Dev Tools
 * overrides in scope, and reports the flags it checked.
 *
 * Nothing happens unless the request carries the overrides header, which the
 * browser sends only while Dev Mode is on. Even then the header is a request,
 * never a claim the API trusts: the overrides apply only after the API verifies
 * Dev Mode for this caller itself, with the same two conditions web and Desktop
 * use (a staff email, and `dev-mode` enabled for them in PostHog). A caller who
 * fails that check gets exactly the live flags and no checked-keys header, so a
 * non-internal user can never unlock a flag or learn which flags a request read.
 */
export async function runWithFeatureFlagOverrides<T extends Response>(
  request: Request,
  caller: FeatureFlagRequestCaller,
  handler: () => Promise<T>
): Promise<T> {
  const header = request.headers.get(FEATURE_FLAG_OVERRIDES_HEADER);
  const distinctId = caller.clerkUserId;
  if (header === null || !distinctId) {
    return handler();
  }

  let verified: Promise<Readonly<Record<string, boolean>> | null> | null = null;
  const overrides = () => {
    verified ??= verifyOverrides(header, distinctId, caller.email);
    return verified;
  };
  const checkedKeys = new Set<string>();

  const response = await runWithFeatureFlagRequestScope(
    { distinctId, overrides, checkedKeys },
    handler
  );
  if ((await overrides()) !== null) {
    response.headers.set(
      FEATURE_FLAGS_CHECKED_HEADER,
      [...checkedKeys].join(",")
    );
  }
  return response;
}

/**
 * The parsed overrides when the caller is in Dev Mode by the API's own check,
 * else `null`. The `dev-mode` read goes through the ordinary evaluator, which
 * never applies an override to that one key, so the check cannot be
 * overridden by the header it is checking.
 */
async function verifyOverrides(
  header: string,
  distinctId: string,
  email: string | null | undefined
): Promise<Readonly<Record<string, boolean>> | null> {
  if (!isStaffEmail(email)) {
    return null;
  }
  const devModeEnabled = await evaluateServerFeatureFlagForDistinctId(
    DEV_MODE_SERVER_FLAG,
    distinctId
  );
  if (devModeEnabled !== true) {
    return null;
  }
  try {
    return parseFeatureFlagOverrides(JSON.parse(header));
  } catch {
    return parseFeatureFlagOverrides(null);
  }
}
