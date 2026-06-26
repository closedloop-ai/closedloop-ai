const ORIGINAL_ENV = { ...process.env };

const RUM_ENV_KEYS = [
  "NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID",
  "NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN",
  "NEXT_PUBLIC_DATADOG_RUM_BUILD_VERSION",
  "NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE",
  "NEXT_PUBLIC_DATADOG_RUM_SITE",
  "NEXT_PUBLIC_DATADOG_RUM_VERSION",
  "VERCEL_GIT_COMMIT_SHA",
] as const;

export function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

export function clearRumEnv() {
  for (const key of RUM_ENV_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
}
