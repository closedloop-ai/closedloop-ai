import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import { asRecord, stringField } from "./api-response-utils.js";

/**
 * HTTP client for the unauthenticated device-onboarding endpoints
 * (`/desktop/device-onboarding/{start,poll}`) used by first-party desktop
 * sign-in (FEA-1514 / FEA-2219).
 *
 * Unlike the session endpoints these require NO proof-of-possession: `start`
 * registers the device and returns the browser verification URL + a polling
 * secret; `poll` reports approval progress. Once `poll` returns `approved`, the
 * caller exchanges the SAME `deviceSessionId` + `deviceSessionSecret` for
 * session tokens via {@link ./desktop-session-client}'s exchange — which IS
 * PoP-signed and binds the credentials to this device's key.
 *
 * Both routes return their body at the top level (no `{ success, data }`
 * envelope) and signal failures with a top-level `{ code, retryable }`, so the
 * parsing here mirrors {@link ./desktop-session-client} minus the signature.
 */

const START_PATH = "/desktop/device-onboarding/start";
const POLL_PATH = "/desktop/device-onboarding/poll";

/** Protocol version the backend pins device-onboarding `start` to. */
const DESKTOP_SECURITY_UPGRADE_PROTOCOL_VERSION = 1;

/** Fallback when the server omits or invalidly reports a poll interval. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export type DeviceOnboardingStartInput = {
  apiOrigin: string;
  /** Origin of the web app whose approval page the browser will open. */
  webAppOrigin: string;
  gatewayId: string;
  /** Ed25519 SPKI PEM the backend binds the eventual session credentials to. */
  gatewayPublicKeyPem: string;
  machineName: string;
  platform: string;
  desktopVersion: string;
  fetchImpl?: typeof fetch;
};

/** Top-level success body of `/desktop/device-onboarding/start`. */
export type DeviceOnboardingStart = {
  deviceSessionId: string;
  /** Plaintext polling secret; held in memory only, never persisted. */
  deviceSessionSecret: string;
  /** Short human-facing code shown on the approval page. */
  userCode: string;
  /** Browser URL the user approves the device at (allowlist-checked by caller). */
  verificationUrl: string;
  expiresAt: string;
  pollIntervalSeconds: number;
};

export type DeviceOnboardingPollInput = {
  apiOrigin: string;
  deviceSessionId: string;
  deviceSessionSecret: string;
  fetchImpl?: typeof fetch;
};

export type DeviceOnboardingApproved = {
  status: typeof DesktopDeviceSessionStatus.Approved;
  onboardingAttemptId: string;
  webAppOrigin: string;
  expiresAt: string;
};

/**
 * Top-level success body of `/desktop/device-onboarding/poll`. The discriminant
 * reuses the canonical {@link DesktopDeviceSessionStatus} wire contract shared
 * with the API service and the web approval UI.
 */
export type DeviceOnboardingPoll =
  | { status: typeof DesktopDeviceSessionStatus.Pending }
  | DeviceOnboardingApproved
  | { status: typeof DesktopDeviceSessionStatus.Denied }
  | { status: typeof DesktopDeviceSessionStatus.Expired };

export type DeviceOnboardingError =
  /** Malformed request body (400). */
  | "bad_request"
  /** Unknown device session or secret mismatch (401). */
  | "invalid"
  /** Too many pending sessions for this gateway/IP (429). */
  | "rate_limited"
  /** Transient server-side failure (503). */
  | "unavailable"
  /** Network/transport failure before a response. */
  | "network";

export type DeviceOnboardingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DeviceOnboardingError; retryable: boolean };

/** Register the device and obtain the browser verification URL + poll secret. */
export function startDeviceOnboarding(
  input: DeviceOnboardingStartInput
): Promise<DeviceOnboardingResult<DeviceOnboardingStart>> {
  return postDeviceOnboarding({
    apiOrigin: input.apiOrigin,
    path: START_PATH,
    body: {
      webAppOrigin: input.webAppOrigin,
      gatewayId: input.gatewayId,
      gatewayPublicKeyPem: input.gatewayPublicKeyPem,
      machineName: input.machineName,
      platform: input.platform,
      desktopVersion: input.desktopVersion,
      desktopSecurityUpgradeProtocolVersion:
        DESKTOP_SECURITY_UPGRADE_PROTOCOL_VERSION,
    },
    fetchImpl: input.fetchImpl,
    parse: parseStart,
  });
}

/** Poll a started device session for the user's browser approval decision. */
export function pollDeviceOnboarding(
  input: DeviceOnboardingPollInput
): Promise<DeviceOnboardingResult<DeviceOnboardingPoll>> {
  return postDeviceOnboarding({
    apiOrigin: input.apiOrigin,
    path: POLL_PATH,
    body: {
      deviceSessionId: input.deviceSessionId,
      deviceSessionSecret: input.deviceSessionSecret,
    },
    fetchImpl: input.fetchImpl,
    parse: parsePoll,
  });
}

type PostDeviceOnboardingInput<T> = {
  apiOrigin: string;
  path: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  parse: (body: unknown) => T | null;
};

async function postDeviceOnboarding<T>(
  input: PostDeviceOnboardingInput<T>
): Promise<DeviceOnboardingResult<T>> {
  let url: URL;
  try {
    url = new URL(input.path, input.apiOrigin);
  } catch {
    return { ok: false, error: "network", retryable: false };
  }

  const fetchFn = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.body),
    });
  } catch {
    return { ok: false, error: "network", retryable: true };
  }

  let parsedBody: unknown = null;
  try {
    parsedBody = await response.json();
  } catch {
    parsedBody = null;
  }

  if (!response.ok) {
    return { ok: false, ...mapErrorResponse(response.status, parsedBody) };
  }

  const value = input.parse(parsedBody);
  if (value === null) {
    return { ok: false, error: "invalid", retryable: false };
  }
  return { ok: true, value };
}

function mapErrorResponse(
  status: number,
  body: unknown
): { error: DeviceOnboardingError; retryable: boolean } {
  const record = asRecord(body);
  const contractRetryable =
    typeof record.retryable === "boolean" ? record.retryable : undefined;

  switch (status) {
    case 400:
      return { error: "bad_request", retryable: contractRetryable ?? false };
    case 401:
      return { error: "invalid", retryable: contractRetryable ?? false };
    case 429:
      return { error: "rate_limited", retryable: contractRetryable ?? true };
    // 408 Request Timeout and 503 are transient; keep polling/retrying.
    case 408:
    case 503:
      return { error: "unavailable", retryable: contractRetryable ?? true };
    default:
      return {
        error: "unavailable",
        retryable: contractRetryable ?? status >= 500,
      };
  }
}

function parseStart(body: unknown): DeviceOnboardingStart | null {
  const record = asRecord(body);
  const deviceSessionId = stringField(record.deviceSessionId);
  const deviceSessionSecret = stringField(record.deviceSessionSecret);
  const verificationUrl = stringField(record.verificationUrl);
  const expiresAt = stringField(record.expiresAt);
  // userCode is informational (display only), so it is not required to proceed.
  if (
    !(deviceSessionId && deviceSessionSecret && verificationUrl && expiresAt)
  ) {
    return null;
  }
  const pollIntervalSeconds =
    typeof record.pollIntervalSeconds === "number" &&
    record.pollIntervalSeconds > 0
      ? record.pollIntervalSeconds
      : DEFAULT_POLL_INTERVAL_SECONDS;
  return {
    deviceSessionId,
    deviceSessionSecret,
    userCode: stringField(record.userCode),
    verificationUrl,
    expiresAt,
    pollIntervalSeconds,
  };
}

function parsePoll(body: unknown): DeviceOnboardingPoll | null {
  const record = asRecord(body);
  switch (record.status) {
    case DesktopDeviceSessionStatus.Pending:
      return { status: DesktopDeviceSessionStatus.Pending };
    case DesktopDeviceSessionStatus.Denied:
      return { status: DesktopDeviceSessionStatus.Denied };
    case DesktopDeviceSessionStatus.Expired:
      return { status: DesktopDeviceSessionStatus.Expired };
    case DesktopDeviceSessionStatus.Approved: {
      const onboardingAttemptId = stringField(record.onboardingAttemptId);
      const webAppOrigin = stringField(record.webAppOrigin);
      const expiresAt = stringField(record.expiresAt);
      if (!(onboardingAttemptId && webAppOrigin && expiresAt)) {
        return null;
      }
      return {
        status: DesktopDeviceSessionStatus.Approved,
        onboardingAttemptId,
        webAppOrigin,
        expiresAt,
      };
    }
    default:
      return null;
  }
}
