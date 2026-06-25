import type { ApiKeyProvenance } from "./api-key-store.js";
import {
  type DesktopPopHeaders,
  type DesktopPopSigner,
  type DesktopPopSigningRequest,
  getDesktopPopUnavailableReason,
} from "./desktop-pop.js";
import type { DesktopPopUnavailableReporter } from "./desktop-pop-sign-utils.js";
import { SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR } from "./signed-loop-launch-error.js";

export type FetchLoopExecutionCredentialsOptions = {
  apiOrigin: string;
  apiKey: string;
  apiKeyProvenance: ApiKeyProvenance;
  computeTargetId: string;
  loopId: string;
  commandId: string;
  signDesktopRequest?: DesktopPopSigner;
  onDesktopPopUnavailable?: DesktopPopUnavailableReporter;
};

type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

const LOOP_EXECUTION_CREDENTIALS_SURFACE = "loop_execution_credentials";

async function buildRequiredManagedDesktopPopHeaders(input: {
  apiKeyProvenance: ApiKeyProvenance;
  signDesktopRequest?: DesktopPopSigner;
  request: DesktopPopSigningRequest;
  onUnavailable?: DesktopPopUnavailableReporter;
}): Promise<DesktopPopHeaders> {
  if (input.apiKeyProvenance !== "DESKTOP_MANAGED") {
    throw new Error(SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR);
  }
  if (!input.signDesktopRequest) {
    input.onUnavailable?.(LOOP_EXECUTION_CREDENTIALS_SURFACE, "missing_signer");
    throw new Error(SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR);
  }

  let reason = "sign_failed_or_null";
  try {
    const headers = await input.signDesktopRequest(input.request);
    if (headers) {
      return headers;
    }
  } catch (error) {
    reason = getDesktopPopUnavailableReason(error);
  }

  input.onUnavailable?.(LOOP_EXECUTION_CREDENTIALS_SURFACE, reason);
  throw new Error(SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR);
}

/**
 * Fetches the one-shot Desktop loop execution body after command signature
 * verification. This route requires Desktop-managed PoP headers; request-time
 * signing failures are hard failures so Desktop does not fall back to bearer-only.
 */
export async function fetchLoopExecutionCredentials(
  options: FetchLoopExecutionCredentialsOptions
): Promise<Record<string, unknown>> {
  const url = new URL(
    `/compute-targets/${encodeURIComponent(options.computeTargetId)}/loops/${encodeURIComponent(options.loopId)}/execution-credentials`,
    options.apiOrigin
  );
  const popHeaders = await buildRequiredManagedDesktopPopHeaders({
    apiKeyProvenance: options.apiKeyProvenance,
    signDesktopRequest: options.signDesktopRequest,
    request: {
      method: "POST",
      pathname: url.pathname,
    },
    onUnavailable: options.onDesktopPopUnavailable,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      ...popHeaders,
    },
    body: JSON.stringify({ commandId: options.commandId }),
  });
  const payload = (await response.json().catch(() => null)) as ApiResult<
    Record<string, unknown>
  > | null;
  if (!(response.ok && payload?.success)) {
    throw new Error(
      payload && !payload.success
        ? payload.error
        : "Failed to fetch loop execution credentials"
    );
  }
  return payload.data;
}
