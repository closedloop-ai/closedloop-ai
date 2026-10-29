import type {
  CloudApiFetchRequest,
  CloudApiFetchResult,
} from "../../shared/cloud-api-fetch-contract.js";
import type { DesktopAccountAdmission } from "../session/desktop-account-admission.js";

export type AdmittedCloudApiFetch = {
  request: CloudApiFetchRequest;
  method: string;
  isNonGet: boolean;
  accountAdmission: DesktopAccountAdmission | null;
  token: string;
  url: URL;
};

type CloudApiIdentity = {
  userId: string;
  organizationId: string;
};

export type CloudApiFetchExecutionDeps = {
  fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
  getIdentity: () => CloudApiIdentity | null;
  onUnauthorized?: (rejectedToken: string) => void;
  assertAdmissionCurrent: (captured: DesktopAccountAdmission | null) => void;
  buildUpstreamHeaders: (
    request: CloudApiFetchRequest,
    token: string,
    identity: CloudApiIdentity | null
  ) => Headers;
  resolveTimeoutMs: (
    requested: number | undefined,
    isNonGet: boolean
  ) => number;
  rewriteDocumentAssets: (
    admission: DesktopAccountAdmission | null,
    responseOk: boolean,
    pathname: string,
    bodyText: string
  ) => string;
  transportError: (error: unknown, message: string) => CloudApiFetchResult;
};

/** Executes one admitted cloud request through the authenticated online transport. */
export async function executeAdmittedCloudApiFetch(
  deps: CloudApiFetchExecutionDeps,
  admitted: AdmittedCloudApiFetch
): Promise<CloudApiFetchResult> {
  const { request, method, isNonGet, accountAdmission, token, url } = admitted;
  const doFetch = deps.fetchImpl ?? fetch;
  deps.assertAdmissionCurrent(accountAdmission);
  let response: Response;
  try {
    deps.assertAdmissionCurrent(accountAdmission);
    response = await doFetch(url, {
      method,
      headers: deps.buildUpstreamHeaders(
        request,
        token,
        accountAdmission ?? deps.getIdentity()
      ),
      ...(isNonGet && request.body !== undefined ? { body: request.body } : {}),
      signal: AbortSignal.timeout(
        deps.resolveTimeoutMs(request.timeoutMs, isNonGet)
      ),
    });
  } catch (error) {
    deps.assertAdmissionCurrent(accountAdmission);
    return deps.transportError(error, "cloud-api-fetch: fetch failed");
  }

  deps.assertAdmissionCurrent(accountAdmission);
  if (response.status === 401) {
    deps.onUnauthorized?.(token);
  }
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    deps.assertAdmissionCurrent(accountAdmission);
    return deps.transportError(
      error,
      "cloud-api-fetch: reading the response body failed"
    );
  }

  deps.assertAdmissionCurrent(accountAdmission);
  try {
    bodyText = deps.rewriteDocumentAssets(
      accountAdmission,
      response.ok,
      url.pathname,
      bodyText
    );
  } catch (error) {
    return deps.transportError(
      error,
      "cloud-api-fetch: reading the response body failed"
    );
  }
  return {
    kind: "response",
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    bodyText,
  };
}
