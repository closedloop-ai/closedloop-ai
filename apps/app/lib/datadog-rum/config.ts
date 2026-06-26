import type { RumEvent, RumInitConfiguration } from "@datadog/browser-rum";
import { env } from "@/env";
import { appEnvironment } from "@/lib/environment";

const DEFAULT_SESSION_SAMPLE_RATE = 100;
const SESSION_REPLAY_SAMPLE_RATE = 0;

export type DatadogRumConfig = Pick<
  RumInitConfiguration,
  | "applicationId"
  | "beforeSend"
  | "clientToken"
  | "defaultPrivacyLevel"
  | "env"
  | "service"
  | "sessionReplaySampleRate"
  | "sessionSampleRate"
  | "site"
  | "trackLongTasks"
  | "trackResources"
  | "trackUserInteractions"
  | "version"
>;

export function getDatadogRumConfig(): DatadogRumConfig | null {
  const applicationId = env.NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID;
  const clientToken = env.NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN;
  const site = env.NEXT_PUBLIC_DATADOG_RUM_SITE;

  if (!(applicationId && clientToken && site)) {
    return null;
  }

  return {
    applicationId,
    beforeSend: scrubDatadogRumEvent,
    clientToken,
    defaultPrivacyLevel: "mask-user-input",
    env: appEnvironment,
    service: "cl-app",
    sessionReplaySampleRate: SESSION_REPLAY_SAMPLE_RATE,
    sessionSampleRate: parseSampleRate(
      env.NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE,
      DEFAULT_SESSION_SAMPLE_RATE
    ),
    site,
    trackLongTasks: true,
    trackResources: true,
    trackUserInteractions: false,
    version: getDatadogRumVersion(),
  };
}

export function scrubDatadogRumEvent(event: RumEvent): boolean {
  if (event.type === "resource" && event.resource) {
    const parsed = tryParseUrl(event.resource.url);
    // Drop local desktop gateway resource telemetry; preserve normal app URLs.
    if (
      parsed &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      return false;
    }
  }

  return true;
}

export function getDatadogRumVersion(): string {
  return (
    process.env.NEXT_PUBLIC_DATADOG_RUM_BUILD_VERSION ??
    process.env.NEXT_PUBLIC_DATADOG_RUM_VERSION ??
    "unknown"
  );
}

function parseSampleRate(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(100, Math.max(0, parsed));
}

function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
