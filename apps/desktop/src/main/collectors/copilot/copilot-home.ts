/**
 * @file copilot-home.ts
 * @description Centralized GitHub Copilot session path management. Resolves
 * paths for:
 *
 * 1. Copilot Chat (VS Code extension): JSON session files under
 *    ~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/
 *
 * 2. Copilot CLI (`gh copilot`): JSONL event logs under
 *    ~/.copilot/session-state/<session-id>/events.jsonl
 *
 * Both locations are scanned opportunistically — if neither exists the tool
 * is simply not installed or hasn't been used.
 *
 * Ported from `scripts/agent-monitor-copilot/copilot-home.js` (logic preserved).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function getCopilotCliHome(): string {
  const raw = process.env.COPILOT_HOME;
  if (raw?.trim()) {
    return raw.trim().replace(/^~(?=\/)/, os.homedir());
  }
  return path.join(os.homedir(), ".copilot");
}

export function getCopilotCliSessionStateDir(): string {
  return path.join(getCopilotCliHome(), "session-state");
}

/**
 * VS Code workspace storage root. Platform-dependent.
 */
export function getVscodeWorkspaceStorageDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(
        home,
        "Library",
        "Application Support",
        "Code",
        "User",
        "workspaceStorage"
      );
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(home, "AppData", "Roaming"),
        "Code",
        "User",
        "workspaceStorage"
      );
    default: // linux
      return path.join(home, ".config", "Code", "User", "workspaceStorage");
  }
}

export function workspacePathFromUri(folder: unknown): string | null {
  if (typeof folder !== "string" || folder.length === 0) {
    return null;
  }
  if (!folder.startsWith("file:")) {
    return folder;
  }
  try {
    return fileURLToPath(folder);
  } catch {
    try {
      return decodeURIComponent(folder.replace(/^file:\/\//, ""));
    } catch {
      return folder.replace(/^file:\/\//, "");
    }
  }
}

export function readWorkspacePathFromHashDir(hashPath: string): string | null {
  try {
    const wsJson = JSON.parse(
      fs.readFileSync(path.join(hashPath, "workspace.json"), "utf8")
    ) as Record<string, unknown>;
    return workspacePathFromUri(wsJson.folder || wsJson.workspace || "");
  } catch {
    return null;
  }
}

/**
 * Discover all chatSession JSON files across all VS Code workspaces.
 * Returns array of { filePath, workspacePath } where workspacePath is resolved
 * from the workspace.json in the hash directory.
 */
export function listChatSessionFiles(): {
  filePath: string;
  workspacePath: string | null;
}[] {
  const wsRoot = getVscodeWorkspaceStorageDir();
  if (!fs.existsSync(wsRoot)) {
    return [];
  }
  const results: { filePath: string; workspacePath: string | null }[] = [];

  let hashDirs: fs.Dirent[];
  try {
    hashDirs = fs.readdirSync(wsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory()) {
      continue;
    }
    const hashPath = path.join(wsRoot, hashDir.name);
    const chatDir = path.join(hashPath, "chatSessions");
    if (!fs.existsSync(chatDir)) {
      continue;
    }

    const workspacePath = readWorkspacePathFromHashDir(hashPath);

    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(chatDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith(".json")) {
        results.push({
          filePath: path.join(chatDir, f.name),
          workspacePath,
        });
      }
    }
  }
  return results;
}

/**
 * Collect all Copilot CLI event JSONL files under ~/.copilot/session-state/.
 */
export function listCliEventFiles(): { filePath: string; sessionId: string }[] {
  const root = getCopilotCliSessionStateDir();
  if (!fs.existsSync(root)) {
    return [];
  }
  const results: { filePath: string; sessionId: string }[] = [];

  let sessionDirs: fs.Dirent[];
  try {
    sessionDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dir of sessionDirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    const eventsFile = path.join(root, dir.name, "events.jsonl");
    if (fs.existsSync(eventsFile)) {
      results.push({ filePath: eventsFile, sessionId: dir.name });
    }
  }
  return results;
}
