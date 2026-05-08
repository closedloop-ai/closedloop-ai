import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLOSEDLOOP_DIR = join(homedir(), ".closedloop-ai");
const SESSIONS_FILE = join(CLOSEDLOOP_DIR, "sessions.json");
const LEGACY_SESSIONS_FILE = join(homedir(), ".symphony", "sessions.json");

/**
 * Migrate sessions.json from legacy ~/.symphony to ~/.closedloop-ai.
 * Copies the file then deletes the legacy copy (leaves directory intact).
 */
export function migrateLegacySessions(): void {
  if (!existsSync(LEGACY_SESSIONS_FILE)) {
    return;
  }
  if (existsSync(SESSIONS_FILE)) {
    // New path already exists — just clean up legacy
    try {
      unlinkSync(LEGACY_SESSIONS_FILE);
    } catch {
      // Best-effort cleanup
    }
    return;
  }
  try {
    mkdirSync(CLOSEDLOOP_DIR, { recursive: true });
    const content = readFileSync(LEGACY_SESSIONS_FILE, "utf-8");
    writeFileSync(SESSIONS_FILE, content);
  } catch {
    return;
  }
  try {
    unlinkSync(LEGACY_SESSIONS_FILE);
  } catch {
    // Best-effort cleanup
  }
}
