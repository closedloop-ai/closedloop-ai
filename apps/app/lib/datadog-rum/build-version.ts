type DatadogRumBuildVersionEnv = Record<string, string | undefined>;

export function resolveDatadogRumBuildVersion(
  env: DatadogRumBuildVersionEnv
): string {
  if (env.VERCEL) {
    return (
      env.VERCEL_GIT_COMMIT_SHA ??
      env.NEXT_PUBLIC_DATADOG_RUM_VERSION ??
      "unknown"
    );
  }

  return (
    env.NEXT_PUBLIC_DATADOG_RUM_VERSION ??
    env.VERCEL_GIT_COMMIT_SHA ??
    "unknown"
  );
}
