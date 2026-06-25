#!/usr/bin/env node

/**
 * @file hook-handler.js
 * @description First-party Claude Code hook handler (FEA-1503). Replaces the
 * vendor-generated `hook-handler.js` — we now own and ship this script. Claude
 * Code invokes it once per lifecycle event (SessionStart, UserPromptSubmit,
 * PreToolUse, PostToolUse, Stop, SubagentStop, Notification, SessionEnd) with the
 * event name as the single argv arg and the event payload on stdin. It forwards
 * `{ hook_type, data }` to the in-process agent-monitor listener on the fixed
 * loopback port 4820.
 *
 * Zero-dependency, plain CommonJS, fail-silent: it runs via the Electron binary
 * as Node (ELECTRON_RUN_AS_NODE) from a userData copy, and must NEVER block or
 * fail a Claude turn. The port + path + payload envelope are a backward-compatible
 * contract baked into ~/.claude/settings.json (see FEA-1500); do not change them.
 */

const http = require("node:http");

const hookType = process.argv[2] || "unknown";
const port = Number.parseInt(process.env.CLAUDE_DASHBOARD_PORT || "4820", 10);

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let parsedData;
  try {
    parsedData = JSON.parse(input);
  } catch {
    parsedData = { raw: input };
  }

  const data =
    parsedData && typeof parsedData === "object" && !Array.isArray(parsedData)
      ? parsedData
      : { raw: parsedData };

  const payload = JSON.stringify({ hook_type: hookType, data });

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/api/hooks/event",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 3000,
    },
    (res) => {
      res.resume();
      process.exit(0);
    }
  );

  req.on("error", () => process.exit(0));
  req.on("timeout", () => {
    req.destroy();
    process.exit(0);
  });

  req.write(payload);
  req.end();
});

// Safety net — never let the handler linger longer than Claude's hook timeout.
setTimeout(() => process.exit(0), 5000);
