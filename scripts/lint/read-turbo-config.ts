import { readFileSync } from "node:fs";
import ts from "typescript6";

export function readTurboConfig<T>(path = "turbo.json"): T {
  const source = readFileSync(path, "utf8");
  const parsed = ts.parseConfigFileTextToJson(path, source);
  if (parsed.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")
    );
  }
  return parsed.config as T;
}
