const SHELL_VAR = "$";

export const DESKTOP_INSTALLER_SCRIPT = String.raw`#!/usr/bin/env bash
set -euo pipefail

APP_NAME="ClosedLoop"
BUNDLE_ID="ai.closedloop.desktop"
APP_PATH="/Applications/${SHELL_VAR}{APP_NAME}.app"
HANDOFF_DIR="${SHELL_VAR}{HOME}/Library/Application Support/ClosedLoop Desktop"
HANDOFF_FILE="${SHELL_VAR}{HANDOFF_DIR}/pending-onboarding.json"
NONINTERACTIVE="${SHELL_VAR}{CL_DESKTOP_NONINTERACTIVE:-0}"
COMMAND_CHECK_TIMEOUT_SECONDS=15
REQUIRED_CLOSEDLOOP_PLUGINS=(code platform judges code-review self-learning)
PREREQUISITE_FAILURES=()
FAILED_PREREQUISITE_KEYS=()
# Required prerequisite checks run in soft-fail mode so the script can report
# every missing dependency in one pass. Fatal steps use the normal installer
# failure copy and exit immediately.
PREREQUISITE_CHECK_MODE="${SHELL_VAR}{PREREQUISITE_CHECK_MODE:-0}"
# These install paths live at script scope because the EXIT trap can run after
# install_desktop_app has aborted; local variables would no longer be visible to
# the cleanup function on those error exits.
DESKTOP_INSTALL_DMG_PATH=""
DESKTOP_INSTALL_MOUNT_ROOT=""
DESKTOP_INSTALL_STAGING_ROOT=""
DESKTOP_INSTALL_BACKUP_APP=""
# The handoff must contain the exact workspace path that passed the filesystem
# checks, not the raw user spelling that may include ~, .., or trailing slashes.
VALIDATED_SANDBOX_BASE_DIRECTORY=""

fail_step() {
  local step="$1"
  local host="$2"
  local message="$3"
  if [ "$PREREQUISITE_CHECK_MODE" = "1" ]; then
    printf 'ClosedLoop Desktop prerequisite check failed at %s (%s): %s\n' "$step" "$host" "$message" >&2
  else
    printf 'ClosedLoop Desktop installer failed at %s (%s): %s\n' "$step" "$host" "$message" >&2
    printf 'Fix the issue, then rerun the onboarding command or use manual Desktop setup.\n' >&2
  fi
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

prepend_path_dir() {
  local path_dir="$1"
  if [ -z "$path_dir" ]; then
    return 0
  fi
  case ":${SHELL_VAR}{PATH:-}:" in
    *":$path_dir:"*) ;;
    *) export PATH="$path_dir${SHELL_VAR}{PATH:+:$PATH}" ;;
  esac
}

append_path_dir() {
  local path_dir="$1"
  if [ -z "$path_dir" ]; then
    return 0
  fi
  case ":${SHELL_VAR}{PATH:-}:" in
    *":$path_dir:"*) ;;
    *) export PATH="${SHELL_VAR}{PATH:+$PATH:}$path_dir" ;;
  esac
}

seed_base_path() {
  append_path_dir /usr/bin
  append_path_dir /bin
  append_path_dir /usr/sbin
  append_path_dir /sbin
  append_path_dir /usr/local/bin
  append_path_dir /opt/homebrew/bin
}

eval_brew_shellenv() {
  local brew_cmd="$1"
  local shellenv
  if shellenv="$(SHELL=/bin/bash "$brew_cmd" shellenv bash 2>/dev/null)" || shellenv="$(SHELL=/bin/bash "$brew_cmd" shellenv 2>/dev/null)"; then
    eval "$shellenv"
    return 0
  fi
  return 1
}

refresh_npm_global_path() {
  if ! command -v npm >/dev/null 2>&1; then
    return 0
  fi

  local npm_prefix
  npm_prefix="$(run_with_timeout "$COMMAND_CHECK_TIMEOUT_SECONDS" npm prefix -g 2>/dev/null || run_with_timeout "$COMMAND_CHECK_TIMEOUT_SECONDS" npm config get prefix 2>/dev/null || true)"
  if [ -n "$npm_prefix" ] && [ "$npm_prefix" != "undefined" ] && [ -d "$npm_prefix/bin" ]; then
    prepend_path_dir "$npm_prefix/bin"
  fi
}

refresh_installer_path() {
  # Newly installed tools can land in Homebrew libexec paths or npm's global
  # bin directory. Refreshing before and after prerequisite checks lets later
  # checks see tools installed by earlier checks in the same shell.
  if command -v brew >/dev/null 2>&1; then
    eval_brew_shellenv brew || true
  elif [ -x /opt/homebrew/bin/brew ]; then
    eval_brew_shellenv /opt/homebrew/bin/brew || true
  elif [ -x /usr/local/bin/brew ]; then
    eval_brew_shellenv /usr/local/bin/brew || true
  fi

  if command -v brew >/dev/null 2>&1; then
    local python_prefix
    python_prefix="$(brew --prefix python@3.13 2>/dev/null || true)"
    if [ -n "$python_prefix" ] && [ -d "$python_prefix/libexec/bin" ]; then
      prepend_path_dir "$python_prefix/libexec/bin"
    fi
  fi

  refresh_npm_global_path
}

ensure_homebrew() {
  refresh_installer_path
  if command -v brew >/dev/null 2>&1; then
    return 0
  fi

  if [ -x /opt/homebrew/bin/brew ]; then
    eval_brew_shellenv /opt/homebrew/bin/brew
    if command -v brew >/dev/null 2>&1; then
      return 0
    fi
  fi
  if [ -x /usr/local/bin/brew ]; then
    eval_brew_shellenv /usr/local/bin/brew
    if command -v brew >/dev/null 2>&1; then
      return 0
    fi
  fi

  printf 'Homebrew is not installed. Installing Homebrew once...\n'
  local install_script=""
  install_script="$(mktemp -t closedloop-homebrew-install.XXXXXX)"
  trap 'rm -f "$install_script"' EXIT
  run_external_step "homebrew_download" "raw.githubusercontent.com" curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$install_script"
  run_external_step "homebrew_install" "raw.githubusercontent.com" /bin/bash "$install_script"
  rm -f "$install_script"
  trap - EXIT

  if [ -x /opt/homebrew/bin/brew ]; then
    eval_brew_shellenv /opt/homebrew/bin/brew
  elif [ -x /usr/local/bin/brew ]; then
    eval_brew_shellenv /usr/local/bin/brew
  fi

  refresh_installer_path
  if ! command -v brew >/dev/null 2>&1; then
    fail_step "homebrew_install" "raw.githubusercontent.com" "Homebrew is still unavailable after installation."
  fi
}

record_prerequisite_failure() {
  local key="$1"
  local label="$2"
  local detail="${SHELL_VAR}{3:-}"
  FAILED_PREREQUISITE_KEYS+=("$key")
  if [ -n "$detail" ]; then
    PREREQUISITE_FAILURES+=("$label - $detail")
  else
    PREREQUISITE_FAILURES+=("$label")
  fi
}

has_failed_prerequisite() {
  local key="$1"
  if [ "${SHELL_VAR}{#FAILED_PREREQUISITE_KEYS[@]}" -eq 0 ]; then
    return 1
  fi
  local failed_key
  for failed_key in "${SHELL_VAR}{FAILED_PREREQUISITE_KEYS[@]}"; do
    if [ "$failed_key" = "$key" ]; then
      return 0
    fi
  done
  return 1
}

run_required_prerequisite() {
  local key="$1"
  local label="$2"
  shift 2
  printf '\nChecking %s...\n' "$label"

  refresh_installer_path
  set +e
  # Run the check in a subshell so a prerequisite can use fail_step without
  # aborting the whole installer. The parent records the failure, refreshes PATH
  # after successes, and continues checking the remaining prerequisites.
  ( set -euo pipefail; PREREQUISITE_CHECK_MODE=1; refresh_installer_path; "$@" )
  local status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    refresh_installer_path
    return 0
  fi

  record_prerequisite_failure "$key" "$label"
  printf 'Continuing to check remaining required prerequisites.\n' >&2
  return 0
}

finish_required_prerequisites() {
  if [ "${SHELL_VAR}{#PREREQUISITE_FAILURES[@]}" -eq 0 ]; then
    return 0
  fi

  printf '\nClosedLoop Desktop automated setup could not finish because %s required prerequisite(s) failed:\n' "${SHELL_VAR}{#PREREQUISITE_FAILURES[@]}" >&2
  local failure
  for failure in "${SHELL_VAR}{PREREQUISITE_FAILURES[@]}"; do
    printf '  - %s\n' "$failure" >&2
  done
  printf 'Fix all listed issues, then rerun the onboarding command or use manual Desktop setup.\n' >&2
  exit 1
}

ensure_usable_command() {
  local binary="$1"
  shift
  if command -v "$binary" >/dev/null 2>&1 && run_with_timeout "$COMMAND_CHECK_TIMEOUT_SECONDS" "$@" >/dev/null 2>&1; then
    printf '%s already available; skipping install.\n' "$binary"
    return 0
  fi
  return 1
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift

  if [ -x /usr/bin/perl ]; then
    /usr/bin/perl -e 'my $timeout = shift @ARGV; alarm $timeout; exec @ARGV; exit 127;' "$timeout_seconds" "$@"
    return $?
  fi

  "$@"
}

ensure_brew_package() {
  local package="$1"
  local binary="${SHELL_VAR}{2:-$package}"
  shift || true
  shift || true
  local check_args=("$@")
  if [ "${SHELL_VAR}{#check_args[@]}" -eq 0 ]; then
    check_args=("--version")
  fi

  if ensure_usable_command "$binary" "$binary" "${SHELL_VAR}{check_args[@]}"; then
    return 0
  fi

  ensure_homebrew
  if brew list "$package" >/dev/null 2>&1; then
    printf '%s already installed via Homebrew; checking %s.\n' "$package" "$binary"
    if ensure_usable_command "$binary" "$binary" "${SHELL_VAR}{check_args[@]}"; then
      return 0
    fi
    fail_step "brew_install_${SHELL_VAR}{package}" "github.com/Homebrew" "$package is installed, but $binary is not usable. Link the package or fix PATH, then rerun the onboarding command."
  fi
  run_external_step "brew_install_${SHELL_VAR}{package}" "github.com/Homebrew" brew install "$package"
  refresh_installer_path
  if ! ensure_usable_command "$binary" "$binary" "${SHELL_VAR}{check_args[@]}"; then
    fail_step "brew_install_${SHELL_VAR}{package}" "github.com/Homebrew" "$binary is still unavailable after installing $package."
  fi
}

ensure_python3() {
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
    printf 'python3 already available; skipping install.\n'
    return 0
  fi

  ensure_homebrew
  if ! brew list python@3.13 >/dev/null 2>&1; then
    run_external_step "brew_install_python@3.13" "github.com/Homebrew" brew install python@3.13
  fi

  refresh_installer_path

  if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
    fail_step "brew_install_python@3.13" "github.com/Homebrew" "python3 >= 3.11 is still unavailable after installing python@3.13."
  fi
}

validate_desktop_download_url() {
  case "$CL_DESKTOP_DOWNLOAD_URL" in
    https://github.com/closedloop-ai/closedloop-electron/releases/download/*/*.dmg*)
      return 0
      ;;
    *)
      fail_step "desktop_download" "closedloop-electron release" "CL_DESKTOP_DOWNLOAD_URL must be an HTTPS ClosedLoop Desktop release asset."
      ;;
  esac
}

ensure_node_npm() {
  if ensure_usable_command npm npm --version; then
    return 0
  fi
  ensure_brew_package node npm --version
}

ensure_claude_cli() {
  if ensure_usable_command claude claude --version; then
    return 0
  fi
  ensure_node_npm
  run_external_step "claude_cli_install" "registry.npmjs.org" npm install -g @anthropic-ai/claude-code
  refresh_installer_path
  if ! ensure_usable_command claude claude --version; then
    fail_step "claude_cli_install" "registry.npmjs.org" "claude is still unavailable after installing @anthropic-ai/claude-code."
  fi
}

run_interactive_step() {
  local step="$1"
  local host="$2"
  shift 2
  if "$@"; then
    return 0
  fi
  fail_step "$step" "$host" "Command failed: $*"
}

ensure_gh_auth() {
  if gh auth status >/dev/null 2>&1; then
    printf 'gh is authenticated; continuing.\n'
    return 0
  fi

  printf 'GitHub CLI is installed but not authenticated.\n' >&2
  if [ "$NONINTERACTIVE" = "1" ] || { [ ! -t 0 ] && [ ! -t 1 ]; }; then
    fail_step "gh_auth" "github.com" "Run gh auth login, then rerun the onboarding command."
  fi

  printf 'Starting gh auth login so Desktop health checks can pass...\n'
  run_interactive_step "gh_auth" "github.com" gh auth login
}

ensure_closedloop_plugins() {
  local install_script=""
  install_script="$(mktemp -t closedloop-plugins-install.XXXXXX)"
  trap 'rm -f "$install_script"' EXIT
  # Use main intentionally so onboarding can receive plugin installer fixes
  # without requiring a web-app deploy.
  run_external_step "plugins_download" "raw.githubusercontent.com" curl -fsSL https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh -o "$install_script"
  run_external_step "plugins_install" "raw.githubusercontent.com" /bin/bash "$install_script"
  rm -f "$install_script"
  trap - EXIT
  verify_closedloop_plugins
}

verify_closedloop_plugins() {
  local registry="$HOME/.claude/plugins/installed_plugins.json"
  local missing_plugins=()

  for plugin in "${SHELL_VAR}{REQUIRED_CLOSEDLOOP_PLUGINS[@]}"; do
    local key="${SHELL_VAR}{plugin}@closedloop-ai"
    local found=0
    local install_path
    while IFS= read -r install_path; do
      if [ -n "$install_path" ] && [ -e "$install_path" ]; then
        found=1
        break
      fi
    done < <(jq -r --arg key "$key" '.plugins[$key][]?.installPath // empty' "$registry" 2>/dev/null || true)

    if [ "$found" -ne 1 ]; then
      missing_plugins+=("$key")
    fi
  done

  if [ "${SHELL_VAR}{#missing_plugins[@]}" -gt 0 ]; then
    fail_step "plugins_verify" "local" "Missing required ClosedLoop plugins after install: ${SHELL_VAR}{missing_plugins[*]}"
  fi
}

quit_running_desktop() {
  osascript -e "quit app id \"$BUNDLE_ID\"" >/dev/null 2>&1 || true

  local attempts=0
  while pgrep -x "$APP_NAME" >/dev/null 2>&1; do
    if [ "$attempts" -ge 10 ]; then
      fail_step "desktop_quit" "local" "ClosedLoop Desktop is still running. Quit it, then rerun the onboarding command."
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
}

verify_desktop_app_bundle() {
  local candidate_app="$1"
  if [ ! -d "$candidate_app/Contents" ] || [ ! -f "$candidate_app/Contents/Info.plist" ]; then
    fail_step "desktop_verify" "local_dmg" "Downloaded app bundle is missing Contents/Info.plist."
  fi

  local bundle_id
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$candidate_app/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$bundle_id" != "$BUNDLE_ID" ]; then
    fail_step "desktop_verify" "local_dmg" "Downloaded app bundle identifier is '$bundle_id', expected '$BUNDLE_ID'."
  fi

  if command -v codesign >/dev/null 2>&1 && ! codesign --verify --deep --strict "$candidate_app" >/dev/null 2>&1; then
    fail_step "desktop_verify" "local_dmg" "Downloaded app bundle signature verification failed."
  fi

  if command -v spctl >/dev/null 2>&1 && ! spctl --assess --type execute "$candidate_app" >/dev/null 2>&1; then
    fail_step "desktop_verify" "local_dmg" "Downloaded app bundle notarization assessment failed."
  fi
}

cleanup_desktop_install() {
  # This cleanup is shared by the normal path and the EXIT trap. Keep it
  # best-effort so an already-unmounted DMG or partially moved app does not hide
  # the original installation failure.
  if [ -n "$DESKTOP_INSTALL_MOUNT_ROOT" ] && [ -d "$DESKTOP_INSTALL_MOUNT_ROOT" ]; then
    hdiutil detach "$DESKTOP_INSTALL_MOUNT_ROOT" -quiet >/dev/null 2>&1 || true
    rmdir "$DESKTOP_INSTALL_MOUNT_ROOT" 2>/dev/null || true
  fi
  if [ -n "$DESKTOP_INSTALL_STAGING_ROOT" ] && [ -d "$DESKTOP_INSTALL_STAGING_ROOT" ]; then
    rm -rf "$DESKTOP_INSTALL_STAGING_ROOT"
  fi
  if [ -n "$DESKTOP_INSTALL_DMG_PATH" ]; then
    rm -f "$DESKTOP_INSTALL_DMG_PATH"
  fi
  if [ -n "$DESKTOP_INSTALL_BACKUP_APP" ] && [ -d "$DESKTOP_INSTALL_BACKUP_APP" ] && [ ! -e "$APP_PATH" ]; then
    mv "$DESKTOP_INSTALL_BACKUP_APP" "$APP_PATH" >/dev/null 2>&1 || true
  fi
  DESKTOP_INSTALL_DMG_PATH=""
  DESKTOP_INSTALL_MOUNT_ROOT=""
  DESKTOP_INSTALL_STAGING_ROOT=""
  DESKTOP_INSTALL_BACKUP_APP=""
}

install_desktop_app() {
  if [ -z "${SHELL_VAR}{CL_DESKTOP_DOWNLOAD_URL:-}" ]; then
    fail_step "desktop_download" "closedloop-electron release" "CL_DESKTOP_DOWNLOAD_URL is required."
  fi
  validate_desktop_download_url

  # Start from a clean cleanup state in case a caller invokes this helper more
  # than once in the same shell.
  DESKTOP_INSTALL_DMG_PATH=""
  DESKTOP_INSTALL_MOUNT_ROOT=""
  DESKTOP_INSTALL_STAGING_ROOT=""
  DESKTOP_INSTALL_BACKUP_APP=""
  local app_source="" staged_app=""
  trap cleanup_desktop_install EXIT

  DESKTOP_INSTALL_DMG_PATH="$(mktemp -t closedloop-desktop.XXXXXX).dmg"
  run_external_step "desktop_download" "$(printf '%s' "$CL_DESKTOP_DOWNLOAD_URL" | sed -E 's#^[a-z]+://([^/]+).*#\1#')" curl -fL "$CL_DESKTOP_DOWNLOAD_URL" -o "$DESKTOP_INSTALL_DMG_PATH"

  DESKTOP_INSTALL_MOUNT_ROOT="$(mktemp -d)"
  run_external_step "desktop_mount" "local_dmg" hdiutil attach "$DESKTOP_INSTALL_DMG_PATH" -mountpoint "$DESKTOP_INSTALL_MOUNT_ROOT" -nobrowse -quiet
  app_source="$(find "$DESKTOP_INSTALL_MOUNT_ROOT" -maxdepth 2 -name "${SHELL_VAR}{APP_NAME}.app" -type d | head -n 1)"
  if [ -z "$app_source" ]; then
    fail_step "desktop_install" "local_dmg" "ClosedLoop.app was not found in the downloaded DMG."
  fi

  DESKTOP_INSTALL_STAGING_ROOT="$(mktemp -d "/Applications/.closedloop-install.XXXXXX")"
  staged_app="$DESKTOP_INSTALL_STAGING_ROOT/${SHELL_VAR}{APP_NAME}.app"
  local copy_err_file
  copy_err_file="$(mktemp)"
  if ! cp -R "$app_source" "$staged_app" 2>"$copy_err_file"; then
    local message
    message="$(cat "$copy_err_file")"
    rm -f "$copy_err_file"
    fail_step "desktop_stage" "$DESKTOP_INSTALL_STAGING_ROOT" "$message"
  fi
  rm -f "$copy_err_file"
  verify_desktop_app_bundle "$staged_app"

  if [ -d "$APP_PATH" ]; then
    printf 'ClosedLoop Desktop already installed; replacing with the latest downloaded build.\n'
    DESKTOP_INSTALL_BACKUP_APP="/Applications/${SHELL_VAR}{APP_NAME}.app.previous.$$"
    if ! mv "$APP_PATH" "$DESKTOP_INSTALL_BACKUP_APP" 2>"$copy_err_file"; then
      local message
      message="$(cat "$copy_err_file")"
      rm -f "$copy_err_file"
      fail_step "desktop_install" "/Applications" "$message"
    fi
  fi

  if ! mv "$staged_app" "$APP_PATH" 2>"$copy_err_file"; then
    local message
    message="$(cat "$copy_err_file")"
    rm -f "$copy_err_file"
    if [ -n "$DESKTOP_INSTALL_BACKUP_APP" ] && [ -d "$DESKTOP_INSTALL_BACKUP_APP" ] && [ ! -e "$APP_PATH" ]; then
      mv "$DESKTOP_INSTALL_BACKUP_APP" "$APP_PATH" >/dev/null 2>&1 || true
    fi
    fail_step "desktop_install" "/Applications" "$message"
  fi
  rm -f "$copy_err_file"

  if [ -n "$DESKTOP_INSTALL_BACKUP_APP" ] && [ -d "$DESKTOP_INSTALL_BACKUP_APP" ]; then
    rm -rf "$DESKTOP_INSTALL_BACKUP_APP"
    DESKTOP_INSTALL_BACKUP_APP=""
  fi
  trap - EXIT
  cleanup_desktop_install
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

expand_user_path() {
  local input_path="$1"
  if [ "$input_path" = "~" ]; then
    printf '%s\n' "$HOME"
  elif [[ "$input_path" == "~/"* ]]; then
    printf '%s/%s\n' "$HOME" "${SHELL_VAR}{input_path#\~/}"
  else
    printf '%s\n' "$input_path"
  fi
}

strip_trailing_slashes() {
  local input_path="$1"
  while [ "$input_path" != "/" ] && [ "${SHELL_VAR}{input_path%/}" != "$input_path" ]; do
    input_path="${SHELL_VAR}{input_path%/}"
  done
  printf '%s\n' "$input_path"
}

ensure_workspace_directory() {
  if [ -z "${SHELL_VAR}{CL_SANDBOX_BASE_DIRECTORY:-}" ]; then
    fail_step "workspace_directory" "local" "Workspace directory is required for automated setup."
  fi
  reject_json_control_chars "CL_SANDBOX_BASE_DIRECTORY" "$CL_SANDBOX_BASE_DIRECTORY"

  local workspace_path probe_dir
  # Expand and resolve the workspace before persisting it. Desktop later treats
  # this value as the command sandbox, so the durable handoff must match the
  # directory that was actually created and write-tested here.
  workspace_path="$(strip_trailing_slashes "$(expand_user_path "$CL_SANDBOX_BASE_DIRECTORY")")"
  if [ -z "$workspace_path" ] || [ "$workspace_path" = "/" ] || [ "$workspace_path" = "$HOME" ]; then
    fail_step "workspace_directory" "local" "Choose a dedicated workspace directory under your home folder, not the root or home directory."
  fi

  if ! mkdir -p "$workspace_path"; then
    fail_step "workspace_directory" "local" "Could not create workspace directory: $workspace_path"
  fi
  if [ ! -d "$workspace_path" ]; then
    fail_step "workspace_directory" "local" "Workspace path is not a directory: $workspace_path"
  fi
  workspace_path="$(cd "$workspace_path" && pwd -P)" || fail_step "workspace_directory" "local" "Could not resolve workspace directory: $workspace_path"
  if [ -z "$workspace_path" ] || [ "$workspace_path" = "/" ] || [ "$workspace_path" = "$HOME" ]; then
    fail_step "workspace_directory" "local" "Choose a dedicated workspace directory under your home folder, not the root or home directory."
  fi

  probe_dir="$(mktemp -d "$workspace_path/.closedloop-write-test.XXXXXX" 2>/dev/null)" || fail_step "workspace_directory" "local" "Could not create a test directory inside workspace: $workspace_path"
  rmdir "$probe_dir" || fail_step "workspace_directory" "local" "Could not remove workspace test directory: $probe_dir"
  VALIDATED_SANDBOX_BASE_DIRECTORY="$workspace_path"
  printf 'Workspace directory is ready: %s\n' "$workspace_path"
}

write_handoff_file() {
  if [ -z "${SHELL_VAR}{CL_ONBOARDING_ATTEMPT_ID:-}" ] || [ -z "${SHELL_VAR}{CL_WEB_APP_ORIGIN:-}" ]; then
    fail_step "handoff_write" "local" "CL_ONBOARDING_ATTEMPT_ID and CL_WEB_APP_ORIGIN are required."
  fi
  reject_json_control_chars "CL_ONBOARDING_ATTEMPT_ID" "$CL_ONBOARDING_ATTEMPT_ID"
  reject_json_control_chars "CL_WEB_APP_ORIGIN" "$CL_WEB_APP_ORIGIN"

  local previous_umask handoff_tmp
  # The onboarding attempt ID is short-lived but credential-like, so write the
  # handoff with restrictive permissions and atomically move it into place only
  # after the JSON is complete.
  previous_umask="$(umask)"
  handoff_tmp=""
  cleanup_handoff_write() {
    if [ -n "$handoff_tmp" ]; then
      rm -f "$handoff_tmp"
    fi
    umask "$previous_umask"
  }
  trap cleanup_handoff_write EXIT
  umask 077
  if [ -L "$HANDOFF_DIR" ]; then
    fail_step "handoff_write" "local" "Handoff directory cannot be a symbolic link."
  fi
  mkdir -p "$HANDOFF_DIR"
  chmod 700 "$HANDOFF_DIR"

  local created_at attempt origin sandbox
  created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  attempt="$(json_escape "$CL_ONBOARDING_ATTEMPT_ID")"
  origin="$(json_escape "$CL_WEB_APP_ORIGIN")"
  handoff_tmp="$(mktemp "$HANDOFF_DIR/pending-onboarding.XXXXXX")"
  if [ -n "${SHELL_VAR}{VALIDATED_SANDBOX_BASE_DIRECTORY:-}" ]; then
    reject_json_control_chars "VALIDATED_SANDBOX_BASE_DIRECTORY" "$VALIDATED_SANDBOX_BASE_DIRECTORY"
    sandbox="$(json_escape "$VALIDATED_SANDBOX_BASE_DIRECTORY")"
    printf '{"onboardingAttemptId":"%s","webAppOrigin":"%s","sandboxBaseDirectory":"%s","createdAt":"%s"}\n' "$attempt" "$origin" "$sandbox" "$created_at" > "$handoff_tmp"
  else
    printf '{"onboardingAttemptId":"%s","webAppOrigin":"%s","createdAt":"%s"}\n' "$attempt" "$origin" "$created_at" > "$handoff_tmp"
  fi
  chmod 600 "$handoff_tmp"
  mv "$handoff_tmp" "$HANDOFF_FILE"
  handoff_tmp=""
  trap - EXIT
  cleanup_handoff_write
}

dispatch_handoff() {
  if open -a "$APP_PATH" "$HANDOFF_FILE"; then
    printf 'Opened ClosedLoop Desktop with the onboarding handoff.\n'
    return 0
  fi

  printf 'ClosedLoop Desktop was installed, but automatic file-open dispatch failed.\n' >&2
  printf 'Open ClosedLoop Desktop manually; it will resume onboarding from:\n%s\n' "$HANDOFF_FILE" >&2
  return 0
}

main() {
  seed_base_path
  ensure_supported_platform
  run_required_prerequisite "workspace_directory" "Workspace directory" ensure_workspace_directory
  run_required_prerequisite "git" "Git" ensure_brew_package git git --version
  run_required_prerequisite "gh" "GitHub CLI" ensure_brew_package gh gh --version
  if has_failed_prerequisite "gh"; then
    record_prerequisite_failure "gh_auth" "GitHub CLI authentication" "skipped because GitHub CLI is unavailable"
  else
    run_required_prerequisite "gh_auth" "GitHub CLI authentication" ensure_gh_auth
  fi
  run_required_prerequisite "python3" "Python 3" ensure_python3
  run_required_prerequisite "claude" "Claude Code CLI" ensure_claude_cli
  run_required_prerequisite "jq" "jq" ensure_brew_package jq jq --version
  if has_failed_prerequisite "python3" || has_failed_prerequisite "claude" || has_failed_prerequisite "jq"; then
    record_prerequisite_failure "closedloop_plugins" "ClosedLoop plugins" "skipped because Python 3, Claude Code CLI, or jq is unavailable"
  else
    run_required_prerequisite "closedloop_plugins" "ClosedLoop plugins" ensure_closedloop_plugins
  fi
  finish_required_prerequisites
  quit_running_desktop
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
