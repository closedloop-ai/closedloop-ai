import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveResourcesDir(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, "..", "..", "resources");
}
