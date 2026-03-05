import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Migrate a legacy chat history file to a new location.
 * Copies the file then deletes the legacy copy (leaves directory intact).
 */
export function migrateLegacyChatHistory(
  legacyPath: string,
  newPath: string
): void {
  if (!existsSync(legacyPath)) {
    return;
  }
  if (existsSync(newPath)) {
    // New path already exists — just clean up legacy
    try {
      unlinkSync(legacyPath);
    } catch {
      // Best-effort cleanup
    }
    return;
  }
  try {
    const dir = join(newPath, "..");
    mkdirSync(dir, { recursive: true });
    const content = readFileSync(legacyPath, "utf-8");
    writeFileSync(newPath, content);
  } catch {
    return;
  }
  try {
    unlinkSync(legacyPath);
  } catch {
    // Best-effort cleanup
  }
}
