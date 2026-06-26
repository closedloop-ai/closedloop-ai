import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const consoleCallPattern = /(?<![\w$.])console\.([A-Za-z_$][\w$]*)/g;
const gatewayLoggerPath = path.normalize("src/main/gateway-logger.ts");
const allowedGatewayLoggerConsoleMembers = new Set(["error", "warn", "log"]);

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

function findConsoleMatches() {
  const sourceFiles = [
    ...collectSourceFiles(path.resolve("src/main")),
    ...collectSourceFiles(path.resolve("src/server")),
  ];
  const matches: string[] = [];

  for (const filePath of sourceFiles) {
    const relativePath = path.relative(process.cwd(), filePath);
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(consoleCallPattern)) {
        const member = match[1];
        if (
          relativePath === gatewayLoggerPath &&
          allowedGatewayLoggerConsoleMembers.has(member)
        ) {
          continue;
        }
        matches.push(`${relativePath}:${index + 1}:console.${member}`);
      }
    });
  }

  return matches;
}

describe("production console transport guard", () => {
  test("main/server console output is limited to GatewayLogger transport", () => {
    const matches = findConsoleMatches();

    assert.deepEqual(matches, []);
  });
});
