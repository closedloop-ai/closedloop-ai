import { existsSync, readFileSync } from "node:fs";

/** Read and parse JSON from a path; null if missing, empty, or invalid JSON. */
export function readJsonFileSync(filePath: string): unknown | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
