import { describe, expect, it } from "vitest";
import { DESKTOP_INSTALLER_SCRIPT } from "../desktop-installer-script";
import { buildDesktopOnboardingCommand } from "../desktop-managed-onboarding";

describe("buildDesktopOnboardingCommand", () => {
  it("includes only installer handoff values and excludes trusted origins/secrets", () => {
    const command = buildDesktopOnboardingCommand({
      onboardingAttemptId: "attempt-123",
      webAppOrigin: "https://app.closedloop.ai",
      desktopDownloadUrl: "https://github.com/closedloop-ai/release.dmg",
      installerScriptUrl: "https://app.closedloop.ai/api/desktop/install.sh",
      sandboxBaseDirectory: "~/Source",
    });

    expect(command).toContain("CL_ONBOARDING_ATTEMPT_ID='attempt-123'");
    expect(command).toContain("CL_WEB_APP_ORIGIN='https://app.closedloop.ai'");
    expect(command).toContain(
      "CL_DESKTOP_DOWNLOAD_URL='https://github.com/closedloop-ai/release.dmg'"
    );
    expect(command).toContain("CL_SANDBOX_BASE_DIRECTORY='~/Source'");
    expect(command).toContain("/api/desktop/install.sh");
    expect(command).toContain("curl -fsSL");
    expect(command).toContain('-o "$install_script"');
    expect(command).toContain('/bin/bash "$install_script"');
    expect(command).not.toContain("$(curl");
    expect(command).not.toContain("api.closedloop.ai");
    expect(command).not.toContain("relay.closedloop.ai");
    expect(command).not.toContain("sk_live_");
  });
});

describe("DESKTOP_INSTALLER_SCRIPT", () => {
  it("fails fast on unsupported operating systems before installer side effects", () => {
    const mainBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("main()")
    );
    const platformCheckIndex = mainBody.indexOf("ensure_supported_platform");
    const homebrewIndex = mainBody.indexOf("ensure_homebrew");

    expect(DESKTOP_INSTALLER_SCRIPT).toContain('[ "$(uname -s)" != "Darwin" ]');
    expect(platformCheckIndex).toBeGreaterThanOrEqual(0);
    expect(homebrewIndex).toBeGreaterThan(platformCheckIndex);
  });

  it("writes the exact handoff file contract with 0600 permissions", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("HANDOFF_DIR=");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "Library/Application Support/ClosedLoop Desktop"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("HANDOFF_FILE=");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("pending-onboarding.json");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      '{"onboardingAttemptId":"%s","webAppOrigin":"%s","sandboxBaseDirectory":"%s","createdAt":"%s"}'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain('chmod 600 "$HANDOFF_FILE"');
  });

  it("does not create a handoff in non-interactive mode", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "Non-interactive mode complete. No onboarding handoff was created."
    );
  });

  it("uses one retry only for retryable external-operation failures", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("sleep 3");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("is_retryable_log");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("is_permission_or_4xx_log");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("HTTP[ /]5");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("HTTP[ /]4");
  });

  it("wraps the Homebrew installer download before running it", () => {
    const homebrewBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_homebrew()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("ensure_brew_package()")
    );
    const downloadIndex = homebrewBody.indexOf(
      'run_external_step "homebrew_download" "raw.githubusercontent.com" curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$install_script"'
    );
    const installIndex = homebrewBody.indexOf(
      'run_external_step "homebrew_install" "raw.githubusercontent.com" /bin/bash "$install_script"'
    );

    expect(downloadIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThan(downloadIndex);
    expect(homebrewBody).not.toContain(
      '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    );
  });

  it("replaces an existing Desktop app with the downloaded build", () => {
    const installBody = DESKTOP_INSTALLER_SCRIPT.slice(
      DESKTOP_INSTALLER_SCRIPT.indexOf("install_desktop_app()"),
      DESKTOP_INSTALLER_SCRIPT.indexOf("json_escape()")
    );
    const downloadIndex = installBody.indexOf(
      'run_external_step "desktop_download"'
    );
    const sourceCheckIndex = installBody.indexOf('if [ -z "$app_source" ]');
    const replaceIndex = installBody.indexOf('rm -rf "$APP_PATH"');
    const copyIndex = installBody.indexOf('cp -R "$app_source" /Applications/');

    expect(installBody).not.toContain(
      "ClosedLoop Desktop already installed; skipping Desktop install."
    );
    expect(downloadIndex).toBeGreaterThanOrEqual(0);
    expect(sourceCheckIndex).toBeGreaterThan(downloadIndex);
    expect(replaceIndex).toBeGreaterThan(sourceCheckIndex);
    expect(copyIndex).toBeGreaterThan(replaceIndex);
  });

  it("uses per-run temp files for Desktop install error capture", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain('remove_err_file="$(mktemp)"');
    expect(DESKTOP_INSTALLER_SCRIPT).toContain('copy_err_file="$(mktemp)"');
    expect(DESKTOP_INSTALLER_SCRIPT).not.toContain(
      "/tmp/closedloop-desktop-remove.err"
    );
    expect(DESKTOP_INSTALLER_SCRIPT).not.toContain(
      "/tmp/closedloop-desktop-copy.err"
    );
  });

  it("rejects handoff values containing JSON control characters", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain("reject_json_control_chars()");
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'reject_json_control_chars "CL_ONBOARDING_ATTEMPT_ID"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'reject_json_control_chars "CL_WEB_APP_ORIGIN"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'reject_json_control_chars "CL_SANDBOX_BASE_DIRECTORY"'
    );
  });

  it("dispatches through OS file-open and leaves manual instructions on dispatch failure", () => {
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      'open -b "$BUNDLE_ID" "$HANDOFF_FILE"'
    );
    expect(DESKTOP_INSTALLER_SCRIPT).toContain(
      "automatic file-open dispatch failed"
    );
  });
});
