import {
  DesktopSignInAnalyticsPath,
  type DesktopSignInAnalyticsRegistration,
} from "@repo/api/src/types/desktop-sign-in-analytics.ts";
import type { SessionFetchOptions } from "../util/api-response-utils.js";

/** ISS-11127: no credentials, no retries, no logging of either correlation value. */
export async function registerDesktopSignInAnalytics(
  options: Pick<SessionFetchOptions, "fetch" | "getApiOrigin">,
  registration: DesktopSignInAnalyticsRegistration
): Promise<void> {
  try {
    await (options.fetch ?? fetch)(
      new URL(DesktopSignInAnalyticsPath.Register, options.getApiOrigin()),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registration),
        signal: AbortSignal.timeout(10_000),
      }
    );
  } catch {
    /* Best effort; errors can contain correlation values. */
  }
}
