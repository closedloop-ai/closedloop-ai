/**
 * @file collectors-hook-handler.test.ts
 * @description Validates the first-party Claude hook handler: it POSTs the
 * `{ hook_type, data }` envelope to the in-process listener on the configured
 * port, using the Claude route and without sending provider hints in data.
 *
 * In production the handler runs from a userData COPY (outside the desktop's
 * `type:module` package, so its `require()` resolves as CommonJS). The test
 * mirrors that by copying the shipped script into a package.json-free temp dir
 * before spawning it via the Node binary.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.join(__dirname, "..", "resources", "hooks");

type HookEnvelope = {
  hook_type: string;
  data: Record<string, unknown>;
};

type CapturedHook = {
  path: string;
  envelope: HookEnvelope;
};

/** Copy the shipped handler to a CJS-safe temp dir, run it, capture the POST. */
function runHandler(
  script: string,
  hookType: string,
  stdinPayload: string
): Promise<CapturedHook> {
  return new Promise((resolve, reject) => {
    const dir = makeTempDir("hook-handler-");
    const handlerCopy = path.join(dir, script);
    copyFileSync(path.join(HOOKS_DIR, script), handlerCopy);

    let settled = false;
    // Settle exactly once, closing the server first to free the port.
    function finish(done: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      server.close(done);
    }

    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/hooks/event") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          let captured: CapturedHook | null = null;
          try {
            captured = {
              path: req.url ?? "",
              envelope: JSON.parse(body) as HookEnvelope,
            };
          } catch {
            captured = null;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          // The handler only exits from inside its HTTP response callback, so
          // capturing the POST here is strictly ordered before child exit —
          // settle now rather than waiting a fixed grace period after exit.
          if (captured) {
            const hook = captured;
            finish(() => resolve(hook));
          } else {
            finish(() =>
              reject(new Error("handler POSTed an unparseable body"))
            );
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const child = spawn(process.execPath, [handlerCopy, hookType], {
        env: { ...process.env, CLAUDE_DASHBOARD_PORT: String(port) },
      });
      child.stdin.write(stdinPayload);
      child.stdin.end();
      child.on("error", (err) => finish(() => reject(err)));
      // Reached only on the failure path: the handler exited (error/timeout)
      // without a successful POST. The happy path already settled above.
      child.on("exit", () =>
        finish(() => reject(new Error("handler did not POST a hook event")))
      );
    });
  });
}

test("Claude hook-handler.js forwards { hook_type, data } unchanged (no __provider)", async () => {
  const captured = await runHandler(
    "hook-handler.js",
    "SessionStart",
    JSON.stringify({ session_id: "abc-123", cwd: "/Users/dev/proj" })
  );
  const { envelope } = captured;
  assert.equal(captured.path, "/api/hooks/event");
  assert.equal(envelope.hook_type, "SessionStart");
  assert.equal(envelope.data.session_id, "abc-123");
  assert.equal(envelope.data.cwd, "/Users/dev/proj");
  assert.equal(envelope.data.__provider, undefined);
});

test("hook handler tolerates non-JSON stdin without crashing", async () => {
  const { envelope } = await runHandler(
    "hook-handler.js",
    "Stop",
    "not json at all"
  );
  assert.equal(envelope.hook_type, "Stop");
  assert.equal(envelope.data.raw, "not json at all");
});
