#!/usr/bin/env node
// Native async lifecycle adapter, not a daemon. Older callers retain the short
// local-cache-only path; only verified async installations pass the async arg.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const hookType = process.argv[2] || "unknown";
const harness = process.argv[3] === "codex" ? "codex" : "claude";
const isCommand = hookType === "MeshCommand";
const asyncContext =
  process.argv[4] === "async" &&
  ["SessionStart", "UserPromptSubmit", "PreToolUse", "SubagentStart"].includes(
    hookType
  );
const port = Number.parseInt(process.env.CLAUDE_DASHBOARD_PORT || "4820", 10);
function failOpen(reason) {
  if (isCommand) {
    process.stdout.write(JSON.stringify({ ok: false, error: reason }), () =>
      process.exit(1)
    );
  } else if (hookType === "Stop" || hookType === "SubagentStop") {
    process.stdout.write("{}", () => process.exit(0));
  } else {
    process.exit(0);
  }
}
let token;
try {
  token = fs
    .readFileSync(
      path.join(path.dirname(process.argv[1]), "local-token"),
      "utf8"
    )
    .trim();
} catch {
  failOpen("Desktop Mesh is unavailable: no local installation token");
}
function post(event, data, timeout, complete) {
  const payload = JSON.stringify({ harness, hook_type: event, data });
  let settled = false;
  const abort = (reason) => {
    if (!settled) {
      settled = true;
      failOpen(reason);
    }
  };
  const request = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path:
        harness === "codex"
          ? "/api/session-mesh/codex-hook"
          : "/api/session-mesh/hook",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-session-mesh-token": token,
      },
      timeout,
    },
    (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        if (settled) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        // Runtime cloud reads are bounded at 512 KiB. Allow their local JSON
        // envelope without truncating a valid command result mid-document.
        if (bytes > 1024 * 1024) {
          abort("Desktop Mesh response exceeds 1 MiB limit");
          response.destroy();
          return;
        }
        chunks.push(buffer);
      });
      response.on("error", () => abort("Desktop Mesh response interrupted"));
      response.on("end", () => {
        if (settled) {
          return;
        }
        let result;
        try {
          result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          abort("Invalid Desktop response");
          return;
        }
        settled = true;
        complete(result);
      });
    }
  );
  request.on("error", () => abort("Desktop Mesh listener is unavailable"));
  request.on("timeout", () => {
    abort("Desktop Mesh listener timed out");
    request.destroy();
  });
  request.end(payload);
}
function deliver(result) {
  if (isCommand) {
    if (!(result.ok && Object.hasOwn(result, "commandResult"))) {
      failOpen(
        "Desktop could not complete the Mesh command; verify the session is registered and the app is signed in"
      );
      return;
    }
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
    return;
  }
  if (!(result.ok && result.additionalContext)) {
    failOpen("No native context available");
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookType,
        additionalContext: result.additionalContext,
      },
    }),
    () => {
      if (!result.receipt) {
        process.exit(0);
        return;
      }
      // Delivery only, never recipient acknowledgement; stdout must flush first.
      post("ContextDelivered", { receipt: result.receipt }, 50, () =>
        process.exit(0)
      );
    }
  );
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (input.length + chunk.length > 8 * 1024 * 1024) {
    failOpen("Hook input too large");
    return;
  }
  input += chunk;
});
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    failOpen("Invalid hook input");
    return;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    failOpen("Invalid hook input");
    return;
  }
  post(hookType, data, isCommand ? 5000 : 100, (result) => {
    if (
      asyncContext &&
      result.ok &&
      !result.additionalContext &&
      result.awaitContext !== false
    ) {
      post(
        "AwaitContext",
        {
          session_id: data.session_id,
          ...(typeof data.agent_id === "string"
            ? { agent_id: data.agent_id }
            : {}),
        },
        5500,
        deliver
      );
    } else {
      deliver(result);
    }
  });
});
const deadline = asyncContext ? 6500 : 150;
setTimeout(
  () => failOpen("Desktop Mesh hook deadline reached"),
  isCommand ? 5500 : deadline
).unref();
