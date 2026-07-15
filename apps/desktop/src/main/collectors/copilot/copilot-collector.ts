/**
 * @file copilot-collector.ts
 * @description GitHub Copilot harness collector (FEA-1503). Copilot has TWO
 * sources that both normalize to the same session shape:
 *
 * 1. Copilot Chat — VS Code extension JSON files under each workspace's
 *    `chatSessions/` directory (parsed synchronously).
 * 2. Copilot CLI — `events.jsonl` event logs under `~/.copilot/session-state/`
 *    (parsed asynchronously, line by line).
 *
 * `parse(filePath)` dispatches by source: it builds lookup maps from the
 * current `listChatSessionFiles()` / `listCliEventFiles()` listings to resolve
 * the chat `workspacePath` or the cli `sessionId` for the given path. If the
 * path is absent from the listings (e.g. a watcher fires before the next
 * enumeration), it re-derives the context directly from the path so a fresh
 * file still imports.
 */
import path from "node:path";
import type { FileHarnessCollector, NormalizedSession } from "../types.js";
import {
  getCopilotCliSessionStateDir,
  getVscodeWorkspaceStorageDir,
  listChatSessionFiles,
  listCliEventFiles,
  readWorkspacePathFromHashDir,
} from "./copilot-home.js";
import {
  parseChatSessionFileGated,
  parseCliEventFile,
} from "./copilot-parser.js";

/**
 * Re-derive a chat session's workspacePath from its file path when the file is
 * not present in the current listing. Chat files live at
 * `<workspaceStorage>/<hash>/chatSessions/<file>.json`, so the hash dir (two
 * levels up) holds the `workspace.json` we read.
 */
function workspacePathFromChatFilePath(filePath: string): string | null {
  const chatDir = path.dirname(filePath);
  const hashPath = path.dirname(chatDir);
  return readWorkspacePathFromHashDir(hashPath);
}

/**
 * Re-derive a CLI session id from its file path. CLI event files live at
 * `<session-state>/<session-id>/events.jsonl`, so the parent directory name is
 * the session id.
 */
function sessionIdFromCliFilePath(filePath: string): string {
  return path.basename(path.dirname(filePath));
}

export function createCopilotCollector(): FileHarnessCollector {
  return {
    key: "copilot",
    cacheName: "copilot",

    watchRoots(): string[] {
      return [
        getVscodeWorkspaceStorageDir(),
        getCopilotCliSessionStateDir(),
      ].filter((root) => root.length > 0);
    },

    watchMatch(filename: string): boolean {
      return filename.endsWith(".json") || filename.endsWith(".jsonl");
    },

    listSources(): string[] {
      const chat = listChatSessionFiles().map((f) => f.filePath);
      const cli = listCliEventFiles().map((f) => f.filePath);
      return [...chat, ...cli];
    },

    async parse(filePath: string): Promise<NormalizedSession[]> {
      // Resolve chat workspacePath / cli sessionId from the current listings.
      const chatFiles = listChatSessionFiles();
      const cliFiles = listCliEventFiles();

      const chatMatch = chatFiles.find((f) => f.filePath === filePath);
      if (chatMatch) {
        const session = await parseChatSessionFileGated(
          filePath,
          chatMatch.workspacePath
        );
        return session ? [session] : [];
      }

      const cliMatch = cliFiles.find((f) => f.filePath === filePath);
      if (cliMatch) {
        const session = await parseCliEventFile(filePath, cliMatch.sessionId);
        return session ? [session] : [];
      }

      // Not in the listings — re-derive context from the path shape so a
      // newly-written file still imports.
      if (filePath.endsWith(".json")) {
        const workspacePath = workspacePathFromChatFilePath(filePath);
        const session = await parseChatSessionFileGated(
          filePath,
          workspacePath
        );
        return session ? [session] : [];
      }
      if (filePath.endsWith(".jsonl")) {
        const sessionId = sessionIdFromCliFilePath(filePath);
        const session = await parseCliEventFile(filePath, sessionId);
        return session ? [session] : [];
      }

      return [];
    },
    sessionIdForSource(source: string): string | null {
      // CLI event files (.jsonl): session id is path-derivable (parent dir name).
      if (source.endsWith(".jsonl")) {
        return `copilot-cli-${sessionIdFromCliFilePath(source)}`;
      }
      // Chat session files (.json): stored id is content-derived
      // (copilot-chat-${json.sessionId}), not deterministic from the path alone.
      return null;
    },
  };
}
