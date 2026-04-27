export type DesktopOnboardingCommandInput = {
  onboardingAttemptId: string;
  webAppOrigin: string;
  desktopDownloadUrl: string;
  installerScriptUrl: string;
  sandboxBaseDirectory?: string;
};

/**
 * Builds the copyable terminal command for the web-app-first Desktop onboarding flow.
 */
export function buildDesktopOnboardingCommand(
  input: DesktopOnboardingCommandInput
): string {
  const assignments = [
    ["CL_ONBOARDING_ATTEMPT_ID", input.onboardingAttemptId],
    ["CL_WEB_APP_ORIGIN", input.webAppOrigin],
    ["CL_DESKTOP_DOWNLOAD_URL", input.desktopDownloadUrl],
  ];
  if (input.sandboxBaseDirectory?.trim()) {
    assignments.push([
      "CL_SANDBOX_BASE_DIRECTORY",
      input.sandboxBaseDirectory.trim(),
    ]);
  }

  return `${assignments
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ")} /bin/bash -c "$(curl -fsSL ${shellQuote(
    input.installerScriptUrl
  )})"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
