// Electron-free core for Session Mesh's always-on agent integration.
//
// The Mesh is deliberately independent from the Agent Monitor preference: it
// is a collaboration capability, not an analytics collector.  Claude invokes
// the copied handler only at its normal lifecycle boundaries; Codex uses its
// native hooks.json lifecycle. Neither path starts a daemon or
// overwrites a user-owned configuration entry.

import path from "node:path";
import type { AgentMonitorHooksWarning } from "../../shared/contracts.js";
import {
  type ApplyHooksInput,
  applyHookInstall,
  applyHookUninstall,
  readSettingsFile,
  writeSettingsFile,
} from "../agent-monitor/agent-monitor-hooks-core.js";
import {
  type CodexOtelConfigInput,
  installCodexOtelConfig,
} from "../telemetry/codex-otel-config-core.js";
import { SESSION_MESH_RUNTIME_MARKER } from "./session-mesh-runtime-marker.js";
import { SESSION_MESH_NATIVE_MESSAGING_TOOLS } from "./session-mesh-send-message-relevance.js";

export const SESSION_MESH_HANDLER_FILENAME = "session-mesh-hook-handler.js";

/** Claude lifecycle boundaries that identify useful Mesh coordination state. */
export const SESSION_MESH_CLAUDE_HOOK_TYPES = [
  "SessionStart",
  "PreToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
] as const;

function commandReferences(entry: unknown, filename: string): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const candidate = entry as {
    command?: unknown;
    hooks?: Array<{ command?: unknown }>;
  };
  const references = (value: unknown): boolean =>
    typeof value === "string" &&
    (value.includes(`/${filename}"`) ||
      value.includes(`/${filename}'`) ||
      value.includes(`/${filename} `) ||
      value.includes(`\\${filename}"`) ||
      value.includes(`\\${filename} `));
  return (
    references(candidate.command) ||
    (Array.isArray(candidate.hooks) &&
      candidate.hooks.some((hook) => references(hook.command)))
  );
}

/** Identity is the managed handler filename, never a mutable lane/slot alias. */
export function isSessionMeshClaudeEntry(entry: unknown): boolean {
  return commandReferences(entry, SESSION_MESH_HANDLER_FILENAME);
}

function removeObsoleteToolHooks(file: string): void {
  const settings = readSettingsFile(file);
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  const post = hooks?.PostToolUse;
  if (!(hooks && Array.isArray(post) && post.some(isSessionMeshClaudeEntry))) {
    return;
  }
  const retained = post.filter((entry) => !isSessionMeshClaudeEntry(entry));
  if (retained.length) {
    hooks.PostToolUse = retained;
  } else {
    settings.hooks = Object.fromEntries(
      Object.entries(hooks).filter(([key]) => key !== "PostToolUse")
    );
  }
  writeSettingsFile(file, settings);
}

/**
 * Pre-approve the native sibling-messaging tools in the user's own Claude
 * settings, alongside the hooks Desktop already installs there (ISS-11434).
 *
 * The repo-level `.claude/settings.json` entry only reaches a session started in
 * THIS checkout; the trigger this ticket adds is a Desktop capability, so the
 * approval has to land where Desktop writes. Additive and user-owned: an
 * existing `allow` entry is never reordered or dropped, a `permissions` of an
 * unexpected shape is left alone rather than overwritten, and nothing is removed
 * on uninstall, because a permission the user can see is theirs once granted.
 */
export function ensureSessionMeshToolPermissions(file: string): boolean {
  const settings = readSettingsFile(file);
  const permissions = settings.permissions;
  if (permissions !== undefined && typeof permissions !== "object") {
    return false;
  }
  const scope = (permissions ?? {}) as Record<string, unknown>;
  const allow = scope.allow;
  if (allow !== undefined && !Array.isArray(allow)) {
    return false;
  }
  const existing = (allow ?? []) as unknown[];
  const missing = SESSION_MESH_NATIVE_MESSAGING_TOOLS.filter(
    (tool) => !existing.includes(tool)
  );
  if (!missing.length) {
    return false;
  }
  settings.permissions = { ...scope, allow: [...existing, ...missing] };
  writeSettingsFile(file, settings);
  return true;
}

export function makeSessionMeshHookCommand(
  execPath: string,
  handler: string,
  hookType: string,
  harness: "claude" | "codex" = "claude"
): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const asyncContext = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "SubagentStart",
  ].includes(hookType);
  const invoke = `ELECTRON_RUN_AS_NODE=1 ${quote(execPath)} ${quote(handler)} ${JSON.stringify(hookType)} ${harness}${asyncContext ? " async" : ""}`;
  if (hookType === "MeshCommand") {
    return invoke;
  }
  const marker = quote(
    path.join(path.dirname(handler), SESSION_MESH_RUNTIME_MARKER)
  );
  // Both read and kill are shell builtins. A closed/crashed/signed-out Desktop
  // does not launch Node/Electron merely to discover there is no live listener.
  const inactive = ["Stop", "SubagentStop"].includes(hookType)
    ? " else printf '{}';"
    : "";
  return `if [ -r ${marker} ] && IFS= read -r mesh_runtime_pid < ${marker} && [ "$mesh_runtime_pid" -gt 1 ] 2>/dev/null && kill -0 "$mesh_runtime_pid" 2>/dev/null; then ${invoke};${inactive} fi`;
}

export function makeSessionMeshClaudeHookEntry(
  execPath: string,
  handler: string,
  hookType: string,
  harness: "claude" | "codex" = "claude"
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    hooks: [
      {
        type: "command",
        async: hookType !== "SessionEnd",
        timeout: [
          "SessionStart",
          "UserPromptSubmit",
          "PreToolUse",
          "SubagentStart",
        ].includes(hookType)
          ? 10
          : 1,
        command: makeSessionMeshHookCommand(
          execPath,
          handler,
          hookType,
          harness
        ),
      },
    ],
  };
  if (hookType === "PostToolUse" || hookType === "PreToolUse") {
    // `SendMessage` joins the edit tools because a session that decides to tell a
    // sibling something has already made the judgment a Mesh publish needs
    // (ISS-11434). Codex has no sibling-messaging tool, so its matcher is
    // unchanged rather than widened with a name that can never fire.
    entry.matcher =
      harness === "codex"
        ? "^(?:functions\\.)?apply_patch$"
        : "^(?:Edit|Write|MultiEdit|SendMessage)$";
  }
  return entry;
}

export type InstallSessionMeshHooksInput = Omit<
  ApplyHooksInput,
  "hookTypes" | "isOurEntry" | "makeEntry"
> & {
  execPath: string;
  handler: string;
  codexConfigFile: string;
  receiverState: CodexOtelConfigInput["receiverState"];
  codexFs?: CodexOtelConfigInput["fs"];
  codexNow?: CodexOtelConfigInput["now"];
  nativeAsyncSupport?: { claude: boolean; codex: boolean };
};

export type InstallSessionMeshHooksResult = {
  installed: number;
  repaired: number;
  warnings: AgentMonitorHooksWarning[];
};

/**
 * Reconcile native lifecycle hooks for both supported harnesses. Codex OTLP
 * remains an independent telemetry integration, never a context delivery path;
 * no helper process or user API key is written into either CLI config.
 */
export function installSessionMeshHooks(
  input: InstallSessionMeshHooksInput
): InstallSessionMeshHooksResult {
  let claude = { installed: 0, repaired: 0 };
  if (input.nativeAsyncSupport?.claude) {
    removeObsoleteToolHooks(input.file);
    ensureSessionMeshToolPermissions(input.file);
    claude = applyHookInstall({
      file: input.file,
      hookTypes: SESSION_MESH_CLAUDE_HOOK_TYPES,
      isOurEntry: isSessionMeshClaudeEntry,
      makeEntry: (hookType) =>
        makeSessionMeshClaudeHookEntry(input.execPath, input.handler, hookType),
    });
  } else {
    applyHookUninstall({
      file: input.file,
      isOurEntry: isSessionMeshClaudeEntry,
    });
  }
  const codex = installCodexOtelConfig({
    file: input.codexConfigFile,
    receiverState: input.receiverState,
    fs: input.codexFs,
    now: input.codexNow,
  });
  // Codex's native hooks.json is shared by its CLI and desktop app. OTEL is
  // telemetry only; model-visible context is returned by these command hooks.
  // Codex owns trust review of newly installed/changed hook definitions.
  const codexHooksFile = path.join(
    path.dirname(input.codexConfigFile),
    "hooks.json"
  );
  if (input.nativeAsyncSupport?.codex) {
    removeObsoleteToolHooks(codexHooksFile);
    applyHookInstall({
      file: codexHooksFile,
      hookTypes: SESSION_MESH_CLAUDE_HOOK_TYPES,
      isOurEntry: isSessionMeshClaudeEntry,
      makeEntry: (hookType) =>
        makeSessionMeshClaudeHookEntry(
          input.execPath,
          input.handler,
          hookType,
          "codex"
        ),
    });
  } else {
    applyHookUninstall({
      file: codexHooksFile,
      isOurEntry: isSessionMeshClaudeEntry,
    });
  }
  return { ...claude, warnings: codex.warnings ?? [] };
}
