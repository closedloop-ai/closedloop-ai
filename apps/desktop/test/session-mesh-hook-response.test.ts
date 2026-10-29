import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

async function invoke(hookType: string, body: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mesh-response-"));
  const handler = path.join(directory, "hook.cjs");
  copyFileSync(
    path.resolve("resources/hooks/session-mesh-hook-handler.js"),
    handler
  );
  writeFileSync(path.join(directory, "local-token"), "a".repeat(64));
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    // Multiple chunks reproduce the former prefix-only accumulation failure.
    const bytes = Buffer.from(body);
    for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
      response.write(bytes.subarray(offset, offset + 32 * 1024));
    }
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await new Promise<{ code: number | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [handler, hookType, "codex"], {
          env: {
            ...process.env,
            CLAUDE_DASHBOARD_PORT: String(
              (server.address() as AddressInfo).port
            ),
          },
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout }));
        child.stdin.end(
          JSON.stringify({
            session_id: "native-id",
            operation: "context",
            agentId: "codex:native-id",
          })
        );
      }
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

it("returns a complete actual-handler command response above 64 KiB", async () => {
  const result = {
    ok: true,
    commandResult: {
      evidence: "x".repeat(480 * 1024),
      nextInboxCursor: "continuation",
    },
  };
  const output = await invoke("MeshCommand", JSON.stringify(result));
  expect(output.code).toBe(0);
  expect(JSON.parse(output.stdout)).toEqual(result);
});

it("rejects oversized actual-handler responses by bytes without printing partial JSON", async () => {
  const body = JSON.stringify({
    ok: true,
    commandResult: { evidence: "é".repeat(600 * 1024) },
  });
  expect(body.length).toBeLessThan(1024 * 1024);
  expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);
  const output = await invoke("MeshCommand", body);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toEqual({
    ok: false,
    error: "Desktop Mesh response exceeds 1 MiB limit",
  });
});

it("fails open for an oversized lifecycle response without injecting its prefix", async () => {
  const output = await invoke(
    "SessionStart",
    JSON.stringify({ ok: true, additionalContext: "x".repeat(1024 * 1024 + 1) })
  );
  expect(output).toEqual({ code: 0, stdout: "" });
});
