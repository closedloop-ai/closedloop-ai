import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("fixtures/print-markdown-document.ts", import.meta.url)
);
const SPAWN_TIMEOUT_MS = 30_000;

type ChildResult = { code: number | null; stdout: string; stderr: string };

/**
 * The loader doc-sync runs under (`node --import tsx`), resolving the package
 * by name through its `exports`. Vitest's own resolver cannot prove this path.
 */
function runFixture(markdown: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", FIXTURE, markdown],
      { cwd: PACKAGE_ROOT, timeout: SPAWN_TIMEOUT_MS }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("@repo/document-schema under plain Node ESM", () => {
  it(
    "parses markdown into a mermaid node through node --import tsx",
    async () => {
      const result = await runFixture("```mermaid\ngraph TD; A-->B\n```");

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).content[0]).toEqual({
        type: "mermaid",
        attrs: { content: "graph TD; A-->B" },
      });
    },
    SPAWN_TIMEOUT_MS + 5000
  );
});
