import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function loadJsonFile<T>(
  filePath: string,
  fallback: T
): Promise<T> {
  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

export async function saveJsonFile(
  filePath: string,
  payload: unknown
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
}
