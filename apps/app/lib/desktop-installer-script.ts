const SHELL_VAR = "$";

export const DESKTOP_INSTALLER_SCRIPT = String.raw`#!/usr/bin/env bash
set -euo pipefail

APP_NAME="ClosedLoop"
BUNDLE_ID="ai.closedloop.desktop"
APP_PATH="/Applications/${SHELL_VAR}{APP_NAME}.app"
HANDOFF_DIR="${SHELL_VAR}{HOME}/Library/Application Support/ClosedLoop Desktop"
HANDOFF_FILE="${SHELL_VAR}{HANDOFF_DIR}/pending-onboarding.json"
NONINTERACTIVE="${SHELL_VAR}{CL_DESKTOP_NONINTERACTIVE:-0}"

fail_step() {
  local step="$1"
  local host="$2"
  local message="$3"
  printf 'ClosedLoop Desktop installer failed at %s (%s): %s\n' "$step" "$host" "$message" >&2
  printf 'Fix the issue, then rerun the onboarding command or use manual Desktop setup.\n' >&2
  exit 1
}

ensure_supported_platform() {
  if [ "$(uname -s)" != "Darwin" ]; then
    fail_step "platform_check" "local" "Automated setup is currently supported only on macOS."
  fi
}

is_retryable_log() {
  local log_file="$1"
  grep -Eiq '(Could not resolve host|Connection reset|TLS|SSL|timed out|timeout|HTTP[ /]5[0-9][0-9]|The Internet connection appears to be offline)' "$log_file"
}

is_permission_or_4xx_log() {
  local log_file="$1"
  grep -Eiq '(Permission denied|Operation not permitted|HTTP[ /]4[0-9][0-9])' "$log_file"
}

run_external_step() {
  local step="$1"
  local host="$2"
  shift 2
  local log_file
  log_file="$(mktemp)"
  if "$@" 2>"$log_file"; then
    rm -f "$log_file"
    return 0
  fi

  if is_permission_or_4xx_log "$log_file"; then
    local message
    message="$(tail -n 5 "$log_file")"
    rm -f "$log_file"
    fail_step "$step" "$host" "$message"
  fi

  if is_retryable_log "$log_file"; then
    sleep 3
    if "$@" 2>"$log_file"; then
      rm -f "$log_file"
      return 0
    fi
  fi

  local message
  message="$(tail -n 5 "$log_file")"
  rm -f "$log_file"
  fail_step "$step" "$host" "$message"
}

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    return 0
  fi

  printf 'Homebrew is not installed. Installing Homebrew once...\n'
  local install_script
  install_script="$(mktemp -t closedloop-homebrew-install.XXXXXX)"
  run_external_step "homebrew_download" "raw.githubusercontent.com" curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$install_script"
  run_external_step "homebrew_install" "raw.githubusercontent.com" /bin/bash "$install_script"
  rm -f "$install_script"

  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi

  if ! command -v brew >/dev/null 2>&1; then
    fail_step "homebrew_install" "raw.githubusercontent.com" "Homebrew is still unavailable after installation."
  fi
}

ensure_brew_package() {
  local package="$1"
  if brew list "$package" >/dev/null 2>&1; then
    printf '%s already installed; skipping.\n' "$package"
    return 0
  fi
  run_external_step "brew_install_${SHELL_VAR}{package}" "github.com/Homebrew" brew install "$package"
}

install_desktop_app() {
  if [ -z "${SHELL_VAR}{CL_DESKTOP_DOWNLOAD_URL:-}" ]; then
    fail_step "desktop_download" "closedloop-electron release" "CL_DESKTOP_DOWNLOAD_URL is required."
  fi

  local dmg_path mount_root app_source
  dmg_path="$(mktemp -t closedloop-desktop.XXXXXX).dmg"
  run_external_step "desktop_download" "$(printf '%s' "$CL_DESKTOP_DOWNLOAD_URL" | sed -E 's#^[a-z]+://([^/]+).*#\1#')" curl -fL "$CL_DESKTOP_DOWNLOAD_URL" -o "$dmg_path"

  mount_root="$(mktemp -d)"
  run_external_step "desktop_mount" "local_dmg" hdiutil attach "$dmg_path" -mountpoint "$mount_root" -nobrowse -quiet
  app_source="$(find "$mount_root" -maxdepth 2 -name "${SHELL_VAR}{APP_NAME}.app" -type d | head -n 1)"
  if [ -z "$app_source" ]; then
    hdiutil detach "$mount_root" -quiet || true
    fail_step "desktop_install" "local_dmg" "ClosedLoop.app was not found in the downloaded DMG."
  fi

  if [ -d "$APP_PATH" ]; then
    printf 'ClosedLoop Desktop already installed; replacing with the latest downloaded build.\n'
    local remove_err_file
    remove_err_file="$(mktemp)"
    if ! rm -rf "$APP_PATH" 2>"$remove_err_file"; then
      local message
      message="$(cat "$remove_err_file")"
      rm -f "$remove_err_file"
      hdiutil detach "$mount_root" -quiet || true
      fail_step "desktop_install" "/Applications" "$message"
    fi
    rm -f "$remove_err_file"
  fi

  local copy_err_file
  copy_err_file="$(mktemp)"
  if ! cp -R "$app_source" /Applications/ 2>"$copy_err_file"; then
    local message
    message="$(cat "$copy_err_file")"
    rm -f "$copy_err_file"
    hdiutil detach "$mount_root" -quiet || true
    fail_step "desktop_install" "/Applications" "$message"
  fi
  rm -f "$copy_err_file"

  hdiutil detach "$mount_root" -quiet || true
  rm -f "$dmg_path"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

reject_json_control_chars() {
  local name="$1"
  local value="$2"
  if [[ "$value" =~ [[:cntrl:]] ]]; then
    fail_step "handoff_write" "local" "$name cannot contain control characters."
  fi
}

write_handoff_file() {
  if [ -z "${SHELL_VAR}{CL_ONBOARDING_ATTEMPT_ID:-}" ] || [ -z "${SHELL_VAR}{CL_WEB_APP_ORIGIN:-}" ]; then
    fail_step "handoff_write" "local" "CL_ONBOARDING_ATTEMPT_ID and CL_WEB_APP_ORIGIN are required."
  fi
  reject_json_control_chars "CL_ONBOARDING_ATTEMPT_ID" "$CL_ONBOARDING_ATTEMPT_ID"
  reject_json_control_chars "CL_WEB_APP_ORIGIN" "$CL_WEB_APP_ORIGIN"

  mkdir -p "$HANDOFF_DIR"
  local created_at attempt origin sandbox
  created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  attempt="$(json_escape "$CL_ONBOARDING_ATTEMPT_ID")"
  origin="$(json_escape "$CL_WEB_APP_ORIGIN")"
  if [ -n "${SHELL_VAR}{CL_SANDBOX_BASE_DIRECTORY:-}" ]; then
    reject_json_control_chars "CL_SANDBOX_BASE_DIRECTORY" "$CL_SANDBOX_BASE_DIRECTORY"
    sandbox="$(json_escape "$CL_SANDBOX_BASE_DIRECTORY")"
    printf '{"onboardingAttemptId":"%s","webAppOrigin":"%s","sandboxBaseDirectory":"%s","createdAt":"%s"}\n' "$attempt" "$origin" "$sandbox" "$created_at" > "$HANDOFF_FILE"
  else
    printf '{"onboardingAttemptId":"%s","webAppOrigin":"%s","createdAt":"%s"}\n' "$attempt" "$origin" "$created_at" > "$HANDOFF_FILE"
  fi
  chmod 600 "$HANDOFF_FILE"
}

dispatch_handoff() {
  if open -b "$BUNDLE_ID" "$HANDOFF_FILE"; then
    printf 'Opened ClosedLoop Desktop with the onboarding handoff.\n'
    return 0
  fi

  printf 'ClosedLoop Desktop was installed, but automatic file-open dispatch failed.\n' >&2
  printf 'Open ClosedLoop Desktop manually; it will resume onboarding from:\n%s\n' "$HANDOFF_FILE" >&2
  return 0
}

main() {
  ensure_supported_platform
  ensure_homebrew
  ensure_brew_package git
  ensure_brew_package gh
  install_desktop_app

  if [ "$NONINTERACTIVE" = "1" ] || { [ ! -t 0 ] && [ ! -t 1 ]; }; then
    printf 'Non-interactive mode complete. No onboarding handoff was created.\n'
    printf 'Open ClosedLoop Desktop and complete manual setup.\n'
    return 0
  fi

  write_handoff_file
  dispatch_handoff
}

main "$@"
`;
